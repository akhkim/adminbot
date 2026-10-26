// Attendance from the Zoom web dashboard's meeting export, for backfilling.
//
// Two different Zoom exports carry participants. The one attendance.ts reads is the per-meeting
// participant report a host drops in the watched folder, one file per meeting. This one is the
// dashboard's "meeting list with details" (`meetinglistdetails_<from>_<to>.csv`): a month of
// meetings in one file, one row per participant session, with the meeting's own columns repeated
// on every row. It is what a host can pull for months at a time, so it is what a backfill reads.
//
// The shape has two traps. The meeting columns and the participant columns share a name --
// "Duration (minutes)" appears once for the meeting and once for the person -- so columns are told
// apart by which side of the participant name column they sit. And a meeting is identified by its
// id *and* start time together: a recurring meeting reuses one id every week, and every stray
// one-person opening of the room is its own meeting in the export.
import type {
  AdminBotLabMember,
  AdminBotMeetingAttendee,
  AdminBotMeetingRecord,
  AdminBotMeetingRecordInput,
} from "../../contracts/actions.js";
import { toAbsoluteRfc3339 } from "../calendar/time.js";
import {
  attendanceFromParticipants,
  normalizeName,
  parseCsv,
  type ZoomParticipantRow,
} from "./attendance.js";
import { meetingDurationSeconds, meetingSeriesKey } from "./records.js";

export type ZoomDashboardMeeting = {
  /** Digits only, as the notice parser stores it. */
  zoomMeetingId: string;
  topic: string;
  /** RFC3339, UTC. */
  startedAt: string;
  durationMinutes: number;
  participants: ZoomParticipantRow[];
};

/**
 * Zoom display names to member ids, keyed by `normalizeName` of the display name. `null` drops the
 * name: a meeting room's account, or a person deliberately left off the roster.
 */
export type ZoomNameAliases = ReadonlyMap<string, string | null>;

// Bots that join to transcribe. They are not people, and counting them would mark a meeting
// "attended" by whoever's notetaker it was.
const NOTETAKER = /notetaker|otter\.ai|fireflies|read\.ai|'s assistant$/iu;

const PARTICIPANT_NAME = /^name(?:\s*\(original name\))?$/iu;
const DURATION = /^duration\s*\(minutes\)$/iu;
// "08/24/2026 09:25:32 AM", in the time zone of the account that exported it.
const DASHBOARD_TIME = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/u;

/** A dashboard time stamp as an RFC3339 instant, or undefined when it is not one. */
export function dashboardTimeToRfc3339(value: string, timeZone: string): string | undefined {
  const match = DASHBOARD_TIME.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const [, month, day, year, hour12, minute, second, meridiem] = match;
  const hour = (Number(hour12) % 12) + (meridiem === "PM" ? 12 : 0);
  return toAbsoluteRfc3339(
    `${year}-${month}-${day}T${String(hour).padStart(2, "0")}:${minute}:${second}`,
    timeZone,
  );
}

/**
 * Every meeting in one dashboard export, oldest first. Empty when the file is not this export.
 *
 * `timeZone` is the exporting account's: the file states local times and no zone.
 */
export function parseZoomDashboardCsv(source: string, timeZone: string): ZoomDashboardMeeting[] {
  const rows = parseCsv(source.replace(/^﻿/u, ""));
  const header = (rows[0] ?? []).map((cell) => cell.trim());
  const nameAt = header.findIndex((cell) => PARTICIPANT_NAME.test(cell));
  const meetingColumn = (label: string) =>
    header.findIndex((cell, index) => index < nameAt && cell.toLowerCase() === label);
  const participantColumn = (pattern: RegExp) =>
    header.findIndex((cell, index) => index > nameAt && pattern.test(cell));
  const topicAt = meetingColumn("topic");
  const idAt = meetingColumn("id");
  const startAt = meetingColumn("start time");
  const meetingDurationAt = header.findIndex(
    (cell, index) => index < nameAt && DURATION.test(cell),
  );
  const emailAt = participantColumn(/^e-?mail$/iu);
  const joinAt = participantColumn(/^join\s*time$/iu);
  const durationAt = participantColumn(DURATION);
  if ([nameAt, topicAt, idAt, startAt, meetingDurationAt, durationAt].some((at) => at < 0)) {
    return [];
  }
  const meetings = new Map<string, ZoomDashboardMeeting>();
  for (const row of rows.slice(1)) {
    const zoomMeetingId = row[idAt]?.replace(/\D/gu, "") ?? "";
    const startedAt = dashboardTimeToRfc3339(row[startAt] ?? "", timeZone);
    const name = row[nameAt]?.trim();
    if (!zoomMeetingId || !startedAt || !name) {
      continue;
    }
    const key = `${zoomMeetingId}|${startedAt}`;
    const meeting = meetings.get(key) ?? {
      zoomMeetingId,
      topic: row[topicAt]?.trim() ?? "",
      startedAt,
      durationMinutes: Number(row[meetingDurationAt]) || 0,
      participants: [],
    };
    const email = row[emailAt]?.trim().toLowerCase();
    const joinedAt = dashboardTimeToRfc3339(row[joinAt] ?? "", timeZone);
    const minutes = Number(row[durationAt]);
    meeting.participants.push({
      name,
      ...(email ? { email } : {}),
      ...(joinedAt ? { joinedAt } : {}),
      ...(Number.isFinite(minutes) ? { minutes } : {}),
    });
    meetings.set(key, meeting);
  }
  return [...meetings.values()].toSorted((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** People in the meeting: rejoins counted once, by address when Zoom has one and name otherwise. */
export function uniqueParticipantCount(meeting: ZoomDashboardMeeting): number {
  return new Set(meeting.participants.map((row) => row.email ?? normalizeName(row.name))).size;
}

/** The record id a recording notice for the same meeting would get (`meetingRecordId`). */
export function dashboardMeetingRecordId(meeting: ZoomDashboardMeeting): string {
  return `zoom-${meeting.zoomMeetingId}-${meeting.startedAt.slice(0, 10)}`;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The record a recording notice already filed for this meeting, when there is one.
 *
 * A notice whose date line did not parse is filed at the time the mail arrived, under a hash of
 * its share link, so neither the id nor the start time finds it. What does is the recording
 * length: same series, filed within a day and a half after the meeting began, and a recording no
 * longer than the meeting and within five minutes or a tenth of it. Two recordings of the room on
 * one morning -- a ten-second test and the meeting itself -- are told apart that way, where
 * "the next notice to arrive" picks the wrong one as often as not. `claimed` keeps two meetings
 * from landing on one record.
 */
export function matchRecordedMeeting(
  meeting: ZoomDashboardMeeting,
  records: readonly AdminBotMeetingRecord[],
  claimed: ReadonlySet<string> = new Set(),
): AdminBotMeetingRecord | undefined {
  const series = meetingSeriesKey(meeting.topic);
  const start = Date.parse(meeting.startedAt);
  const length = meeting.durationMinutes * 60;
  const tolerance = Math.max(5 * 60, length / 10);
  let best: { record: AdminBotMeetingRecord; gap: number } | undefined;
  for (const record of records) {
    if (claimed.has(record.id) || meetingSeriesKey(record.topic) !== series) {
      continue;
    }
    const filed = Date.parse(record.started_at);
    if (!(filed >= start - HOUR_MS && filed <= start + 36 * HOUR_MS)) {
      continue;
    }
    const seconds = meetingDurationSeconds(record);
    if (seconds === undefined || seconds > length + tolerance || length - seconds > tolerance) {
      continue;
    }
    const gap = Math.abs(length - seconds);
    if (!best || gap < best.gap) {
      best = { record, gap };
    }
  }
  return best?.record;
}

export type DashboardAttendance = {
  attendees: AdminBotMeetingAttendee[];
  /** Display names left out: notetakers and names aliased to null. */
  dropped: string[];
};

/**
 * A meeting's participants as attendance, with aliases applied first.
 *
 * An alias is applied by giving the row the member's address, so the ordinary matcher resolves it
 * by email exactly as it would a participant Zoom had signed in -- one matching rule, not two.
 */
export function attendanceFromDashboard(
  meeting: ZoomDashboardMeeting,
  members: readonly AdminBotLabMember[],
  aliases: ZoomNameAliases = new Map(),
): DashboardAttendance {
  const dropped: string[] = [];
  const rows: ZoomParticipantRow[] = [];
  for (const row of meeting.participants) {
    const alias = aliases.get(normalizeName(row.name));
    if (NOTETAKER.test(row.name) || alias === null) {
      dropped.push(row.name);
      continue;
    }
    if (alias === undefined) {
      rows.push(row);
      continue;
    }
    const member = members.find((candidate) => candidate.id === alias);
    const email = member?.email ?? member?.calendar_email;
    if (!member || !email) {
      throw new Error(`alias for "${row.name}" names ${alias}, which is no member with an email`);
    }
    rows.push({ ...row, email: email.toLowerCase() });
  }
  return { attendees: attendanceFromParticipants(rows, members), dropped: [...new Set(dropped)] };
}

/**
 * The upsert that files a meeting's attendance, onto `existing` when a notice already filed it.
 *
 * Start time and length come from the report either way: it is Zoom's own account of the meeting,
 * where a notice-filed record may carry the time the mail arrived. The link, topic and source of an
 * existing record are left as they are -- an empty `recording` merges onto the stored one.
 */
export function dashboardMeetingUpdate(
  meeting: ZoomDashboardMeeting,
  attendees: AdminBotMeetingAttendee[],
  existing?: AdminBotMeetingRecord,
): AdminBotMeetingRecordInput {
  return {
    id: existing?.id ?? dashboardMeetingRecordId(meeting),
    topic: existing?.topic ?? meeting.topic,
    started_at: meeting.startedAt,
    duration_minutes: meeting.durationMinutes,
    recording: {},
    attendees,
    source: existing?.source ?? "participant_report",
  };
}

/** Members a guest's display name could plausibly be, for a person writing the alias file. */
export function aliasCandidates(
  displayName: string,
  members: readonly AdminBotLabMember[],
): AdminBotLabMember[] {
  const tokens = normalizeName(displayName).split(" ").filter(Boolean);
  const [first] = tokens;
  if (!first) {
    return [];
  }
  const withoutInitial = tokens.slice(1).join(" ");
  return members.filter((member) => {
    // A member with no preferred name would contribute "", which every prefix test passes.
    const names = [member.name, member.preferred_name ?? ""].map(normalizeName).filter(Boolean);
    return names.some((name) => {
      const parts = name.split(" ");
      // "andrew k" -> "andrew kim", "zhijing" -> "zhijing jin", "x angelo huang" -> "angelo huang".
      return (
        parts[0] === first ||
        tokens.every((token) => parts.some((part) => part.startsWith(token))) ||
        (withoutInitial !== "" && withoutInitial === name)
      );
    });
  });
}

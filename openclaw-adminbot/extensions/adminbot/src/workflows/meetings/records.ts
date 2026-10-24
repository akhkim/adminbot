// Assembling a meeting record from the pieces that arrive separately, and deciding who sees what
// of it.
//
// A meeting is built up over hours: the notice lands within minutes of the recording finishing,
// the transcript when a host drops the VTT, the attendance CSV whenever someone remembers to
// export it. So every write is a merge onto whatever is already filed, and a later pass must never
// blank a field an earlier one populated -- that is the difference between "the summary is not
// ready yet" and "the summary was here yesterday and is gone now".
//
// The visibility split lives here too. Who attended a lab meeting is ordinary lab record-keeping
// for an admin and personal data about everyone else for a member, so a member is shown the
// meeting, their own attendance and a headcount, and never the roster.
import type {
  AdminBotMeetingAttendee,
  AdminBotMeetingHead,
  AdminBotMeetingRecord,
  AdminBotMeetingRecordInput,
  AdminBotMeetingSeries,
} from "../../contracts/actions.js";
import { mergeAttendance } from "./attendance.js";

const RFC3339_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/** Keep new records in one UTC format that both JavaScript and SQLite can sort. */
export function normalizedMeetingStartedAt(value: string): string | undefined {
  if (!RFC3339_INSTANT.test(value)) {
    return undefined;
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return undefined;
  }
  const normalized = new Date(time).toISOString();
  return /^\d{4}-/u.test(normalized) ? normalized : undefined;
}

/**
 * Why an input cannot be filed, or undefined when it can.
 *
 * `existing` is the stored record an update lands on. The artifact pass sends sparse updates with
 * an empty `recording` -- a transcript or a gallery recording knows nothing about the share link --
 * and the link that makes the record openable is the one the notice already filed.
 */
export function validateMeeting(
  input: AdminBotMeetingRecordInput,
  allowUnchangedHistoricalDate = false,
  existing?: AdminBotMeetingRecord,
): string | undefined {
  if (!input.id?.trim()) {
    return "id is required";
  }
  if (!input.topic?.trim()) {
    return "topic is required";
  }
  if (!allowUnchangedHistoricalDate && !normalizedMeetingStartedAt(input.started_at)) {
    return "started_at must be an RFC3339 timestamp";
  }
  // A record with neither link is not a recording anyone can open, and filing one would put a dead
  // row on the tab that nothing later can repair -- the ingest keys on the share URL.
  const hasLink = (recording?: AdminBotMeetingRecordInput["recording"]) =>
    Boolean(recording?.share_url?.trim() || recording?.drive_url?.trim());
  if (!hasLink(input.recording) && !hasLink(existing?.recording)) {
    return "recording.share_url or recording.drive_url is required";
  }
  return undefined;
}

/**
 * The stored record after applying an update.
 *
 * Field-by-field rather than a spread of the input over the existing record, because the ingest
 * sends a *sparse* update: the pass that attaches a transcript knows nothing about the passcode,
 * and a plain spread of its undefined fields would erase one.
 */
export function mergeMeeting(
  existing: AdminBotMeetingRecord | undefined,
  input: AdminBotMeetingRecordInput,
  now: string,
): AdminBotMeetingRecord {
  const attendees = input.attendees
    ? mergeAttendance(existing?.attendees ?? [], input.attendees)
    : existing?.attendees;
  return {
    ...existing,
    ...definedOnly(input),
    recording: { ...existing?.recording, ...definedOnly(input.recording ?? {}) },
    ...(attendees ? { attendees } : {}),
    // Both are the product of a model or a file that may be re-processed; keeping the newer one is
    // right, keeping the older one over an absent one is what stops a re-ingest from erasing it.
    ...((input.transcript ?? existing?.transcript)
      ? { transcript: input.transcript ?? existing?.transcript }
      : {}),
    ...((input.summary ?? existing?.summary)
      ? { summary: input.summary ?? existing?.summary }
      : {}),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  } as AdminBotMeetingRecord;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/**
 * The record as one member may see it.
 *
 * Attendance is reduced to the viewer's own line plus a count. The count is deliberate: "seven
 * people were there" is what makes the record useful to someone who missed the meeting, and it
 * names nobody.
 */
export function redactMeetingForMember(
  meeting: AdminBotMeetingRecord,
  memberId: string,
): AdminBotMeetingRecord {
  const attendees = meeting.attendees ?? [];
  const own = attendees.filter((attendee) => attendee.member_id === memberId);
  return {
    ...meeting,
    attendees: own,
    attendee_count: attendees.filter((attendee) => attendee.present).length,
  };
}

/**
 * How long the meeting ran, in seconds, when that is known at all.
 *
 * Three sources, in order of authority: the duration a participant report or a hand-filed record
 * carried, then the recording length Zoom's notice stated, then the span of the transcript. The
 * notice length was once left out on the belief that the mail states none; the assets template
 * does, to the second, and leaving it out listed every short test call it described as a meeting
 * of unknown length. The older template still states nothing, so "unknown" remains a normal state
 * and callers have to mean something by it rather than defaulting it to zero.
 */
export function meetingDurationSeconds(meeting: AdminBotMeetingHead): number | undefined {
  if (typeof meeting.duration_minutes === "number") {
    return meeting.duration_minutes * 60;
  }
  if (typeof meeting.duration_seconds === "number") {
    return meeting.duration_seconds;
  }
  const seconds = meeting.transcript?.duration_seconds;
  return typeof seconds === "number" ? seconds : undefined;
}

/** The same length, rounded to minutes. */
export function meetingDurationMinutes(meeting: AdminBotMeetingHead): number | undefined {
  const seconds = meetingDurationSeconds(meeting);
  return seconds === undefined ? undefined : Math.round(seconds / 60);
}

/**
 * Whether a meeting is long enough to list: strictly longer than `minimumMinutes`.
 *
 * Strictly, and in seconds: with the default of ten, a 10:00 room check is hidden and a 10:01
 * meeting is listed. Comparing rounded minutes would have let anything from 9:30 through 10:00
 * pass as "ten minutes".
 *
 * A meeting of unknown length is always long enough. The alternative -- hiding it until something
 * proves otherwise -- would hide every meeting filed from the older notice template, which states
 * no length, and every meeting an admin filed by hand, which has no length field. Short meetings
 * stay in the database either way: filing is how their length is ever learned, and a threshold
 * that only hides is one an admin can lower again without having lost anything.
 */
export function meetsDurationFloor(meeting: AdminBotMeetingHead, minimumMinutes: number): boolean {
  if (minimumMinutes <= 0) {
    return true;
  }
  const seconds = meetingDurationSeconds(meeting);
  return seconds === undefined || seconds > minimumMinutes * 60;
}

/**
 * Which recurring meeting a recording belongs to: its title, with case and spacing ignored.
 *
 * The title is the only thing that ties a week's recording to the last one -- every recording has
 * its own share link, and Zoom reuses a meeting id across unrelated series. Case and whitespace are
 * folded because the same series arrives as "Weekly Lab Meeting" from one host's notice and
 * "weekly lab meeting " from a hand-filed record; anything more aggressive (dropping a date, a
 * number) would merge series that are genuinely different, like "Reading Group 2".
 */
export function meetingSeriesKey(topic: string): string {
  return topic.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * The listed meetings folded into one row per series, newest series first.
 *
 * Takes the lightweight head rather than the record so the tab's index never parses a roster.
 * Meetings under the duration floor are left out, so a count here is always the number of
 * recordings the series' own list will show. The display title is the newest recording's, as it
 * was written.
 */
export function summarizeMeetingSeries(
  heads: readonly AdminBotMeetingHead[],
  minimumMinutes: number,
): AdminBotMeetingSeries[] {
  const series = new Map<string, AdminBotMeetingSeries & { latestTime: number }>();
  for (const head of heads) {
    if (!meetsDurationFloor(head, minimumMinutes)) {
      continue;
    }
    const key = meetingSeriesKey(head.topic);
    const time = Date.parse(head.started_at) || 0;
    const held = series.get(key);
    if (!held) {
      series.set(key, {
        key,
        topic: head.topic,
        count: 1,
        latest_started_at: head.started_at,
        latestTime: time,
      });
      continue;
    }
    held.count += 1;
    if (time > held.latestTime) {
      held.topic = head.topic;
      held.latest_started_at = head.started_at;
      held.latestTime = time;
    }
  }
  return [...series.values()]
    .toSorted(
      (left, right) => right.latestTime - left.latestTime || left.key.localeCompare(right.key),
    )
    .map(({ latestTime: _latest, ...row }) => row);
}

/** Newest first: a meetings tab is read to catch up on the one just missed. */
export function byMostRecent(left: AdminBotMeetingRecord, right: AdminBotMeetingRecord): number {
  return Date.parse(right.started_at) - Date.parse(left.started_at);
}

/** Whether this member is recorded as having been in the meeting. */
export function attendedBy(
  meeting: AdminBotMeetingRecord,
  memberId: string,
): AdminBotMeetingAttendee | undefined {
  return meeting.attendees?.find((attendee) => attendee.member_id === memberId && attendee.present);
}

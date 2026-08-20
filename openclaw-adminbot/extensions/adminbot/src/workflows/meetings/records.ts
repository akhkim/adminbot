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
  AdminBotMeetingRecord,
  AdminBotMeetingRecordInput,
} from "../../contracts/actions.js";
import { mergeAttendance } from "./attendance.js";

/** Why an input cannot be filed, or undefined when it can. */
export function validateMeeting(input: AdminBotMeetingRecordInput): string | undefined {
  if (!input.id?.trim()) {
    return "id is required";
  }
  if (!input.topic?.trim()) {
    return "topic is required";
  }
  if (!input.started_at?.trim() || Number.isNaN(Date.parse(input.started_at))) {
    return "started_at must be an RFC3339 timestamp";
  }
  // A record with neither link is not a recording anyone can open, and filing one would put a dead
  // row on the tab that nothing later can repair -- the ingest keys on the share URL.
  if (!input.recording?.share_url?.trim() && !input.recording?.drive_url?.trim()) {
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
    ...(input.transcript ?? existing?.transcript
      ? { transcript: input.transcript ?? existing?.transcript }
      : {}),
    ...(input.summary ?? existing?.summary ? { summary: input.summary ?? existing?.summary } : {}),
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
 * How long the meeting ran, in minutes, when that is known at all.
 *
 * Two sources, in order of authority: the duration a participant report or a hand-filed record
 * carried, then the span of the transcript. Neither exists on a record that is only a notice --
 * Zoom's mail does not state a duration -- so "unknown" is the normal state for the first few
 * hours of a meeting's life, and callers have to mean something by it rather than defaulting it
 * to zero.
 */
export function meetingDurationMinutes(meeting: AdminBotMeetingRecord): number | undefined {
  if (typeof meeting.duration_minutes === "number") {
    return meeting.duration_minutes;
  }
  const seconds = meeting.transcript?.duration_seconds;
  return typeof seconds === "number" ? Math.round(seconds / 60) : undefined;
}

/**
 * Whether a meeting is long enough to list.
 *
 * A meeting of unknown length is always long enough. The alternative -- hiding it until something
 * proves otherwise -- would hide every meeting for the hours between the notice arriving and a
 * transcript being dropped, which is exactly when someone goes looking for the recording. Short
 * meetings stay in the database either way: filing is how their length is ever learned, and a
 * threshold that only hides is one an admin can lower again without having lost anything.
 */
export function meetsDurationFloor(
  meeting: AdminBotMeetingRecord,
  minimumMinutes: number,
): boolean {
  if (minimumMinutes <= 0) {
    return true;
  }
  const minutes = meetingDurationMinutes(meeting);
  return minutes === undefined || minutes >= minimumMinutes;
}

/** Newest first: a meetings tab is read to catch up on the one just missed. */
export function byMostRecent(
  left: AdminBotMeetingRecord,
  right: AdminBotMeetingRecord,
): number {
  return Date.parse(right.started_at) - Date.parse(left.started_at);
}

/** Whether this member is recorded as having been in the meeting. */
export function attendedBy(
  meeting: AdminBotMeetingRecord,
  memberId: string,
): AdminBotMeetingAttendee | undefined {
  return meeting.attendees?.find(
    (attendee) => attendee.member_id === memberId && attendee.present,
  );
}

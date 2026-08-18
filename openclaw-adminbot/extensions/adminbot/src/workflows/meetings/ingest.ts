// Turning the three things that arrive from outside -- a forwarded notice, a transcript file and a
// participant export -- into writes against the meeting record.
//
// Deliberately free of I/O. Gmail and Drive are reached through `gog` in the cron scripts; what
// happens to what they return is decided here, where it can be tested without a Google account and
// without a model. The one thing this module does own is the rule for *which* meeting a dropped
// file belongs to, which is the only genuinely ambiguous step in the pipeline.
import type {
  AdminBotLabMember,
  AdminBotMeetingRecord,
  AdminBotMeetingRecordInput,
} from "../../contracts/actions.js";
import { attendanceFromParticipants, attendanceFromSpeakers, parseParticipantCsv } from "./attendance.js";
import { parseVtt } from "./vtt.js";
import { meetingRecordId, parseZoomRecordingNotice } from "./zoom-email.js";

export type IngestibleMessage = {
  id: string;
  subject: string;
  body: string;
  /** When Gmail received it. Stands in for the meeting time when Zoom's date line did not parse. */
  receivedAt: string;
};

/**
 * A forwarded notice as a record to file, or undefined when the mail is not one.
 *
 * `started_at` falls back to the mail's own timestamp rather than refusing the record: a recording
 * notice arrives within minutes of the meeting ending, so "when this mail landed" is wrong by an
 * hour at worst, and a meeting filed an hour off is worth incomparably more than no meeting.
 */
export function noticeToMeeting(
  message: IngestibleMessage,
): AdminBotMeetingRecordInput | undefined {
  const notice = parseZoomRecordingNotice(message);
  if (!notice) {
    return undefined;
  }
  return {
    id: meetingRecordId(notice),
    topic: notice.topic,
    started_at: notice.startedAt ?? message.receivedAt,
    recording: {
      share_url: notice.shareUrl,
      ...(notice.passcode ? { passcode: notice.passcode } : {}),
    },
    source: "zoom_email",
    ...(notice.startedAt
      ? {}
      : { notes: `Zoom's date line did not parse: ${notice.startedAtText ?? "absent"}` }),
  };
}

export type DroppedFile = {
  name: string;
  /** Drive's file id, so the caller can download it and the caller alone touches the network. */
  id: string;
};

export type ArtifactKind = "transcript" | "participants";

/** What a dropped file is, by extension. Anything else in the folder is left alone. */
export function artifactKind(fileName: string): ArtifactKind | undefined {
  if (/\.vtt$/iu.test(fileName)) {
    return "transcript";
  }
  if (/\.csv$/iu.test(fileName)) {
    return "participants";
  }
  return undefined;
}

// The date stamps Zoom and a human between them put in a filename: Zoom's own
// "GMT20260812-100000_Recording.transcript.vtt", and the two ways someone renaming it writes a date.
const FILE_DATE = /(?:GMT)?(\d{4})-?(\d{2})-?(\d{2})/u;

/**
 * The meeting a dropped file belongs to, or undefined when that is not decidable.
 *
 * Date first, because it is the one thing both the filename and the record reliably carry. A day
 * with one meeting on it is unambiguous and matches immediately; a day with several needs the
 * topic to appear in the filename as well, and if it does not, this returns nothing rather than
 * attaching an hour of one meeting's transcript to another meeting's record. A file nobody can
 * place is reported to the operator, which is a far better failure than a confident wrong answer.
 *
 * The window is a day either side: Zoom names the file in GMT, the record's start is an instant,
 * and a 7pm Toronto meeting is already tomorrow in GMT.
 */
export function matchArtifactToMeeting(
  fileName: string,
  meetings: readonly AdminBotMeetingRecord[],
): AdminBotMeetingRecord | undefined {
  const stamp = FILE_DATE.exec(fileName);
  if (!stamp) {
    return undefined;
  }
  const fileDay = Date.parse(`${stamp[1]}-${stamp[2]}-${stamp[3]}T00:00:00.000Z`);
  if (Number.isNaN(fileDay)) {
    return undefined;
  }
  const dayMs = 86_400_000;
  // Both sides are floored to a UTC day before comparing. Comparing an instant against a midnight
  // makes the window lopsided -- a 9pm Toronto meeting is 01:00 the next day in UTC, 25 hours from
  // the filename's midnight, and would fall outside a naive one-day radius.
  const sameDay = meetings.filter((meeting) => {
    const startedDay = Math.floor(Date.parse(meeting.started_at) / dayMs) * dayMs;
    return Math.abs(startedDay - fileDay) <= dayMs;
  });
  if (sameDay.length === 1) {
    return sameDay[0];
  }
  const haystack = fileName.toLowerCase();
  const byTopic = sameDay.filter((meeting) => haystack.includes(topicSlug(meeting.topic)));
  return byTopic.length === 1 ? byTopic[0] : undefined;
}

/** A topic as it survives into a filename: lowercase, spaces and punctuation gone. */
function topicSlug(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

/**
 * A transcript file as an update to the meeting it belongs to.
 *
 * Returns the update *and* the transcript text separately: the text goes to the summarizer and is
 * then dropped, and keeping it out of the record object is what makes that hard to get wrong.
 */
export function transcriptUpdate(
  meeting: AdminBotMeetingRecord,
  vttSource: string,
  members: readonly AdminBotLabMember[],
  now: string,
): { update: AdminBotMeetingRecordInput; transcriptText: string } {
  const parsed = parseVtt(vttSource);
  return {
    transcriptText: parsed.text,
    update: {
      id: meeting.id,
      topic: meeting.topic,
      started_at: meeting.started_at,
      recording: {},
      source: meeting.source,
      transcript: {
        processed_at: now,
        speaker_names: parsed.speakers,
        ...(parsed.durationSeconds ? { duration_seconds: parsed.durationSeconds } : {}),
      },
      ...(parsed.durationSeconds
        ? { duration_minutes: Math.round(parsed.durationSeconds / 60) }
        : {}),
      // Provisional only: the merge rules let a participant report or a human overwrite these.
      attendees: attendanceFromSpeakers(parsed.speakers, members),
    },
  };
}

/** A participant CSV as an update, or undefined when the file had no participant section. */
export function participantsUpdate(
  meeting: AdminBotMeetingRecord,
  csvSource: string,
  members: readonly AdminBotLabMember[],
): AdminBotMeetingRecordInput | undefined {
  const rows = parseParticipantCsv(csvSource);
  if (rows.length === 0) {
    return undefined;
  }
  return {
    id: meeting.id,
    topic: meeting.topic,
    started_at: meeting.started_at,
    recording: {},
    source: meeting.source,
    attendees: attendanceFromParticipants(rows, members),
  };
}

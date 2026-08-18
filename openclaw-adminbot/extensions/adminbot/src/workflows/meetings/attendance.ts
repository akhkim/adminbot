// Who was actually in the meeting.
//
// This is the part the missing Zoom API really costs. There is no attendance in the recording
// notice and no report endpoint to call, so the authoritative source is the participant CSV a host
// exports from Reports -> Usage and drops in the watched folder. Everything here parses that file
// and lines it up against the lab roster.
//
// The transcript is a second, weaker source: it says who *spoke*, which silently loses everyone
// who sat through the hour without unmuting. It is therefore only ever used to pre-tick a roster
// an admin then corrects -- `source` is carried on every attendee for exactly that reason, so the
// UI can show what is known versus what is inferred, and so a later CSV import can overwrite an
// inference without overwriting a human's correction.
import type {
  AdminBotLabMember,
  AdminBotMeetingAttendanceSource,
  AdminBotMeetingAttendee,
} from "../../contracts/actions.js";

/** One row of the participant section of a Zoom usage export. */
export type ZoomParticipantRow = {
  name: string;
  email?: string;
  joinedAt?: string;
  minutes?: number;
};

// The participant section's header, which is the only row naming both a person and a duration.
// Zoom's export opens with a one-row meeting summary block that also has a "Topic" and a
// "Duration (Minutes)" column, so a parser that takes the first header it sees reads the summary
// row as an attendee.
const NAME_COLUMN = /^name(?:\s*\(original name\))?$/iu;
const EMAIL_COLUMN = /^(?:user\s*)?e-?mail$/iu;
const JOIN_COLUMN = /^join\s*time$/iu;
const DURATION_COLUMN = /^duration\s*\(minutes\)$/iu;

/**
 * Rows from a Zoom participant CSV, or an empty list when the file has no participant section.
 *
 * Tolerant by design: this file is exported by hand from a web UI, so it arrives with a BOM, with
 * CRLF endings, occasionally re-saved by Excel, and with the column set varying by account
 * settings. Columns are found by name rather than by index for that reason.
 */
export function parseParticipantCsv(source: string): ZoomParticipantRow[] {
  const rows = parseCsv(source.replace(/^﻿/u, ""));
  const headerIndex = rows.findIndex(
    (row) =>
      row.some((cell) => NAME_COLUMN.test(cell.trim())) &&
      row.some((cell) => DURATION_COLUMN.test(cell.trim())),
  );
  if (headerIndex < 0) {
    return [];
  }
  const header = (rows[headerIndex] ?? []).map((cell) => cell.trim());
  const column = (pattern: RegExp): number => header.findIndex((cell) => pattern.test(cell));
  const nameAt = column(NAME_COLUMN);
  const emailAt = column(EMAIL_COLUMN);
  const joinAt = column(JOIN_COLUMN);
  const durationAt = column(DURATION_COLUMN);
  const participants: ZoomParticipantRow[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const name = row[nameAt]?.trim();
    if (!name) {
      continue;
    }
    const minutes = Number(row[durationAt]?.trim());
    participants.push({
      name,
      ...(row[emailAt]?.trim() ? { email: row[emailAt]?.trim().toLowerCase() } : {}),
      ...(row[joinAt]?.trim() ? { joinedAt: row[joinAt]?.trim() } : {}),
      ...(Number.isFinite(minutes) ? { minutes } : {}),
    });
  }
  return participants;
}

/**
 * A CSV into cells, quotes and embedded newlines respected.
 *
 * Hand-rolled rather than pulled in: this parses exactly one vendor's export, the whole grammar is
 * the twenty lines below, and the plugin boundary rules make a new runtime dependency in
 * `extensions/adminbot` a heavier decision than the code it would save.
 */
function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted cell is a literal quote, not the end of the cell.
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * Participant rows as attendance, resolved against the roster.
 *
 * Rows are merged per person because a dropped connection produces a second row for the same
 * attendee, and counting that as two people would make a seven-person meeting report nine.
 */
export function attendanceFromParticipants(
  rows: readonly ZoomParticipantRow[],
  members: readonly AdminBotLabMember[],
): AdminBotMeetingAttendee[] {
  const merged = new Map<string, AdminBotMeetingAttendee>();
  for (const row of rows) {
    const member = matchMember(row, members);
    const key = member?.id ?? row.email ?? normalizeName(row.name);
    const existing = merged.get(key);
    merged.set(key, {
      display_name: existing?.display_name ?? row.name,
      ...(member ? { member_id: member.id } : {}),
      ...(row.email ?? existing?.email ? { email: row.email ?? existing?.email } : {}),
      ...(earliest(existing?.joined_at, row.joinedAt)
        ? { joined_at: earliest(existing?.joined_at, row.joinedAt) }
        : {}),
      minutes: (existing?.minutes ?? 0) + (row.minutes ?? 0),
      source: "participant_report",
      present: true,
    });
  }
  return [...merged.values()];
}

/**
 * Transcript speakers as provisional attendance.
 *
 * Marked `transcript` so nothing downstream mistakes it for the real thing: this list is everyone
 * who talked, and a meeting's quietest attendee is exactly the person it will miss.
 */
export function attendanceFromSpeakers(
  speakers: readonly string[],
  members: readonly AdminBotLabMember[],
): AdminBotMeetingAttendee[] {
  return speakers.map((speaker) => {
    const member = matchMember({ name: speaker }, members);
    return {
      display_name: speaker,
      ...(member ? { member_id: member.id } : {}),
      source: "transcript" as AdminBotMeetingAttendanceSource,
      present: true,
    };
  });
}

/**
 * A roster with a newly imported one folded in.
 *
 * Precedence is the point: a human correction outranks anything imported, and a participant report
 * outranks a guess made from the transcript. Without that, the hourly pass re-importing a
 * transcript would quietly undo the admin who ticked the person who never unmuted.
 */
export function mergeAttendance(
  existing: readonly AdminBotMeetingAttendee[],
  incoming: readonly AdminBotMeetingAttendee[],
): AdminBotMeetingAttendee[] {
  const rank: Record<AdminBotMeetingAttendanceSource, number> = {
    transcript: 0,
    participant_report: 1,
    manual: 2,
  };
  const byKey = new Map<string, AdminBotMeetingAttendee>();
  for (const attendee of [...existing, ...incoming]) {
    const key = attendee.member_id ?? attendee.email ?? normalizeName(attendee.display_name);
    const held = byKey.get(key);
    if (!held || rank[attendee.source] >= rank[held.source]) {
      byKey.set(key, held ? { ...held, ...attendee } : attendee);
    }
  }
  return [...byKey.values()];
}

/**
 * The lab member a participant row is, when it is one.
 *
 * Email first and exactly: it is the only identifier Zoom carries that a person cannot restyle
 * between meetings. Both addresses on the record are checked, because the department address a
 * member is registered under is very often not the account they take Zoom calls on. Names are the
 * fallback and are compared with punctuation, case and accents removed -- "Ana Ruiz-Gómez" and
 * "ana ruiz gomez" are one person, and the guest who typed "Ana (phone)" is not matched at all,
 * which is the safe direction to fail.
 */
function matchMember(
  row: { name: string; email?: string },
  members: readonly AdminBotLabMember[],
): AdminBotLabMember | undefined {
  const email = row.email?.trim().toLowerCase();
  if (email) {
    const byEmail = members.find(
      (member) =>
        member.email?.toLowerCase() === email || member.calendar_email?.toLowerCase() === email,
    );
    if (byEmail) {
      return byEmail;
    }
  }
  const name = normalizeName(row.name);
  if (!name) {
    return undefined;
  }
  const matches = members.filter(
    (member) => normalizeName(member.name) === name || reversedName(member.name) === name,
  );
  // Two members with the same normalized name is rare and unresolvable from a display name alone.
  // Attributing the attendance to whichever sorted first would be a coin flip recorded as fact.
  return matches.length === 1 ? matches[0] : undefined;
}

export function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** "Kim, Andrew" as "andrew kim", since Zoom and the roster disagree about which comes first. */
function reversedName(value: string): string {
  const [family, given] = value.split(",");
  return given ? normalizeName(`${given} ${family}`) : normalizeName(value);
}

function earliest(left?: string, right?: string): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

#!/usr/bin/env -S node --import tsx
// File meeting attendance from Zoom dashboard exports (`meetinglistdetails_*.csv`).
//
//   node --import tsx scripts/adminbot-meeting-attendance-import.ts <export.csv>... \
//     [--aliases aliases.json] [--min-participants 15] [--topic "Weekly Lab Meeting"] \
//     [--timezone America/Toronto] [--database <path>] [--apply]
//
// For the meetings the hourly drop-folder pass never saw: those from before it existed, and those
// nobody exported a participant report for. The dashboard export covers a month per file, so a
// whole term can be filled in from a handful of downloads (Zoom web -> Reports/Dashboard ->
// Meetings -> Past -> export with meeting details).
//
// What it does, per meeting with more than --min-participants people (rejoins counted once):
//
//   - finds the record a recording notice already filed, by series and recording length
//     (`matchRecordedMeeting`), or files a new one under `zoom-<meeting id>-<date>` with
//     source `participant_report`, which needs no recording link;
//   - writes the roster as `participant_report` attendance through `upsertMeeting`, so it merges
//     like the hourly pass's: a line an admin ticked by hand outranks it, and it outranks a
//     transcript guess;
//   - sets the start time and length from the report.
//
// Notetaker bots are dropped. Display names Zoom shows instead of a member's name ("Andrew K",
// "Zhijing") are resolved with --aliases, a JSON object of display name -> member id, or null to
// drop the name (a room's account). Keep that file with the exports, not in the repo: it names
// lab members.
//
// A dry run unless --apply is passed. The dry run prints, per meeting, the record it would write
// and every display name it could not match, with members the name could be, so the alias file
// can be written from its output. Re-running with --apply after a dry run writes exactly what the
// dry run printed, and re-running it again changes nothing.
//
// Mind the attendance reminder: a meeting with a roster counts toward the weekly
// "missed two meetings" nudge, so review the dry run's unmatched names before applying.
import fs from "node:fs";
import type { AdminBotLabMember } from "../extensions/adminbot/src/contracts/actions.js";
import { createAdminBotSqliteService } from "../extensions/adminbot/src/persistence/sqlite.js";
import { normalizeName } from "../extensions/adminbot/src/workflows/meetings/attendance.js";
import { meetingSeriesKey } from "../extensions/adminbot/src/workflows/meetings/records.js";
import {
  aliasCandidates,
  attendanceFromDashboard,
  dashboardMeetingRecordId,
  dashboardMeetingUpdate,
  matchRecordedMeeting,
  parseZoomDashboardCsv,
  uniqueParticipantCount,
  type ZoomDashboardMeeting,
  type ZoomNameAliases,
} from "../extensions/adminbot/src/workflows/meetings/zoom-dashboard.js";
import { adminbotServiceDatabasePath } from "./adminbot-service-database.js";
import { isMainModule } from "./lib/is-main-module.mjs";

type Args = {
  files: string[];
  aliasesPath?: string;
  minParticipants: number;
  topic?: string;
  timeZone: string;
  databasePath: string;
  apply: boolean;
};

const VALUE_FLAGS = new Set([
  "--aliases",
  "--min-participants",
  "--topic",
  "--timezone",
  "--database",
]);

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const files = argv.filter(
    (arg, index) => !arg.startsWith("--") && !VALUE_FLAGS.has(argv[index - 1] ?? ""),
  );
  if (files.length === 0) {
    throw new Error("pass at least one Zoom dashboard export (meetinglistdetails_*.csv)");
  }
  const minParticipants = Number(value("--min-participants") ?? "15");
  if (!Number.isInteger(minParticipants) || minParticipants < 0) {
    throw new Error("--min-participants must be a whole number");
  }
  return {
    files,
    ...(value("--aliases") ? { aliasesPath: value("--aliases") } : {}),
    minParticipants,
    ...(value("--topic") ? { topic: value("--topic") } : {}),
    timeZone: value("--timezone") ?? "America/Toronto",
    databasePath: value("--database") ?? adminbotServiceDatabasePath(env),
    apply: argv.includes("--apply"),
  };
}

export function readAliases(
  path: string | undefined,
  members: readonly AdminBotLabMember[],
): ZoomNameAliases {
  if (!path) {
    return new Map();
  }
  const raw = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
  const aliases = new Map<string, string | null>();
  for (const [name, target] of Object.entries(raw)) {
    if (target !== null && typeof target !== "string") {
      throw new Error(`alias "${name}" must map to a member id or null`);
    }
    // Checked up front, so a typo stops the run before anything is written rather than halfway.
    if (target !== null && !members.some((member) => member.id === target)) {
      throw new Error(`alias "${name}" names unknown member ${target}`);
    }
    aliases.set(normalizeName(name), target);
  }
  return aliases;
}

/** The meetings across every file, once each: consecutive exports overlap at their edges. */
export function qualifyingMeetings(
  files: readonly string[],
  args: Pick<Args, "minParticipants" | "topic" | "timeZone">,
): ZoomDashboardMeeting[] {
  const byKey = new Map<string, ZoomDashboardMeeting>();
  for (const file of files) {
    const meetings = parseZoomDashboardCsv(fs.readFileSync(file, "utf8"), args.timeZone);
    if (meetings.length === 0) {
      throw new Error(`${file} is not a Zoom dashboard export with participant details`);
    }
    for (const meeting of meetings) {
      byKey.set(`${meeting.zoomMeetingId}|${meeting.startedAt}`, meeting);
    }
  }
  const series = args.topic ? meetingSeriesKey(args.topic) : undefined;
  return [...byKey.values()]
    .filter((meeting) => !series || meetingSeriesKey(meeting.topic) === series)
    .filter((meeting) => uniqueParticipantCount(meeting) > args.minParticipants)
    .toSorted((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  const meetings = qualifyingMeetings(args.files, args);
  const { service, close } = createAdminBotSqliteService({ databasePath: args.databasePath });
  try {
    const listed = service.listLabMembers();
    const members = listed.ok ? listed.payload.members : [];
    const aliases = readAliases(args.aliasesPath, members);
    const stored = service.listMeetings({ includeShort: true });
    const records = stored.ok ? stored.payload.meetings : [];
    const claimed = new Set<string>();
    const unmatched = new Map<string, number>();
    let failures = 0;
    console.log(
      `${args.apply ? "Applying" : "Dry run:"} ${meetings.length} meeting(s) with more than ` +
        `${args.minParticipants} participants`,
    );
    for (const meeting of meetings) {
      const existing =
        records.find((record) => record.id === dashboardMeetingRecordId(meeting)) ??
        matchRecordedMeeting(meeting, records, claimed);
      if (existing) {
        claimed.add(existing.id);
      }
      const { attendees, dropped } = attendanceFromDashboard(meeting, members, aliases);
      const guests = attendees.filter((attendee) => !attendee.member_id);
      const update = dashboardMeetingUpdate(meeting, attendees, existing);
      console.log(
        `\n${meeting.startedAt}  ${meeting.topic}  ${uniqueParticipantCount(meeting)} people, ` +
          `${meeting.durationMinutes} min -> ${existing ? "existing" : "new"} ${update.id}`,
      );
      console.log(
        `  members ${attendees.length - guests.length}, guests ${guests.length}` +
          (dropped.length ? `, dropped: ${dropped.join("; ")}` : ""),
      );
      for (const guest of guests) {
        unmatched.set(guest.display_name, (unmatched.get(guest.display_name) ?? 0) + 1);
      }
      if (args.apply) {
        const result = service.upsertMeeting(update);
        if (!result.ok) {
          failures += 1;
          console.error(`  FAILED: ${result.error.message}`);
        }
      }
    }
    if (unmatched.size > 0) {
      console.log("\nUnmatched display names (meetings), with members they could be:");
      for (const [name, count] of [...unmatched].toSorted((a, b) => b[1] - a[1])) {
        const candidates = aliasCandidates(name, members)
          .map((member) => `${member.name} (${member.id})`)
          .join("; ");
        console.log(
          `  ${String(count).padStart(2)}  ${name}${candidates ? `  ?  ${candidates}` : ""}`,
        );
      }
    }
    return failures > 0 ? 1 : 0;
  } finally {
    close();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

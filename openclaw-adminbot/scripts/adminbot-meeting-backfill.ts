#!/usr/bin/env -S node --import tsx
// Re-parse the Zoom recording notices already in Gmail, and update the meetings they filed.
//
//   node --import tsx scripts/adminbot-meeting-backfill.ts --db <path> [--apply]
//
// Why this exists: the notice parser has learned three things the recordings on the tab predate --
// the "Meeting assets for X are ready!" subject (77330cdd), the `Duration:` line, and the
// forwarded `Sent:` header that is the only date that template carries. None of them can be
// applied to a record after the fact, because the record keeps no copy of the mail. The mail is
// still in Gmail, so this reads it again.
//
// Deliberately not part of the hourly automation. That pass has a state store which records every
// message it has handled, and re-running it over old mail would mean either clearing those rows --
// which is the ledger saying what the lab has already acted on -- or teaching it to distinguish a
// re-parse from a first read. A separate one-off that touches neither is the smaller thing.
//
// Safe to run more than once, and safe to run against live data:
//
//   - Record ids are derived from the notice (`meetingRecordId`), so a re-parse updates the same
//     row rather than filing a second one.
//   - `mergeMeeting` merges rather than replaces: a field the new parse does not know is left
//     alone, so a summary written by the model, an attendance roster somebody ticked by hand and a
//     transcript already attached all survive. This script cannot erase them.
//   - It is a dry run unless `--apply` is passed, and the dry run prints exactly the fields each
//     record would gain.
import { execFile as execFileCallback } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AdminBotMeetingRecordInput } from "../extensions/adminbot/src/contracts/actions.js";
import { createAdminBotSqliteService } from "../extensions/adminbot/src/persistence/sqlite.js";
import { noticeToMeeting } from "../extensions/adminbot/src/workflows/meetings/ingest.js";

const execFile = promisify(execFileCallback);

/**
 * Every mail carrying a Zoom share link, forwarded or not.
 *
 * On the body rather than the sender: the notices reach the lab forwarded by a person, so
 * `from:no-reply@zoom.us` would miss the ones that matter. The share URL is the same string
 * `looksLikeZoomRecordingNotice` gates on, and no human writes one by accident.
 */
const DEFAULT_QUERY = '"zoom.us/rec/share"';

/** The note the ingest leaves when Zoom's date line did not parse. Cleared once one does. */
const STALE_DATE_NOTE = "Zoom's date line did not parse";

type Args = {
  databasePath: string;
  query: string;
  max: number;
  apply: boolean;
  account: string;
};

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  // `--db` / ADMINBOT_DB_PATH, matching adminbot-availability-import and
  // adminbot-meeting-artifacts. Deliberately no default: those scripts fall back to
  // ~/.openclaw/state/adminbot.sqlite, but the *service* reads $REPO_ROOT/state/adminbot.sqlite
  // (host/main.ts), and on a deployment where those are not the same file a default would quietly
  // rewrite the wrong database. Naming it is cheap; picking the wrong one is not.
  const databasePath = value("--db") ?? value("--database") ?? process.env.ADMINBOT_DB_PATH ?? "";
  if (!databasePath) {
    throw new Error("--db <path> is required (or set ADMINBOT_DB_PATH)");
  }
  const account = value("--account") ?? process.env.ADMINBOT_BOT_EMAIL?.trim() ?? "";
  if (!account) {
    throw new Error("--account <email> is required (or set ADMINBOT_BOT_EMAIL)");
  }
  return {
    databasePath,
    account,
    query: value("--query") ?? DEFAULT_QUERY,
    max: Number(value("--max") ?? "200"),
    apply: argv.includes("--apply"),
  };
}

function gogBinary(): string {
  const candidate = process.env.GOG_BIN?.trim();
  return candidate || path.join(os.homedir(), ".local", "bin", "gog");
}

type Fetched = { id: string; subject: string; body: string; receivedAt: string };

/**
 * The matching mail, as much of each as the parser needs.
 *
 * `--full` because the parser reads the body: a snippet stops well before the share link, and a
 * record built from one would be missing the very field it cannot be created without.
 */
async function fetchNotices(args: Args): Promise<Fetched[]> {
  const { stdout } = await execFile(
    gogBinary(),
    [
      "gmail",
      "messages",
      "search",
      args.query,
      "--max",
      String(args.max),
      "--full",
      "--results-only",
      "--account",
      args.account,
      "--json",
      "--no-input",
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
  );
  const payload: unknown = JSON.parse(stdout);
  const rows: unknown[] = Array.isArray(payload)
    ? payload
    : ((payload as { messages?: unknown[] })?.messages ??
      (payload as { results?: unknown[] })?.results ??
      []);
  const header = (row: Record<string, unknown>, name: string): string => {
    const headers = (row.payload as { headers?: Array<{ name?: string; value?: string }> })
      ?.headers;
    return headers?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
  };
  return rows.flatMap((value) => {
    if (!value || typeof value !== "object") {
      return [];
    }
    const row = value as Record<string, unknown>;
    const id = String(row.id ?? row.messageId ?? "");
    const body = String(row.body ?? row.text ?? "");
    if (!id || !body) {
      return [];
    }
    return [
      {
        id,
        subject: String(row.subject ?? header(row, "Subject") ?? ""),
        body,
        receivedAt: row.internalDate
          ? new Date(Number(row.internalDate)).toISOString()
          : new Date().toISOString(),
      },
    ];
  });
}

/** What this re-parse would change about a record, in the words the report prints. */
function describeChange(
  existing: { topic?: string; started_at?: string; duration_seconds?: number } | undefined,
  next: AdminBotMeetingRecordInput,
): string[] {
  const changes: string[] = [];
  if (!existing) {
    return ["new record"];
  }
  if (existing.topic !== next.topic) {
    changes.push(`topic ${JSON.stringify(existing.topic)} -> ${JSON.stringify(next.topic)}`);
  }
  if (existing.started_at !== next.started_at) {
    changes.push(`started_at ${existing.started_at} -> ${next.started_at}`);
  }
  if (next.duration_seconds && existing.duration_seconds !== next.duration_seconds) {
    const was = existing.duration_seconds ? `${existing.duration_seconds}s` : "none";
    changes.push(`duration ${was} -> ${next.duration_seconds}s`);
  }
  return changes;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const notices = await fetchNotices(args);
  console.log(`${notices.length} mail(s) matching ${args.query}`);

  // Both halves: the store answers "what is on file" directly, and the service is what writes,
  // because `upsertMeeting` is where the merge and the audit row live.
  const { service, store, close } = createAdminBotSqliteService({
    databasePath: args.databasePath,
  });
  let changed = 0;
  let unchanged = 0;
  let skipped = 0;
  let duplicates = 0;
  try {
    // Every record already on file, by the one field a re-parse cannot move.
    const onFile = new Map(
      store
        .listMeetings()
        .flatMap((meeting) =>
          meeting.recording?.share_url ? [[meeting.recording.share_url, meeting] as const] : [],
        ),
    );
    for (const message of notices) {
      const parsed = noticeToMeeting(message);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      let existing = store.getMeeting(parsed.id);
      if (!existing) {
        // The id is derived from the notice, and it is only stable while the *shape* of the notice
        // is: `meetingRecordId` keys on the meeting id and day when it has both, and falls back to
        // hashing the share token when it does not. So a re-parse that newly finds a date for a
        // mail that already had a meeting id moves the record from the hash form to the keyed one,
        // and writing it would leave the original behind as a duplicate. Matched on the share URL,
        // which does not move, and reported rather than written.
        const sameLink = onFile.get(parsed.recording.share_url ?? "");
        if (sameLink && sameLink.id !== parsed.id) {
          console.log(`\n${sameLink.id}`);
          console.log(
            `  ! would now file as ${parsed.id} -- re-parsing moved its id, so writing this ` +
              "would duplicate the record rather than update it. Left alone.",
          );
          duplicates += 1;
          continue;
        }
        existing = sameLink;
      }
      const changes = describeChange(existing, parsed);
      if (changes.length === 0) {
        unchanged += 1;
        continue;
      }
      changed += 1;
      console.log(`\n${parsed.id}`);
      for (const line of changes) {
        console.log(`  ${line}`);
      }
      if (!args.apply) {
        continue;
      }
      // Clear the ingest's own "date line did not parse" note once a date does, and only that
      // note: anything else in the field was written by a person about this meeting.
      const clearsNote =
        existing?.notes?.startsWith(STALE_DATE_NOTE) && parsed.started_at && !parsed.notes;
      const result = service.upsertMeeting({ ...parsed, ...(clearsNote ? { notes: "" } : {}) });
      if (!result.ok) {
        console.log(`  ! refused: ${result.error.message}`);
      }
    }
  } finally {
    close();
  }
  console.log(
    `\n${changed} record(s) ${args.apply ? "updated" : "would change"}, ` +
      `${unchanged} already current, ${skipped} mail(s) were not notices` +
      `${duplicates ? `, ${duplicates} left alone to avoid a duplicate` : ""}.`,
  );
  if (!args.apply && changed > 0) {
    console.log("Dry run. Re-run with --apply to write these.");
  }
}

await main();

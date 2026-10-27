#!/usr/bin/env tsx
// Rewrites the Vector sponsor spreadsheet from the live roster.
//
// The sheet is shared with our Vector contact once, by hand; this script only keeps its contents
// current. He reads it to decide whether to extend or remove an account, so an absent person reads
// as "remove this account" — which is why the write happens before the stale tail is cleared, and
// why an empty roster aborts instead of blanking the sheet.
//
// Membership is not decided here: `vectorSponsorRoster` owns that rule so the sheet and the access
// matrix can never disagree about who belongs on it.
import { execFile as execFileCallback } from "node:child_process";
import { isMainModule } from "./lib/is-main-module.mjs";
import { promisify } from "node:util";
import { resolveGogExecutable } from "../extensions/adminbot/src/connectors/gog.js";
import type { AdminBotLabMember } from "../extensions/adminbot/src/contracts/actions.js";
import {
  vectorSponsorRoster,
  type AdminBotVectorRoster,
} from "../extensions/adminbot/src/workflows/members/collaborator-subgroups.js";

const execFile = promisify(execFileCallback);

// gid=0 of the sheet already shared with the sponsor. Hard-coded rather than configurable: it is a
// single standing artifact with an external reader, not a per-deployment setting.
const SPREADSHEET_ID = "1rllV-oGw26HY4K97LiF8qhW8NhXPvLZ0kbBioHiGATg";
const HEADER = ["Name", "Email"] as const;
const GOG_TIMEOUT_MS = 60_000;

/** Header plus one row per person; nothing about them beyond name and institutional email. */
export function buildSheetValues(roster: AdminBotVectorRoster): string[][] {
  return [[...HEADER], ...roster.entries.map((entry) => [entry.name, entry.email])];
}

export type SyncOptions = {
  roster: AdminBotVectorRoster;
  gog: (args: string[]) => Promise<void>;
  dryRun?: boolean;
  // Missing emails are a roster gap the lab has to close, but they are not a sync failure. Opt in
  // to failing the cron run on them when you want the Cron tab to nag.
  strict?: boolean;
};

export async function syncVectorRoster(options: SyncOptions): Promise<Record<string, unknown>> {
  const { roster } = options;
  const values = buildSheetValues(roster);

  // A roster that came back empty is far more likely to be a service or auth fault than a lab with
  // nobody in it, and writing it would tell the sponsor to remove every account.
  if (roster.entries.length === 0) {
    throw new Error(
      "refusing to write an empty roster to the sponsor sheet: check the AdminBot service is up and the token is valid",
    );
  }

  if (options.dryRun) {
    return { dry_run: true, ...summarize(roster) };
  }

  // Write first, clear second. The reverse order leaves the sheet blank if the write then fails.
  await options.gog([
    "sheets",
    "update",
    SPREADSHEET_ID,
    `A1:B${values.length}`,
    "--input",
    "RAW",
    "--values-json",
    JSON.stringify(values),
  ]);
  await options.gog(["sheets", "clear", SPREADSHEET_ID, `A${values.length + 1}:B`, "--force"]);

  if (options.strict && roster.missing_email.length > 0) {
    throw new Error(
      `${roster.missing_email.length} member(s) belong on the sponsor sheet but have no email: ${roster.missing_email.join(", ")}`,
    );
  }
  return summarize(roster);
}

function summarize(roster: AdminBotVectorRoster) {
  return {
    spreadsheet_id: SPREADSHEET_ID,
    written_rows: roster.entries.length,
    missing_email: roster.missing_email,
    synced_at: new Date().toISOString(),
  };
}

async function fetchRoster(): Promise<AdminBotVectorRoster> {
  const token = process.env.ADMINBOT_SERVICE_TOKEN;
  if (!token) {
    throw new Error("ADMINBOT_SERVICE_TOKEN is not set");
  }
  const port = process.env.ADMINBOT_PORT || "8765";
  const response = await fetch(`http://127.0.0.1:${port}/lab/members`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch((error: unknown) => {
    // A refused connection here just means the service is down; the raw undici stack tells the
    // operator nothing they can act on.
    throw new Error(`cannot reach the AdminBot service on 127.0.0.1:${port} — is it running?`, {
      cause: error,
    });
  });
  if (!response.ok) {
    throw new Error(`GET /lab/members failed: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as { members?: AdminBotLabMember[] };
  return vectorSponsorRoster(payload.members ?? []);
}

/**
 * One line saying which gog step failed and what Google said, built only from the subcommand and
 * gog's stderr.
 *
 * execFile's own error message is "Command failed: <full argv>", and the argv of the update step is
 * the whole roster as JSON. Rethrowing that put every member's name and email into the cron run
 * log, the run summary, and the Control UI's Cron tab, once per failed night.
 */
export function describeGogFailure(args: string[], error: unknown, account?: string): string {
  const step = `gog ${args.slice(0, 2).join(" ")}`;
  const failure = (error ?? {}) as { stderr?: unknown; killed?: boolean; signal?: unknown };
  if (failure.killed || failure.signal === "SIGTERM") {
    return `${step} timed out after ${GOG_TIMEOUT_MS / 1000}s`;
  }
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
  const detail = stderr ? stderr.split("\n").slice(-3).join(" ").slice(0, 400) : "no stderr";
  // A 403 here has never been auth: the token reads this sheet fine. It means the sheet was shared
  // with the bot as a viewer, which only its owner can change, so say so instead of leaving the
  // operator to rediscover it from a bare "caller does not have permission".
  const hint = /\b403\b|does not have permission/iu.test(detail)
    ? ` — ${account || "the gog account"} needs Editor access on spreadsheet ${SPREADSHEET_ID}; ask its owner to share it`
    : "";
  return `${step} failed: ${detail}${hint}`;
}

async function gog(args: string[]): Promise<void> {
  const account = process.env.GOG_ACCOUNT?.trim();
  const rootArgs = ["--no-input", "--json", ...(account ? ["--account", account] : [])];
  try {
    await execFile(resolveGogExecutable(), [...rootArgs, ...args], {
      timeout: GOG_TIMEOUT_MS,
    });
  } catch (error: unknown) {
    // No `cause`: main() prints the cause too, and the original error's message is the argv.
    // oxlint-disable-next-line eslint/preserve-caught-error -- dropping the cause is the point
    throw new Error(describeGogFailure(args, error, account));
  }
}

// Every failure path, the roster fetch included, has to land on one line of stderr and a non-zero
// exit: this runs as a cron job whose output is what the Control UI's Cron tab shows.
async function main(): Promise<void> {
  const summary = await syncVectorRoster({
    roster: await fetchRoster(),
    gog,
    dryRun: process.argv.includes("--dry-run"),
    strict: process.argv.includes("--strict"),
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    const cause = error instanceof Error && error.cause ? ` (${String(error.cause)})` : "";
    console.error(`${error instanceof Error ? error.message : String(error)}${cause}`);
    process.exit(1);
  });
}

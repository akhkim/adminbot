// Answers, read-only, which DCS username each person should get under the lab's hierarchy --
// `firstname`, then `lastname`, then `{first initial}{lastname}` -- against everything that can
// hold one: apps0's /etc/passwd (the department's whole namespace, read live over ssh, exactly as
// the service does before it writes a row) and, with --sheet, the DCS roster sheet.
//
// For a filing the sysadmin bounced as "duplicate username": run it with the person's roster name,
// take the name it prints, and correct the sheet row by hand. Nothing here writes anywhere.
//
// On Aurora, from the release dir:
//
//   set -a; . ~/.config/jinesis-adminbot/adminbot.env; set +a
//   node --import tsx scripts/adminbot-dcs-username-check.ts --sheet "Ada Lovelace" "Alan Turing"
//
// --passwd <file> reads a passwd copy instead of SSHing (for a host without access to apps0), and
// --sheet adds the usernames on the sheet ADMINBOT_DCS_ROSTER_SHEET_ID names. Exits 1 when somebody
// has no free candidate, so the caller knows a name has to be agreed with the sysadmin by hand.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createApps0PasswdReader,
  parseApps0PasswdUsernames,
} from "../extensions/adminbot/src/connectors/apps0-passwd.js";
import { readGogSheetRows } from "../extensions/adminbot/src/connectors/gog.js";
import { dcsRosterSheetUsernames } from "../extensions/adminbot/src/workflows/onboarding/dcs-roster-entry.js";
import {
  dcsUsernameCandidates,
  normalizeDcsUsername,
} from "../extensions/adminbot/src/workflows/onboarding/dcs-roster-sheet.js";

export type DcsUsernameVerdict = {
  name: string;
  candidates: { username: string; takenBy: string[] }[];
  /** The first candidate nobody holds, or undefined when all of them are taken. */
  choice?: string;
};

/** Each person's candidates, best first, with who holds each and the first free one. */
export function checkDcsUsernames(
  names: readonly string[],
  holders: Record<string, Iterable<string>>,
): DcsUsernameVerdict[] {
  const taken = Object.entries(holders).map(
    ([source, entries]) => [source, new Set([...entries].map(normalizeDcsUsername))] as const,
  );
  return names.map((name) => {
    const candidates = dcsUsernameCandidates(name).map((username) => ({
      username,
      takenBy: taken.filter(([, set]) => set.has(username)).map(([source]) => source),
    }));
    const choice = candidates.find((candidate) => candidate.takenBy.length === 0)?.username;
    return { name, candidates, ...(choice ? { choice } : {}) };
  });
}

function parseArgs(argv: readonly string[]) {
  const names: string[] = [];
  let passwd: string | undefined;
  let sheet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--passwd") {
      passwd = argv[++index];
    } else if (arg === "--sheet") {
      sheet = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else if (arg.trim()) {
      names.push(arg.trim());
    }
  }
  return { names, passwd, sheet };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.names.length === 0) {
    console.error('usage: adminbot-dcs-username-check.ts [--sheet] [--passwd FILE] "Full Name"...');
    return 2;
  }
  const host = process.env.ADMINBOT_DCS_PASSWD_HOST?.trim();
  const holders: Record<string, Iterable<string>> = {
    apps0: args.passwd
      ? parseApps0PasswdUsernames(readFileSync(args.passwd, "utf8"))
      : await createApps0PasswdReader(host ? { host } : {})(),
  };
  if (args.sheet) {
    const sheetId = process.env.ADMINBOT_DCS_ROSTER_SHEET_ID?.trim();
    if (!sheetId) {
      throw new Error("--sheet needs ADMINBOT_DCS_ROSTER_SHEET_ID in the environment");
    }
    holders.sheet = dcsRosterSheetUsernames(await readGogSheetRows(sheetId));
  }
  let unresolved = 0;
  for (const verdict of checkDcsUsernames(args.names, holders)) {
    if (verdict.candidates.length === 0) {
      unresolved += 1;
      console.log(`${verdict.name}: no candidate can be built (needs a first and a last name)`);
      continue;
    }
    const detail = verdict.candidates
      .map(({ username, takenBy }) =>
        takenBy.length ? `${username} (taken: ${takenBy.join(", ")})` : `${username} (free)`,
      )
      .join(", ");
    if (!verdict.choice) {
      unresolved += 1;
    }
    console.log(
      `${verdict.name}: ${verdict.choice ?? "ALL TAKEN -- agree a name with the sysadmin"}  [${detail}]`,
    );
  }
  return unresolved > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(
        `dcs username check: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    },
  );
}

// Repoints seeded logins at the lab address the Slack member export knows for them.
//
//   node --import tsx scripts/adminbot-apply-slack-emails.ts <db> <slack-export.csv> [--write]
//
// adminbot-seed-member-passwords.ts could only use what the roster itself held, which for most
// people was whatever address the sheet import happened to land on. The Slack export is the better
// source: column Q ("Slack email") is the address that person actually signs in to Slack with, and
// column E ("Email for correspondence") is the stated fallback when Slack has none. Q wins even
// when it is not a lab address -- the rule is "what the export says", not "prefer a domain".
//
// Only credentials that still verify against the seeded password are touched. That is the whole
// safety rule: a member who has claimed their account chose both their password and the address
// they sign in with, and moving that address out from under them would lock them out of an account
// they are already using. Anyone who has changed their password is left exactly as they are.
//
// The old address is kept, not dropped: it moves to correspondence_email when that column is empty,
// so a personal address that only ever existed in `email` survives the swap.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  ADMINBOT_SEEDED_PORTAL_PASSWORD,
  verifyPassword,
} from "../extensions/adminbot/src/workflows/identity/auth.ts";

const SEEDED_PASSWORD = ADMINBOT_SEEDED_PORTAL_PASSWORD;
const CS_DOMAIN = "@cs.toronto.edu";
// Columns are found by header text, not position, so an inserted column upstream cannot silently
// shift which field is read. Q first, then E.
const SLACK_EMAIL_HEADER = "Slack email";
const CORRESPONDENCE_HEADER =
  "Email for correspondence (the more professional the better)";
const SLACK_ID_HEADER = "Slack ID";

/** Minimal RFC-4180 reader: quoted fields, doubled quotes, embedded commas and newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

type Export = {
  name: string;
  slackId: string;
  email: string;
  source: "Q" | "E";
};

function readExport(path: string): {
  bySlackId: Map<string, Export>;
  byName: Map<string, Export>;
} {
  const rows = parseCsv(fs.readFileSync(path, "utf8").replace(/^﻿/u, ""));
  const header = rows[0] ?? [];
  const emailAt = header.indexOf(SLACK_EMAIL_HEADER);
  const correspondenceAt = header.indexOf(CORRESPONDENCE_HEADER);
  const slackAt = header.indexOf(SLACK_ID_HEADER);
  if (emailAt < 0 || slackAt < 0) {
    throw new Error(
      `export is missing "${SLACK_EMAIL_HEADER}" or "${SLACK_ID_HEADER}" columns`,
    );
  }
  if (correspondenceAt < 0) {
    throw new Error(`export is missing "${CORRESPONDENCE_HEADER}" column`);
  }
  const bySlackId = new Map<string, Export>();
  const byName = new Map<string, Export>();
  for (const row of rows.slice(1)) {
    const name = (row[0] ?? "").trim();
    const slackEmail = (row[emailAt] ?? "").trim().toLowerCase();
    const correspondence = (row[correspondenceAt] ?? "").trim().toLowerCase();
    const email = slackEmail || correspondence;
    const slackId = (row[slackAt] ?? "").trim();
    if (!name || !email) {
      continue;
    }
    const entry: Export = {
      name,
      slackId,
      email,
      source: slackEmail ? "Q" : "E",
    };
    if (slackId) {
      bySlackId.set(slackId, entry);
    }
    // First row wins: the export lists a person once, and a later blank-ish duplicate should not
    // overwrite a good match.
    if (!byName.has(normalizeName(name))) {
      byName.set(normalizeName(name), entry);
    }
  }
  return { bySlackId, byName };
}

function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const [databasePath, csvPath] = args.filter((arg) => !arg.startsWith("--"));
  if (!databasePath || !csvPath) {
    throw new Error(
      "usage: adminbot-apply-slack-emails.ts <db> <slack-export.csv> [--write]",
    );
  }

  const { bySlackId, byName } = readExport(csvPath);
  const db = new DatabaseSync(databasePath);

  const credentials = db
    .prepare(
      "SELECT member_id, email, password_scrypt FROM adminbot_member_credentials",
    )
    .all() as unknown as Array<{
    member_id: string;
    email: string;
    password_scrypt: string;
  }>;
  const members = new Map(
    (
      db
        .prepare("SELECT id, payload_json FROM adminbot_lab_members")
        .all() as unknown as Array<{
        id: string;
        payload_json: string;
      }>
    ).map((row) => [
      row.id,
      JSON.parse(row.payload_json) as Record<string, unknown>,
    ]),
  );

  type Change = {
    memberId: string;
    name: string;
    from: string;
    to: string;
    source?: "Q" | "E";
  };
  const changes: Change[] = [];
  const claimedSkips: Change[] = [];
  const collisions: string[] = [];

  // Every address currently spoken for, not just the claimed ones. A seeded credential that this
  // run leaves alone still owns its address, and `email` is UNIQUE -- an earlier version only
  // checked claimed logins, so a second roster record pointing at an address a *seeded* one
  // already held would reach the INSERT and roll the whole transaction back.
  const takenEmails = new Set(
    credentials.map((credential) => credential.email.toLowerCase()),
  );

  for (const credential of credentials) {
    const member = members.get(credential.member_id);
    if (!member) {
      continue;
    }
    const name =
      typeof member.name === "string" ? member.name : credential.member_id;
    const match =
      bySlackId.get(String(member.slack_user_id ?? "")) ??
      byName.get(normalizeName(name));
    const target = match?.email;
    if (!target) {
      continue;
    }
    const current = credential.email.toLowerCase();
    if (current === target) {
      continue;
    }
    const change = {
      memberId: credential.member_id,
      name,
      from: current,
      to: target,
      source: match?.source,
    };
    // Still holding the password the seed set means nobody has signed in and made this login
    // theirs yet, which is the only case where moving the address is safe.
    if (!verifyPassword(credential.password_scrypt, SEEDED_PASSWORD)) {
      claimedSkips.push(change);
      continue;
    }
    // The address this record is moving off is about to be free, so it does not block anything.
    const stillTaken = new Set(takenEmails);
    for (const other of changes) {
      stillTaken.delete(other.from);
      stillTaken.add(other.to);
    }
    stillTaken.delete(current);
    if (stillTaken.has(target)) {
      // Two roster records resolving to one address is the duplicate-person case again. The email
      // column is UNIQUE, so the second one cannot be written; it is reported instead.
      collisions.push(
        `${name} [${credential.member_id}] -> ${target} (held by another record)`,
      );
      continue;
    }
    changes.push(change);
  }

  console.log(`database: ${databasePath}`);
  console.log(`export:   ${csvPath}`);
  const demotions = changes.filter(
    (change) =>
      change.from.endsWith(CS_DOMAIN) && !change.to.endsWith(CS_DOMAIN),
  );
  console.log(`logins to repoint from the export: ${changes.length}`);
  console.log(
    `  from column Q: ${changes.filter((c) => c.source === "Q").length}`,
  );
  console.log(
    `  from column E: ${changes.filter((c) => c.source === "E").length}\n`,
  );
  for (const change of changes) {
    // A move off a lab address is flagged rather than hidden: it is what the export says, but it
    // is the one direction someone is likely to have meant the other way round.
    const note = demotions.includes(change)
      ? "  !! leaves a cs.toronto.edu address"
      : "";
    console.log(
      `  ${change.name.padEnd(30)} ${change.from}  ->  ${change.to}  [${change.source}]${note}`,
    );
  }
  if (claimedSkips.length) {
    console.log(
      `\nleft alone (password already changed, so the account is in use):`,
    );
    for (const skip of claimedSkips) {
      console.log(
        `  ${skip.name.padEnd(30)} ${skip.from}  (export says ${skip.to})`,
      );
    }
  }
  if (collisions.length) {
    console.log(
      `\nnot applied (two records want one address -- merge them on the roster):`,
    );
    for (const collision of collisions) {
      console.log(`  ${collision}`);
    }
  }
  if (!write) {
    console.log("\nDry run. Re-run with --write to commit.");
    db.close();
    return;
  }

  const now = new Date().toISOString();
  const updateCredential = db.prepare(
    "UPDATE adminbot_member_credentials SET email = ?, updated_at = ? WHERE member_id = ?",
  );
  const updateMember = db.prepare(
    "UPDATE adminbot_lab_members SET payload_json = ?, updated_at = ? WHERE id = ?",
  );
  db.exec("BEGIN");
  try {
    for (const change of changes) {
      const member = members.get(change.memberId)!;
      // The roster's own `email` is the login identity the profile page shows, so the two move
      // together; leaving them different would show a member an address they cannot sign in with.
      const previous =
        typeof member.email === "string" ? member.email.trim() : "";
      if (previous && !member.correspondence_email) {
        member.correspondence_email = previous;
      }
      member.email = change.to;
      updateCredential.run(change.to, now, change.memberId);
      updateMember.run(JSON.stringify(member), now, change.memberId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(`\nRepointed ${changes.length} logins.`);
  db.close();
}

main();

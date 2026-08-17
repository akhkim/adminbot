// Creates roster records for people who are in the Slack member export but not on the roster.
//
//   node --import tsx scripts/adminbot-create-members-from-export.ts <db> <slack-export.csv> [--write]
//
// Dry run by default. `--write` is the only thing that commits.
//
// This is the counterpart to adminbot-import-member-sheet.ts, which deliberately never creates
// anyone: that script fills blanks on members who already exist and reports unmatched rows,
// because admission normally goes through registration approval. Creating from the export is a
// one-off backfill of people who have been in the lab's Slack channels all along without ever
// having a record, and it is why this lives in its own script rather than as a flag on that one.
//
// Records are thin on purpose. Most of these rows carry only a name, a Slack id and an address;
// the columns that would fill a profile (research interests, LinkedIn, CV, joined month) are empty
// for nearly all of them. A missing field is left missing rather than guessed, and the member can
// fill it in from their own profile page.
//
// Column mapping and value normalization are imported from the sheet importer rather than
// restated, so both paths put a hand-typed cell into the same shape the service accepts.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  FIELD_BY_COLUMN,
  LIST_FIELDS,
  normalizeSheetValue,
  parseCsv,
} from "./adminbot-import-member-sheet.ts";

// The roster's own convention for people imported from this export: 70 of the 88 already on it are
// plain members, including most whose Member Type cell is blank. Governance can raise or lower it
// per person afterwards; inventing a subgroup taxonomy here would be a new convention, not a
// backfill.
const DEFAULT_PRIVILEGE = "member";
const NAME_COLUMN = 0;
const SLACK_EMAIL_HEADER = "Slack email";
const CORRESPONDENCE_HEADER = "Email for correspondence (the more professional the better)";
const SLACK_ID_HEADER = "Slack ID";
const MEMBER_TYPE_HEADER = "Member Type";

function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Matches the ids already on the roster: accent-folded, lowercase, hyphen-joined. */
function slugify(name: string): string {
  const slug = normalizeName(name).replace(/\s+/gu, "-");
  return slug || "member";
}

function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const [databasePath, csvPath] = args.filter((arg) => !arg.startsWith("--"));
  if (!databasePath || !csvPath) {
    throw new Error(
      "usage: adminbot-create-members-from-export.ts <db> <slack-export.csv> [--write]",
    );
  }

  const rows = parseCsv(fs.readFileSync(csvPath, "utf8").replace(/^﻿/u, ""));
  const header = rows[0] ?? [];
  const columnAt = new Map(header.map((name, index) => [name, index]));
  const slackEmailAt = columnAt.get(SLACK_EMAIL_HEADER);
  const correspondenceAt = columnAt.get(CORRESPONDENCE_HEADER);
  const slackIdAt = columnAt.get(SLACK_ID_HEADER);
  if (slackEmailAt === undefined || correspondenceAt === undefined || slackIdAt === undefined) {
    throw new Error("export is missing the Slack email, correspondence or Slack ID column");
  }

  const db = new DatabaseSync(databasePath);
  const existing = (
    db.prepare("SELECT id, payload_json FROM adminbot_lab_members").all() as unknown as Array<{
      id: string;
      payload_json: string;
    }>
  ).map((row) => ({ id: row.id, member: JSON.parse(row.payload_json) as Record<string, unknown> }));
  const takenIds = new Set(existing.map((row) => row.id));
  const rosterSlack = new Set(
    existing.map((row) => String(row.member.slack_user_id ?? "").trim()).filter(Boolean),
  );
  const rosterNames = new Set(existing.map((row) => normalizeName(String(row.member.name ?? ""))));
  const rosterEmails = new Set(
    existing.map((row) => String(row.member.email ?? "").trim().toLowerCase()).filter(Boolean),
  );

  type Created = { id: string; member: Record<string, unknown>; fields: number };
  const created: Created[] = [];
  const createdNames = new Set<string>();
  const skips: string[] = [];

  for (const row of rows.slice(1)) {
    const name = (row[NAME_COLUMN] ?? "").trim();
    if (!name) {
      continue;
    }
    const slackId = (row[slackIdAt] ?? "").trim();
    if (slackId && rosterSlack.has(slackId)) {
      continue;
    }
    if (rosterNames.has(normalizeName(name))) {
      // Either already on the roster (the ordinary case, silent) or a second export row for
      // someone this run just created -- one person with two Slack accounts. That one is worth
      // saying out loud, because the row carries an address the kept record does not have.
      if (createdNames.has(normalizeName(name))) {
        const other = (row[slackEmailAt] ?? "").trim() || (row[correspondenceAt] ?? "").trim();
        skips.push(
          `${name}: second export row (slack ${slackId || "-"}${other ? `, ${other}` : ""}) -- one record kept`,
        );
      }
      continue;
    }
    // Q first, E second -- the same rule the login emails follow.
    const email =
      (row[slackEmailAt] ?? "").trim().toLowerCase() ||
      (row[correspondenceAt] ?? "").trim().toLowerCase();

    const member: Record<string, unknown> = { name, privilege_level: DEFAULT_PRIVILEGE };
    if (email) {
      if (rosterEmails.has(email)) {
        // The roster already knows this address under a different name, so creating a second
        // record would split one person in two. Reported rather than guessed at.
        skips.push(`${name}: ${email} already belongs to another roster record`);
        continue;
      }
      member.email = email;
      rosterEmails.add(email);
    }
    for (const [column, field] of FIELD_BY_COLUMN) {
      const at = columnAt.get(column);
      if (at === undefined) {
        continue;
      }
      const value = normalizeSheetValue(field, row[at] ?? "");
      if (value === undefined) {
        continue;
      }
      member[field] = LIST_FIELDS.has(field)
        ? value
            .split(/[,;\n]/u)
            .map((entry) => entry.trim())
            .filter(Boolean)
        : value;
    }
    // Where the record came from, in the one free-text field the roster keeps. The Member Type
    // cell has no first-class home -- privilege_level is governance-owned and is not taken from a
    // spreadsheet -- so it is recorded here for whoever reviews these afterwards.
    const memberType = (row[columnAt.get(MEMBER_TYPE_HEADER) ?? -1] ?? "").trim();
    member.notes = [
      "Created from the Slack member export.",
      memberType ? `Member Type: ${memberType}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    let id = slugify(name);
    for (let suffix = 2; takenIds.has(id); suffix += 1) {
      id = `${slugify(name)}-${suffix}`;
    }
    takenIds.add(id);
    if (slackId) {
      rosterSlack.add(slackId);
    }
    rosterNames.add(normalizeName(name));
    createdNames.add(normalizeName(name));
    created.push({ id, member, fields: Object.keys(member).length });
  }

  console.log(`database: ${databasePath}`);
  console.log(`export:   ${csvPath}`);
  console.log(`roster records to create: ${created.length}`);
  console.log(`  with an email (so they can be given a login): ${created.filter((row) => row.member.email).length}\n`);
  for (const row of created) {
    console.log(
      `  ${row.id.padEnd(28)} ${String(row.member.email ?? "(no email)").padEnd(34)} ${row.fields} fields`,
    );
  }
  if (skips.length) {
    console.log(`\nskipped:`);
    for (const skip of skips) {
      console.log(`  ${skip}`);
    }
  }
  if (!write) {
    console.log("\nDry run. Re-run with --write to commit.");
    db.close();
    return;
  }

  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO adminbot_lab_members (id, privilege_level, updated_at, payload_json) VALUES (?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    for (const row of created) {
      insert.run(row.id, DEFAULT_PRIVILEGE, now, JSON.stringify({ id: row.id, ...row.member }));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(`\nCreated ${created.length} roster records.`);
  db.close();
}

main();

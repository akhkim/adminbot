// Imports the lab's MemberList spreadsheet into the roster.
//
//   node --import tsx scripts/adminbot-import-member-sheet.ts <file.csv> [--apply] [--base-url URL]
//
// Dry run unless --apply is passed: it prints exactly what would change and writes nothing. This
// touches every member record on the roster, so seeing the plan first is the point.
//
// Matching is by name, because the sheet has no login email -- its two address columns are the
// correspondence address and the calendar Google account, and neither is reliably the identity a
// member signs in with. Names are compared case- and whitespace-insensitively. A row that matches
// no roster member is reported and skipped rather than creating anyone: admission goes through
// registration approval, and inventing members from a spreadsheet would route around it.
//
// Never overwrites. A field the roster already holds is left alone and reported as a conflict when
// the sheet disagrees, so an import can only ever fill blanks. Re-running is therefore safe.
import fs from "node:fs";

type Row = Record<string, string>;

// Sheet column -> roster field. Graduated month and Access level are omitted deliberately: both
// are empty for every row in the current export, so there is nothing to carry.
const FIELD_BY_COLUMN: Array<[string, string]> = [
  ["Joined month", "joined_month"],
  ["Location", "location"],
  ["Email for correspondence (the more professional the better)", "correspondence_email"],
  ["Twitter", "twitter_url"],
  ["Gmail for calendar", "calendar_email"],
  ["WhatsApp", "whatsapp"],
  ["OpenReview", "openreview_id"],
  ["GitHub", "github_url"],
  ["LinkedIn", "linkedin_url"],
  ["Personal website", "personal_website"],
  ["LessWrong", "lesswrong_url"],
  ["Research interests", "research_topics"],
  ["Any other notes", "notes"],
];

const LIST_FIELDS = new Set(["research_topics"]);

/** Minimal RFC4180 reader: the sheet quotes any cell containing a comma or newline. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const normalizeName = (value: string) => value.trim().replaceAll(/\s+/gu, " ").toLowerCase();

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith("--"));
  const apply = args.includes("--apply");
  const baseUrl =
    args[args.indexOf("--base-url") + 1]?.startsWith("http") && args.includes("--base-url")
      ? args[args.indexOf("--base-url") + 1]
      : "http://127.0.0.1:8765";
  if (!file) {
    throw new Error("usage: adminbot-import-member-sheet.ts <file.csv> [--apply]");
  }

  const table = parseCsv(fs.readFileSync(file, "utf8"));
  const header = (table[0] ?? []).map((cell) => cell.trim().replace(/^﻿/u, ""));
  const rows: Row[] = table
    .slice(1)
    .filter((cells) => cells.some((cell) => cell.trim()))
    .map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""])));

  void run({ rows, header, apply, baseUrl });
}

async function run(params: {
  rows: Row[];
  header: string[];
  apply: boolean;
  baseUrl: string;
}): Promise<void> {
  // Same convention as adminbot-vector-roster-sync.ts and the cron scripts.
  const token = process.env.ADMINBOT_SERVICE_TOKEN;
  if (!token) {
    throw new Error("ADMINBOT_SERVICE_TOKEN is not set");
  }
  const response = await fetch(`${params.baseUrl}/lab/members`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`could not read the roster: ${response.status}`);
  }
  const roster =
    ((await response.json()) as { members?: Array<Record<string, unknown>> }).members ?? [];
  const byName = new Map(roster.map((m) => [normalizeName(String(m.name ?? "")), m]));

  const nameColumn = params.header[0] ?? "";
  let matched = 0;
  const unmatched: string[] = [];
  const conflicts: string[] = [];
  const plans: Array<{ id: string; name: string; patch: Record<string, unknown> }> = [];

  for (const row of params.rows) {
    const name = (row[nameColumn] ?? "").trim();
    const member = byName.get(normalizeName(name));
    if (!member) {
      unmatched.push(name);
      continue;
    }
    matched += 1;
    const patch: Record<string, unknown> = {};
    for (const [column, field] of FIELD_BY_COLUMN) {
      const raw = (row[column] ?? "").trim();
      if (!raw) {
        continue;
      }
      const existing = member[field];
      const alreadySet = Array.isArray(existing)
        ? existing.some(Boolean)
        : String(existing ?? "").trim() !== "";
      if (alreadySet) {
        const current = Array.isArray(existing) ? existing.join(", ") : String(existing);
        if (normalizeName(current) !== normalizeName(raw)) {
          conflicts.push(`${name} · ${field}: roster "${current}" vs sheet "${raw}"`);
        }
        continue;
      }
      patch[field] = LIST_FIELDS.has(field)
        ? raw
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : raw;
    }
    if (Object.keys(patch).length > 0) {
      plans.push({ id: String(member.id), name, patch });
    }
  }

  const fields = plans.reduce((sum, plan) => sum + Object.keys(plan.patch).length, 0);
  console.log(`sheet rows      : ${params.rows.length}`);
  console.log(`matched by name : ${matched}`);
  console.log(`would fill      : ${fields} blank fields across ${plans.length} members`);
  console.log(`conflicts       : ${conflicts.length} (roster kept, sheet ignored)`);
  if (unmatched.length) {
    console.log(`\nno roster member for ${unmatched.length} row(s) — skipped, never created:`);
    for (const name of unmatched) {
      console.log(`  ${name}`);
    }
  }
  if (conflicts.length) {
    console.log(`\nconflicts (roster value wins):`);
    for (const line of conflicts.slice(0, 20)) {
      console.log(`  ${line}`);
    }
    if (conflicts.length > 20) {
      console.log(`  ... and ${conflicts.length - 20} more`);
    }
  }

  if (!params.apply) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to write the ${fields} fields.`);
    return;
  }

  let written = 0;
  for (const plan of plans) {
    const result = await fetch(`${params.baseUrl}/lab/members/${encodeURIComponent(plan.id)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(plan.patch),
    });
    if (!result.ok) {
      console.error(`  failed ${plan.name}: ${result.status} ${await result.text()}`);
      continue;
    }
    written += 1;
  }
  console.log(`\napplied to ${written}/${plans.length} members`);
}

main();

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
import { fileURLToPath } from "node:url";

type Row = Record<string, string>;

// Sheet column -> roster field.
//
// Omitted deliberately:
//   Graduated month, Access level -- still empty for every row in the export, nothing to carry.
//     Access level is governance-owned besides, and is never taken from a self-service source.
//   Any other notes -- not carried onto the roster at all; the profile has no free-text notes
//     field for it to land in.
//   Slack email -- no field on the record. The Slack directory sync already matches members to
//     Slack by email and is the live source for that link, so a sheet copy would only go stale.
export const FIELD_BY_COLUMN: Array<[string, string]> = [
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
  // Fills a blank only, like every other column here. The Slack directory sync is the live source
  // and wins wherever it has already resolved someone.
  ["Slack ID", "slack_user_id"],
  ["Profile photo", "avatar_url"],
  ["Channels", "slack_channels"],
];

export const LIST_FIELDS = new Set(["research_topics", "slack_channels"]);

/**
 * The sheet is filled in by hand, so a column holds whatever shape each person typed: a bare
 * GitHub username next to a full profile URL, an OpenReview id with or without its leading tilde,
 * a Twitter handle with or without the @. The service validates strictly and rejects the *whole*
 * member on the first bad field, so one loosely-typed cell used to cost that person every other
 * value in their row.
 *
 * These put each column into the one shape the service accepts. Anything that still cannot be
 * rescued is dropped and reported rather than sent, so a single unusable cell never blocks the
 * rest of a member's import.
 */
export function normalizeSheetValue(field: string, raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }
  switch (field) {
    case "github_url":
      return asProfileUrl(
        value,
        "https://github.com/",
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u,
      );
    case "twitter_url":
      // Handles arrive as "name", "@name", or a full link; the service wants x.com/<handle>.
      return asProfileUrl(value.replace(/^@/u, ""), "https://x.com/", /^[A-Za-z0-9_]{1,15}$/u);
    case "linkedin_url":
      return asProfileUrl(value, "https://www.linkedin.com/in/", /^[A-Za-z0-9\-_%]+$/u);
    case "openreview_id": {
      const id = value.startsWith("~") ? value : `~${value}`;
      // Mirrors OPENREVIEW_ID in extensions/adminbot/src/kernel/service.ts -- hyphens and
      // non-ASCII letters are ordinary in real ids ("~Tung-Yu_Wu1", "~Emilia_Wiśnios1").
      return /^~\p{L}[\p{L}\p{N}_.-]*[0-9]$/u.test(id) ? id : undefined;
    }
    case "personal_website":
    case "lesswrong_url":
    case "avatar_url":
      return asFreeUrl(value);
    default:
      return value;
  }
}

/** A bare handle becomes a profile URL; a full URL is kept only if it already validates. */
function asProfileUrl(value: string, prefix: string, handle: RegExp): string | undefined {
  if (handle.test(value)) {
    return `${prefix}${value}`;
  }
  const url = asFreeUrl(value);
  if (!url) {
    return undefined;
  }
  // A full link the service would reject anyway (wrong host, no username) is worth dropping here,
  // where it costs one field, rather than failing the member's whole row at the service.
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.replace(/\/+$/u, "").split("/").pop() ?? "";
    return handle.test(last) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Adds the scheme a bare domain is missing; returns undefined for anything still not a URL. */
function asFreeUrl(value: string): string | undefined {
  // http is upgraded rather than rejected: the service requires https, and a member typing the
  // scheme by hand is not making a statement about transport security.
  const candidate = /^https?:\/\//u.test(value)
    ? value.replace(/^http:\/\//u, "https://")
    : `https://${value}`;
  try {
    const parsed = new URL(candidate);
    // Rules out prose typed into a link column ("WIP", "n/a"): a host with no dot is not a site.
    return parsed.protocol === "https:" && parsed.hostname.includes(".") ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** Minimal RFC4180 reader: the sheet quotes any cell containing a comma or newline. */
export function parseCsv(text: string): string[][] {
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
  const dropped: string[] = [];
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
        // Compare the *normalized* sheet value, not the raw cell. The roster holds what a previous
        // run wrote -- "https://github.com/ada" -- while the sheet still says "ada", and reporting
        // those as disagreeing buries the handful of real conflicts under a hundred that only
        // differ by the normalization this script performed itself.
        const candidate = LIST_FIELDS.has(field) ? raw : (normalizeSheetValue(field, raw) ?? raw);
        if (normalizeName(current) !== normalizeName(candidate)) {
          conflicts.push(`${name} · ${field}: roster "${current}" vs sheet "${raw}"`);
        }
        continue;
      }
      if (LIST_FIELDS.has(field)) {
        patch[field] = raw
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        continue;
      }
      const value = normalizeSheetValue(field, raw);
      if (value === undefined) {
        // Unusable as typed. Dropping the one cell keeps the rest of this member's row importable;
        // sending it would have the service reject every field they have.
        dropped.push(`${name} · ${field}: "${raw}"`);
        continue;
      }
      patch[field] = value;
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
  console.log(`unusable cells  : ${dropped.length} (dropped, rest of the row still imported)`);
  if (unmatched.length) {
    console.log(`\nno roster member for ${unmatched.length} row(s) — skipped, never created:`);
    for (const name of unmatched) {
      console.log(`  ${name}`);
    }
  }
  if (dropped.length) {
    console.log(`\n${dropped.length} cell(s) the service would reject — dropped, not sent:`);
    for (const line of dropped.slice(0, 40)) {
      console.log(`  ${line}`);
    }
    if (dropped.length > 40) {
      console.log(`  … and ${dropped.length - 40} more`);
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

// Runs only when this file is the entrypoint. It also exports its column mapping and value
// normalizers, which adminbot-create-members-from-export.ts imports -- without this guard, that
// import would run a whole roster import as a side effect.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

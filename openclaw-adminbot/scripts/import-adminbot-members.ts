import fs from "node:fs";
import path from "node:path";
import { createAdminBotSqliteService } from "../extensions/adminbot/src/service-sqlite.js";
import type { AdminBotLabMemberInput } from "../extensions/adminbot/src/contracts.js";

type CsvRow = Record<string, string>;

type ImportOptions = {
  csvPath: string;
  databasePath: string;
};

const NOTE_FIELDS = [
  "Joined month",
  "Location",
  "Gmail for calendar",
  "WhatsApp",
  "Twitter",
  "OpenReview",
  "GitHub",
  "LinkedIn",
  "Personal website",
  "LessWrong",
  "Research interests",
  "Any other notes",
] as const;

function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = parseCsv(fs.readFileSync(options.csvPath, "utf8"));
  const usedIds = new Set<string>();
  const members = rows.map((row, index) => toMember(row, index, usedIds));
  const { service, close } = createAdminBotSqliteService({
    databasePath: options.databasePath,
    auditRetentionDays: 30,
  });
  try {
    for (const member of members) {
      const result = service.upsertLabMember(member);
      if (!result.ok) {
        throw new Error(`failed to import ${member.id}: ${result.error.message}`);
      }
    }
    const listed = service.listLabMembers();
    if (!listed.ok) {
      throw new Error(listed.error.message);
    }
    console.log(
      `Imported ${members.length} AdminBot members into ${path.relative(process.cwd(), options.databasePath) || options.databasePath}.`,
    );
    console.log(`Member list now has ${listed.payload.members.length} records.`);
  } finally {
    close();
  }
}

function parseArgs(args: string[]): ImportOptions {
  let csvPath: string | undefined;
  let databasePath = "state/adminbot.sqlite";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--csv" && value) {
      csvPath = value;
      index += 1;
      continue;
    }
    if (arg === "--database" && value) {
      databasePath = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!csvPath) {
    throw new Error("usage: node --import tsx scripts/import-adminbot-members.ts --csv <path> [--database <path>]");
  }
  return {
    csvPath: path.resolve(csvPath),
    databasePath: path.resolve(databasePath),
  };
}

function toMember(row: CsvRow, index: number, usedIds: Set<string>): AdminBotLabMemberInput {
  const name = required(row.Name, `row ${index + 1} Name`);
  return {
    id: memberId(name, row.Email, index, usedIds),
    name,
    ...(normalize(row.Email) ? { email: normalize(row.Email) } : {}),
    notes: memberNotes(row),
  };
}

function memberId(
  name: string,
  email: string | undefined,
  index: number,
  usedIds: Set<string>,
): string {
  const base = slug(name) || slug(email?.split("@")[0] ?? "") || `member-${index + 1}`;
  let candidate = base;
  for (let suffix = 2; usedIds.has(candidate); suffix += 1) {
    candidate = `${base}-${suffix}`;
  }
  usedIds.add(candidate);
  return candidate;
}

function memberNotes(row: CsvRow): string {
  const lines = ["Imported from Jinesis Contact/Paper member CSV."];
  for (const field of NOTE_FIELDS) {
    const value = normalize(row[field]);
    if (value) {
      lines.push(`${field}: ${value}`);
    }
  }
  return lines.join("\n");
}

function required(value: string | undefined, label: string): string {
  const normalized = normalize(value);
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function normalize(value: string | undefined): string {
  return value?.trim() ?? "";
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function parseCsv(input: string): CsvRow[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }
  if (field || row.length > 0) {
    row.push(field.replace(/\r$/u, ""));
    rows.push(row);
  }
  const [headers, ...records] = rows;
  if (!headers) {
    return [];
  }
  return records
    .filter((record) => record.some((entry) => entry.trim()))
    .map((record) =>
      Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])),
    );
}

main();

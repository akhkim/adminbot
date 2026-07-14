import fs from "node:fs";
import path from "node:path";
import type {
  AdminBotLabMemberInput,
  AdminBotPaperRecordInput,
} from "../extensions/adminbot/src/contracts.js";
import { createAdminBotSqliteService } from "../extensions/adminbot/src/service-sqlite.js";

type CsvRecord = Record<string, string>;

type Options = {
  studentsCsv: string;
  papersCsv?: string;
  database: string;
};

const STUDENT = {
  name: 5,
  email: 9,
  careerStage: 6,
  supervision: 7,
  location: 8,
  website: 10,
  countryOfResidence: 13,
  countryOfOrigin: 14,
  affiliation: 15,
  major: 16,
  notes: 17,
  startDate: 18,
  endDate: 19,
  researchTopic: 20,
  publication: 21,
  nextCareerStage: 22,
  nextNextCareerStage: 26,
  nextNextCareerStageStartingTime: 27,
} as const;

const PAPER_LINKS = [
  ["overleaf", "overleaf_edit_url"],
  ["Paper", "submission_url"],
  ["Code", "github_url"],
  ["Slides", "google_slides_url"],
  ["Poster", "poster_url"],
  ["twitter_draft", "twitter_draft_url"],
  ["Twitter Thread", "twitter_draft_url"],
] as const;

const STUDENT_NOTE_FIELDS = [
  ["Career stage", STUDENT.careerStage],
  ["Supervision", STUDENT.supervision],
  ["Location", STUDENT.location],
  ["Country of residence", STUDENT.countryOfResidence],
  ["Country of origin", STUDENT.countryOfOrigin],
  ["Affiliation", STUDENT.affiliation],
  ["Major", STUDENT.major],
  ["Member notes", STUDENT.notes],
  ["Start date of affiliation", STUDENT.startDate],
  ["End date of affiliation", STUDENT.endDate],
  ["Research topic", STUDENT.researchTopic],
  ["Publication", STUDENT.publication],
  ["Next career stage", STUDENT.nextCareerStage],
  ["Next next career stage", STUDENT.nextNextCareerStage],
  ["Next next career stage starting time", STUDENT.nextNextCareerStageStartingTime],
  ["Personal website", STUDENT.website],
] as const;

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { service, close } = createAdminBotSqliteService({
    databasePath: options.database,
    auditRetentionDays: 30,
  });
  try {
    const memberCount = importMembers(service, options.studentsCsv);
    const paperCount = options.papersCsv ? importPapers(service, options.papersCsv) : 0;
    const members = service.listLabMembers();
    const papers = service.listPapers();
    if (!members.ok || !papers.ok) {
      throw new Error("failed to read imported AdminBot records");
    }
    console.log(
      "Imported " +
        memberCount +
        " member profiles and " +
        paperCount +
        " ongoing papers into " +
        options.database +
        ".",
    );
    console.log(
      "Member list now has " +
        members.payload.members.length +
        " records; paper list now has " +
        papers.payload.papers.length +
        " records.",
    );
  } finally {
    close();
  }
}

function parseArgs(args: string[]): Options {
  let studentsCsv: string | undefined;
  let papersCsv: string | undefined;
  let database = "state/adminbot.sqlite";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if ((arg === "--students-csv" || arg === "--csv") && value) {
      studentsCsv = path.resolve(value);
      index += 1;
    } else if ((arg === "--papers-csv" || arg === "--papers") && value) {
      papersCsv = path.resolve(value);
      index += 1;
    } else if (arg === "--database" && value) {
      database = path.resolve(value);
      index += 1;
    } else {
      throw new Error("unknown argument: " + arg);
    }
  }
  if (!studentsCsv) {
    throw new Error(
      "usage: node --import tsx scripts/import-adminbot-data.ts " +
        "--students-csv <path> [--papers-csv <path>] [--database <path>]",
    );
  }
  return {
    studentsCsv,
    ...(papersCsv ? { papersCsv } : {}),
    database,
  };
}

function importMembers(
  service: ReturnType<typeof createAdminBotSqliteService>["service"],
  csvPath: string,
): number {
  const rows = parseCsvRows(fs.readFileSync(csvPath, "utf8"));
  const profiles = new Map<
    string,
    { name: string; email?: string; fields: Record<string, string> }
  >();
  for (const row of rows.slice(1)) {
    const name = clean(row[STUDENT.name]);
    if (!name) {
      continue;
    }
    const fields = Object.fromEntries(
      STUDENT_NOTE_FIELDS.map(([label, index]) => [label, clean(row[index])] as const).filter(
        ([, value]) => value,
      ),
    );
    const profile = {
      name,
      ...(clean(row[STUDENT.email]) ? { email: clean(row[STUDENT.email]) } : {}),
      fields,
    };
    const key = normalizeName(name);
    const previous = profiles.get(key);
    profiles.set(key, previous ? mergeProfile(previous, profile) : profile);
  }

  const existingResult = service.listLabMembers();
  if (!existingResult.ok) {
    throw new Error(existingResult.error.message);
  }
  const existingMembers = existingResult.payload.members;
  const usedIds = new Set(existingMembers.map((member) => member.id));
  let imported = 0;
  for (const profile of profiles.values()) {
    const existing = findMember(existingMembers, profile.name);
    const id = existing?.id ?? uniqueId(profile.name, usedIds);
    const notes = mergeNotes(existing?.notes, profile.fields);
    const member: AdminBotLabMemberInput = {
      id,
      name: existing?.name ?? profile.name,
      ...(profile.email || existing?.email ? { email: profile.email ?? existing?.email } : {}),
      ...(notes ? { notes } : {}),
    };
    const result = service.upsertLabMember(member);
    if (!result.ok) {
      throw new Error("failed to import member " + profile.name + ": " + result.error.message);
    }
    imported += 1;
  }
  return imported;
}

function importPapers(
  service: ReturnType<typeof createAdminBotSqliteService>["service"],
  csvPath: string,
): number {
  const records = parseCsvRecords(fs.readFileSync(csvPath, "utf8"));
  const existingResult = service.listPapers();
  if (!existingResult.ok) {
    throw new Error(existingResult.error.message);
  }
  const existingPapers = existingResult.payload.papers;
  const usedIds = new Set(existingPapers.map((paper) => paper.id));
  let imported = 0;
  for (const row of records) {
    const title = clean(row.Title);
    const authors = clean(row.Authors)
      .split(",")
      .map((author) => author.replace(/[\u2020*]/gu, "").trim())
      .filter(Boolean);
    if (!title || authors.length === 0 || !isOngoing(row)) {
      continue;
    }
    const links = paperLinks(row);
    const record: AdminBotPaperRecordInput = {
      id:
        existingPapers.find((paper) => normalizeName(paper.title) === normalizeName(title))?.id ??
        uniqueId(title, usedIds),
      title,
      authors,
      current_step: clean(row["Under Review"])
        ? "submission"
        : urlOnly(row.overleaf)
          ? "overleaf_writing"
          : "brainstorming_docs",
      ...(links ? { artifacts: links } : {}),
      notes: paperNotes(row),
    };
    const result = service.upsertPaper(record);
    if (!result.ok) {
      throw new Error("failed to import paper " + title + ": " + result.error.message);
    }
    imported += 1;
  }
  return imported;
}

function mergeProfile<T extends { fields: Record<string, string>; email?: string }>(
  left: T,
  right: T,
): T {
  const fields = { ...left.fields };
  for (const [key, value] of Object.entries(right.fields)) {
    fields[key] = mergeValue(fields[key], value);
  }
  return {
    ...left,
    ...(mergeValue(left.email, right.email) ? { email: mergeValue(left.email, right.email) } : {}),
    fields,
  };
}

function mergeNotes(
  existing: string | undefined,
  additions: Record<string, string>,
): string | undefined {
  const keys = new Set(Object.keys(additions).map((key) => key.toLowerCase()));
  const lines = (existing ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !keys.has(noteKey(line)));
  for (const [key, value] of Object.entries(additions)) {
    lines.push(key + ": " + value);
  }
  const source = "Source: Quick-Start Survey for Research Mentees of Zhijing Jin";
  if (!lines.includes(source)) {
    lines.unshift(source);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function findMember(
  members: Array<{ id: string; name: string; email?: string; notes?: string }>,
  name: string,
): { id: string; name: string; email?: string; notes?: string } | undefined {
  const target = nameTokens(name);
  return members.find((member) => {
    const candidate = nameTokens(member.name);
    const overlap = [...target].filter((token) => candidate.has(token));
    return (
      normalizeName(member.name) === normalizeName(name) ||
      overlap.length >= 2 ||
      (target.size === 1 && overlap.length === 1 && candidate.size === 1)
    );
  });
}

function paperLinks(
  row: CsvRecord,
): NonNullable<AdminBotPaperRecordInput["artifacts"]> | undefined {
  const links: NonNullable<AdminBotPaperRecordInput["artifacts"]> = {};
  for (const [column, key] of PAPER_LINKS) {
    const value = urlOnly(row[column]);
    if (value) {
      links[key] = value;
    }
  }
  const arxiv = [row.Paper, row.HTML].map(urlOnly).find((value) => value?.includes("arxiv.org"));
  if (arxiv) {
    links.arxiv_url = arxiv;
  }
  return Object.keys(links).length > 0 ? links : undefined;
}

function paperNotes(row: CsvRecord): string | undefined {
  const fields = [
    ["Year", row.Year],
    ["Venue", row.Venue],
    ["Status", clean(row["Under Review"]) || "Planning"],
    ["Topic", row.topic],
    ["Contribution statement", row["Contribution statement"]],
  ]
    .map(([key, value]) => [key, clean(value)] as const)
    .filter(([, value]) => value);
  return fields.map(([key, value]) => key + ": " + value).join("\n") || undefined;
}

function isOngoing(row: CsvRecord): boolean {
  const year = Number.parseInt(clean(row.Year), 10);
  return (
    Boolean(clean(row["Under Review"])) ||
    (!clean(row.Venue) && Number.isFinite(year) && year >= 2025)
  );
}

function uniqueId(value: string, usedIds: Set<string>): string {
  const base = slug(value) || "record";
  let candidate = base;
  for (let suffix = 2; usedIds.has(candidate); suffix += 1) {
    candidate = base + "-" + suffix;
  }
  usedIds.add(candidate);
  return candidate;
}

function parseCsvRecords(input: string): CsvRecord[] {
  const rows = parseCsvRows(input);
  const headers = uniqueHeaders(rows[0] ?? []);
  return rows
    .slice(1)
    .filter((row) => row.some((value) => clean(value)))
    .map((row) => Object.fromEntries(headers.map((key, index) => [key, row[index] ?? ""])));
}

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
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
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length > 0) {
    row.push(field.replace(/\r$/u, ""));
    rows.push(row);
  }
  return rows;
}

function uniqueHeaders(headers: string[]): string[] {
  const counts = new Map<string, number>();
  return headers.map((header, index) => {
    const base = clean(header) || "column_" + (index + 1);
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : base + " (" + count + ")";
  });
}

function mergeValue(left: string | undefined, right: string | undefined): string {
  const first = clean(left);
  const second = clean(right);
  if (!first) return second;
  if (!second || first === second) return first;
  return first + " / " + second;
}

function nameTokens(name: string): Set<string> {
  return new Set(normalizeName(name).split(" ").filter(Boolean));
}

function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function slug(name: string): string {
  return normalizeName(name).replace(/\s+/gu, "-");
}

function noteKey(line: string): string {
  return line.split(":", 1)[0]?.trim().toLowerCase() ?? "";
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function urlOnly(value: string | undefined): string | undefined {
  const normalized = clean(value);
  return /^https?:\/\//u.test(normalized) ? normalized : undefined;
}

main();

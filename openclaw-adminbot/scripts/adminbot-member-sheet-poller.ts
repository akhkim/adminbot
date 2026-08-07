#!/usr/bin/env tsx
// Imports explicitly sheet-owned member profile fields through the AdminBot HTTP boundary.
//
// The sheet is not an authorization surface: this poller cannot create/delete members or change
// email, privilege, status, collaborator subgroup, or access. The service principal enforces the
// same restriction again, so a future spreadsheet/parser mistake still cannot grant access.
import type { AdminBotLabMember } from "../extensions/adminbot/src/contracts.js";
import { readGogSheetRows } from "../extensions/adminbot/src/gog-executor.js";

type EditableMemberField =
  | "name"
  | "slack_user_id"
  | "role"
  | "research_branch"
  | "research_topics"
  | "projects"
  | "hours_per_week"
  | "location"
  | "affiliation"
  | "timezone"
  | "personal_website"
  | "openreview_id"
  | "notes"
  | "availability_doc_url";

type MemberPatch = Partial<Pick<AdminBotLabMember, EditableMemberField>>;

type ParsedMemberRow = {
  memberId: string;
  patch: MemberPatch;
  rowNumber: number;
};

type MemberSheetSummary = {
  spreadsheet_id: string;
  range: string;
  rows_seen: number;
  unchanged: number;
  updated: number;
  updated_member_ids: string[];
  ignored_headers: string[];
  dry_run: boolean;
  polled_at: string;
};

type PollOptions = {
  spreadsheetId: string;
  range: string;
  serviceBaseUrl: string;
  serviceToken: string;
  dryRun?: boolean;
  readRows?: (spreadsheetId: string, range: string) => Promise<string[][]>;
  fetchImpl?: typeof fetch;
};

const ID_HEADERS = new Set(["adminbotid", "memberid"]);
const FIELD_BY_HEADER = new Map<string, EditableMemberField>([
  ["name", "name"],
  ["slackuserid", "slack_user_id"],
  ["role", "role"],
  ["researchbranch", "research_branch"],
  ["researchtopics", "research_topics"],
  ["projects", "projects"],
  ["hoursperweek", "hours_per_week"],
  ["location", "location"],
  ["affiliation", "affiliation"],
  ["timezone", "timezone"],
  ["personalwebsite", "personal_website"],
  ["openreviewid", "openreview_id"],
  ["notes", "notes"],
  ["availabilitydocurl", "availability_doc_url"],
]);

export async function pollMemberSheet(options: PollOptions): Promise<MemberSheetSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const readRows =
    options.readRows ??
    ((spreadsheetId: string, range: string) => readGogSheetRows(spreadsheetId, { range }));
  const [matrix, members] = await Promise.all([
    readRows(options.spreadsheetId, options.range),
    fetchMembers(options.serviceBaseUrl, options.serviceToken, fetchImpl),
  ]);
  const parsed = parseMemberSheet(matrix);
  const membersById = new Map(members.map((member) => [member.id, member]));
  const unknown = parsed.rows.filter((row) => !membersById.has(row.memberId));
  if (unknown.length > 0) {
    throw new Error(
      `sheet contains unknown AdminBot member ids: ${unknown
        .map((row) => `${row.memberId} (row ${row.rowNumber})`)
        .join(", ")}`,
    );
  }

  const updates = parsed.rows.flatMap((row) => {
    const current = membersById.get(row.memberId);
    if (!current) {
      return [];
    }
    const patch = changedPatch(current, row.patch);
    return Object.keys(patch).length > 0 ? [{ memberId: row.memberId, patch }] : [];
  });

  if (!options.dryRun) {
    for (const update of updates) {
      await updateMember(
        options.serviceBaseUrl,
        options.serviceToken,
        update.memberId,
        update.patch,
        fetchImpl,
      );
    }
  }

  return {
    spreadsheet_id: options.spreadsheetId,
    range: options.range,
    rows_seen: parsed.rows.length,
    unchanged: parsed.rows.length - updates.length,
    updated: updates.length,
    updated_member_ids: updates.map((update) => update.memberId),
    ignored_headers: parsed.ignoredHeaders,
    dry_run: options.dryRun === true,
    polled_at: new Date().toISOString(),
  };
}

export function parseMemberSheet(matrix: string[][]): {
  rows: ParsedMemberRow[];
  ignoredHeaders: string[];
} {
  const [headerRow, ...dataRows] = matrix;
  if (!headerRow) {
    throw new Error("member sheet is empty");
  }
  const normalizedHeaders = headerRow.map(normalizeHeader);
  const duplicateHeaders = normalizedHeaders.filter(
    (header, index) => header && normalizedHeaders.indexOf(header) !== index,
  );
  if (duplicateHeaders.length > 0) {
    throw new Error(
      `member sheet has duplicate headers: ${[...new Set(duplicateHeaders)].join(", ")}`,
    );
  }
  const idColumn = normalizedHeaders.findIndex((header) => ID_HEADERS.has(header));
  if (idColumn < 0) {
    throw new Error('member sheet requires an "AdminBot ID" column');
  }
  const editableColumns = normalizedHeaders.flatMap((header, index) => {
    const field = FIELD_BY_HEADER.get(header);
    return field ? [{ field, index }] : [];
  });
  if (editableColumns.length === 0) {
    throw new Error("member sheet has no supported editable columns");
  }
  const ignoredHeaders = headerRow
    .filter((header, index) => {
      const normalized = normalizedHeaders[index] ?? "";
      return normalized && !ID_HEADERS.has(normalized) && !FIELD_BY_HEADER.has(normalized);
    })
    .map((header) => header.trim());

  const rows: ParsedMemberRow[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < dataRows.length; index += 1) {
    const row = dataRows[index] ?? [];
    const rowNumber = index + 2;
    if (row.every((cell) => !cell.trim())) {
      continue;
    }
    const memberId = row[idColumn]?.trim() ?? "";
    if (!memberId) {
      throw new Error(`member sheet row ${rowNumber} is missing AdminBot ID`);
    }
    if (seenIds.has(memberId)) {
      throw new Error(`member sheet has duplicate AdminBot ID ${memberId}`);
    }
    seenIds.add(memberId);
    const patch: MemberPatch = {};
    for (const column of editableColumns) {
      const raw = row[column.index]?.trim() ?? "";
      // Blank cells mean "leave the database value alone". This prevents a partially populated
      // sheet, truncated API response, or accidental row clear from erasing profile information.
      if (!raw) {
        continue;
      }
      assignParsedCell(patch, column.field, raw, rowNumber);
    }
    rows.push({ memberId, patch, rowNumber });
  }
  return { rows, ignoredHeaders: ignoredHeaders.filter((header) => header) };
}

function assignParsedCell(
  patch: MemberPatch,
  field: EditableMemberField,
  value: string,
  rowNumber: number,
): void {
  if (field === "research_topics" || field === "projects") {
    patch[field] = value
      .split(/[;,\n]/u)
      .map((entry) => entry.trim())
      .filter(Boolean);
    return;
  }
  if (field === "hours_per_week") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 168) {
      throw new Error(`member sheet row ${rowNumber} has invalid Hours Per Week`);
    }
    patch.hours_per_week = parsed;
    return;
  }
  (patch as Record<string, unknown>)[field] = value;
}

function changedPatch(current: AdminBotLabMember, requested: MemberPatch): MemberPatch {
  const changed: MemberPatch = {};
  for (const [field, value] of Object.entries(requested) as Array<
    [EditableMemberField, MemberPatch[EditableMemberField]]
  >) {
    if (!sameValue(current[field], value)) {
      (changed as Record<string, unknown>)[field] = value;
    }
  }
  return changed;
}

function sameValue(left: unknown, right: unknown): boolean {
  return Array.isArray(left) || Array.isArray(right)
    ? JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
    : left === right;
}

async function fetchMembers(
  serviceBaseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<AdminBotLabMember[]> {
  const response = await fetchImpl(new URL("/lab/members", serviceBaseUrl), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`GET /lab/members failed: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as { members?: unknown };
  if (!Array.isArray(payload.members)) {
    throw new Error("GET /lab/members returned an invalid member list");
  }
  return payload.members as AdminBotLabMember[];
}

async function updateMember(
  serviceBaseUrl: string,
  token: string,
  memberId: string,
  patch: MemberPatch,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(
    new URL(`/lab/members/${encodeURIComponent(memberId)}`, serviceBaseUrl),
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(patch),
    },
  );
  if (!response.ok) {
    throw new Error(
      `PUT /lab/members/${memberId} failed: ${response.status} ${response.statusText}`,
    );
  }
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function loopbackServiceBaseUrl(): string {
  const configured = process.env.ADMINBOT_SERVICE_BASE_URL?.trim();
  const port = process.env.ADMINBOT_PORT?.trim() || "8765";
  const value = configured || `http://127.0.0.1:${port}`;
  const url = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname)) {
    throw new Error("ADMINBOT_SERVICE_BASE_URL must be loopback");
  }
  return url.toString();
}

async function main(): Promise<void> {
  const summary = await pollMemberSheet({
    spreadsheetId: requiredEnv("ADMINBOT_MEMBER_SHEET_ID"),
    range: requiredEnv("ADMINBOT_MEMBER_SHEET_RANGE"),
    serviceBaseUrl: loopbackServiceBaseUrl(),
    serviceToken: requiredEnv("ADMINBOT_SERVICE_TOKEN"),
    dryRun: process.argv.includes("--dry-run"),
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

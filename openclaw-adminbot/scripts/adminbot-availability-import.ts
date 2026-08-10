// Run with: node --import tsx scripts/adminbot-availability-import.ts --dry-run
//
// No shebang on purpose: this module's helpers are imported by test/scripts, and a shebang breaks
// Vite's import analysis in that lane. Same shape as scripts/import-adminbot-members.ts.
//
// Reads each member's linked planning doc from Drive and fills in their availability/time_off rows.
// Members link the doc themselves under My profile (availability_doc_url) and correct whatever the
// extraction gets wrong in the same panel, so this importer is a prefill, never the authority.

import type {
  AdminBotAvailabilityRow,
  AdminBotLabMember,
  AdminBotTimeOffRow,
} from "../extensions/adminbot/src/contracts/actions.js";
import { createAdminBotSqliteService } from "../extensions/adminbot/src/persistence/sqlite.js";
import {
  exportGoogleDoc,
  googleDocId,
} from "../extensions/adminbot/src/workflows/calendar/source.js";
import { AdminBotEmailModel, type ModelAvailability } from "./adminbot-email-model.js";

type ImportOptions = {
  databasePath: string;
  memberId?: string;
  dryRun: boolean;
  force: boolean;
  referenceDate: string;
};

type MemberOutcome = {
  memberId: string;
  name: string;
  status: "imported" | "would-import" | "skipped" | "failed";
  detail: string;
  unresolved: string[];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function parseArgs(argv: string[]): ImportOptions {
  const options: ImportOptions = {
    databasePath: process.env.ADMINBOT_DB_PATH ?? "",
    dryRun: false,
    force: false,
    referenceDate: new Date().toISOString().slice(0, 10),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--db") {
      options.databasePath = next();
    } else if (arg === "--member") {
      options.memberId = next();
    } else if (arg === "--reference-date") {
      options.referenceDate = next();
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.databasePath) {
    throw new Error("--db is required (or set ADMINBOT_DB_PATH)");
  }
  if (!ISO_DATE.test(options.referenceDate)) {
    throw new Error("--reference-date must be YYYY-MM-DD");
  }
  return options;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: adminbot-availability-import.ts [options]",
      "",
      "  --db <path>              AdminBot sqlite path (default: $ADMINBOT_DB_PATH)",
      "  --member <id>            Import one member instead of everyone with a linked doc",
      "  --reference-date <date>  Anchor for relative dates in the doc (default: today)",
      "  --dry-run                Print what would be written, change nothing",
      "  --force                  Overwrite a schedule the member already has rows for",
      "",
    ].join("\n"),
  );
}

// Default is to never clobber a schedule someone already filled in: an extraction is a guess, a
// hand-entered row is not. --force is the explicit opt-in for a re-import.
export function shouldSkip(member: AdminBotLabMember, force: boolean): string | undefined {
  if (!String(member.availability_doc_url ?? "").trim()) {
    return "no availability doc linked";
  }
  const existing = (member.availability?.length ?? 0) + (member.time_off?.length ?? 0);
  if (existing > 0 && !force) {
    return `already has ${existing} schedule rows (use --force to overwrite)`;
  }
  return undefined;
}

// The model is constrained to the right shape but not to the server's bounds, and it emits null for
// absent notes where the contract wants the key absent. Normalising here keeps the row that reaches
// updateOwnProfile a plain contract row, so validation failures read as data problems.
export function toAvailabilityRows(extracted: ModelAvailability): AdminBotAvailabilityRow[] {
  const rows: AdminBotAvailabilityRow[] = [];
  for (const row of extracted.availability) {
    if (!ISO_DATE.test(row.start) || !ISO_DATE.test(row.end)) {
      continue;
    }
    const normalized: AdminBotAvailabilityRow = {
      start: row.start,
      end: row.end,
      // Docs express effort in days and halves, so a converted value can land on a fraction.
      hours_per_week: Math.round(row.hours_per_week * 10) / 10,
    };
    const project = row.project.trim();
    if (project) {
      normalized.project = project;
    }
    const note = row.note?.trim();
    if (note) {
      normalized.note = note;
    }
    rows.push(normalized);
  }
  return rows;
}

export function toTimeOffRows(extracted: ModelAvailability): AdminBotTimeOffRow[] {
  const rows: AdminBotTimeOffRow[] = [];
  for (const row of extracted.time_off) {
    if (!ISO_DATE.test(row.start) || !ISO_DATE.test(row.end)) {
      continue;
    }
    const normalized: AdminBotTimeOffRow = {
      start: row.start,
      end: row.end,
      kind: row.kind,
      availability: row.availability,
    };
    const note = row.note?.trim();
    if (note) {
      normalized.note = note;
    }
    rows.push(normalized);
  }
  return rows;
}

function describe(availability: AdminBotAvailabilityRow[], timeOff: AdminBotTimeOffRow[]): string {
  const lines = availability.map(
    (row) =>
      `    ${row.start} → ${row.end}  ${String(row.hours_per_week).padStart(5)}h/wk  ${
        row.project ?? "(term baseline)"
      }${row.note ? `  — ${row.note}` : ""}`,
  );
  const offLines = timeOff.map(
    (row) =>
      `    ${row.start} → ${row.end}  ${row.kind} (${row.availability})${
        row.note ? `  — ${row.note}` : ""
      }`,
  );
  return [
    `  availability (${availability.length}):`,
    ...(lines.length ? lines : ["    none"]),
    `  time off (${timeOff.length}):`,
    ...(offLines.length ? offLines : ["    none"]),
  ].join("\n");
}

async function importMember(
  member: AdminBotLabMember,
  model: AdminBotEmailModel,
  service: ReturnType<typeof createAdminBotSqliteService>["service"],
  options: ImportOptions,
): Promise<MemberOutcome> {
  const base = { memberId: member.id, name: member.name, unresolved: [] as string[] };
  const skip = shouldSkip(member, options.force);
  if (skip) {
    return { ...base, status: "skipped", detail: skip };
  }
  const url = String(member.availability_doc_url).trim();
  const docId = googleDocId(url);
  if (!docId) {
    // Drive files that are not Docs (a Sheet, an uploaded PDF) have no txt export path here.
    return { ...base, status: "failed", detail: `not a Google Doc URL: ${url}` };
  }
  const docText = await exportGoogleDoc(docId);
  if (!docText.trim()) {
    return {
      ...base,
      status: "failed",
      detail: "doc exported empty — is it shared with the AdminBot account?",
    };
  }
  const extracted = await model.availability(docText, options.referenceDate);
  const availability = toAvailabilityRows(extracted);
  const timeOff = toTimeOffRows(extracted);
  const unresolved = extracted.unresolved;
  if (!availability.length && !timeOff.length) {
    return { ...base, status: "failed", detail: "nothing extractable in the doc", unresolved };
  }
  if (options.dryRun) {
    return {
      ...base,
      status: "would-import",
      detail: `\n${describe(availability, timeOff)}`,
      unresolved,
    };
  }
  // updateOwnProfile is the same whitelisted, validated write the member's own save goes through,
  // so the server stays the single authority on what a valid schedule is.
  const result = service.updateOwnProfile(member.id, { availability, time_off: timeOff });
  if (!result.ok) {
    return { ...base, status: "failed", detail: `rejected: ${result.error.message}`, unresolved };
  }
  return {
    ...base,
    status: "imported",
    detail: `${availability.length} commitments, ${timeOff.length} time-off entries`,
    unresolved,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { service, close } = createAdminBotSqliteService({
    databasePath: options.databasePath,
    auditRetentionDays: 30,
  });
  const model = new AdminBotEmailModel();
  const outcomes: MemberOutcome[] = [];
  try {
    // The service wraps reads in a response envelope; the plain array lives on the store.
    const listed = service.listLabMembers();
    if (!listed.ok) {
      throw new Error(`could not list members: ${listed.error.message}`);
    }
    const members = listed.payload.members.filter(
      (member) => !options.memberId || member.id === options.memberId,
    );
    if (options.memberId && !members.length) {
      throw new Error(`member not found: ${options.memberId}`);
    }
    for (const member of members) {
      try {
        outcomes.push(await importMember(member, model, service, options));
      } catch (error) {
        // One unreachable doc or model hiccup must not abandon the rest of the roster.
        outcomes.push({
          memberId: member.id,
          name: member.name,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
          unresolved: [],
        });
      }
    }
  } finally {
    close();
  }
  for (const outcome of outcomes) {
    process.stdout.write(`${outcome.status.padEnd(12)} ${outcome.name} — ${outcome.detail}\n`);
    for (const item of outcome.unresolved) {
      process.stdout.write(`  unresolved: ${item}\n`);
    }
  }
  const counts = outcomes.reduce<Record<string, number>>((totals, outcome) => {
    totals[outcome.status] = (totals[outcome.status] ?? 0) + 1;
    return totals;
  }, {});
  process.stdout.write(
    `\n${options.dryRun ? "dry run" : "import"}: ${
      Object.entries(counts)
        .map(([status, count]) => `${count} ${status}`)
        .join(", ") || "nothing to do"
    }\n`,
  );
  if (counts.failed) {
    process.exitCode = 1;
  }
}

// Same guard the other adminbot scripts use, so the helpers above stay importable from tests.
// Deliberately not top-level await: that form fails Vite's import analysis when a test imports
// this module, which is exactly how the helpers above are covered.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

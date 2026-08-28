// Reads the lab's contact spreadsheet, which is the source of truth for who someone is.
//
// The `[AUTO: ...]` fields in the template doc -- name, role, preferred email, projects -- are
// held on the "Full Slack Member List" tab of the lab's contact sheet, and that sheet is edited by
// hand far more often than the roster table is synced. Reading it directly at send time means the
// "one-minute check" mail confirms what the lab actually believes today, rather than whatever the
// database last imported; a records-confirmation mail quoting a stale row is worse than not
// sending, because the recipient replies "yes, correct" to the wrong thing.
//
// Nothing here can write. The sheet is a read-only input to the copy: it never creates members,
// never changes privilege, and a value it supplies is only ever a *default* the operator can
// override on the form.
import { readGogSheetRows } from "../../connectors/gog.js";

/**
 * The tab, not just the spreadsheet: the workbook carries nine tabs and only this one is the
 * per-person contact list. Sheets resolves an unqualified range against the *first* tab, which
 * here is "Paper submissions", so leaving the tab off would silently read papers as people.
 */
export const ADMINBOT_CONTACT_SHEET_DEFAULT_ID = "1ZqdaRzev6fFHxGbaAn_NDAPgv-Wi-hklHrT5jB68m68";
export const ADMINBOT_CONTACT_SHEET_DEFAULT_RANGE = "'Full Slack Member List'!A:Z";

/** One person as the sheet holds them. Every field is already trimmed; absent cells are "". */
export type AdminBotContactRecord = {
  name: string;
  email: string;
  slack_email: string;
  calendar_email: string;
  location: string;
  member_type: string;
  projects: string;
  theme: string;
  tldr: string;
  research_interests: string;
  notes: string;
};

const EMPTY: AdminBotContactRecord = {
  name: "",
  email: "",
  slack_email: "",
  calendar_email: "",
  location: "",
  member_type: "",
  projects: "",
  theme: "",
  tldr: "",
  research_interests: "",
  notes: "",
};

// Headers are matched on letters and digits only, so a renamed column keeps working as long as its
// wording does. "Email for correspondence (the more professional the better)" is the real header
// text, which is why matching is by prefix rather than by equality.
type ColumnRule = { readonly field: keyof AdminBotContactRecord; readonly prefix: string };

const COLUMN_RULES: readonly ColumnRule[] = [
  { field: "email", prefix: "emailforcorrespondence" },
  { field: "slack_email", prefix: "slackemail" },
  { field: "calendar_email", prefix: "gmailforcalendar" },
  { field: "location", prefix: "location" },
  { field: "member_type", prefix: "membertype" },
  { field: "projects", prefix: "projects" },
  { field: "theme", prefix: "theme" },
  { field: "tldr", prefix: "tldr" },
  { field: "research_interests", prefix: "researchinterests" },
  { field: "notes", prefix: "anyothernotes" },
];

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

/** Emails are compared case-insensitively and whitespace-trimmed; everything else is a mismatch. */
function normalizeEmail(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Turns the raw row matrix into records.
 *
 * The name column carries an empty header on this sheet, so it is taken positionally as column A
 * rather than by name. Rows are ragged -- Sheets drops trailing empty cells -- so every read goes
 * through `cell()` instead of indexing directly.
 */
export function parseContactSheetRows(
  matrix: readonly (readonly string[])[],
): AdminBotContactRecord[] {
  const [header, ...rows] = matrix;
  if (!header) {
    return [];
  }
  const columns = new Map<keyof AdminBotContactRecord, number>();
  header.forEach((raw, index) => {
    const normalized = normalizeHeader(raw ?? "");
    if (!normalized) {
      return;
    }
    for (const rule of COLUMN_RULES) {
      if (normalized.startsWith(rule.prefix) && !columns.has(rule.field)) {
        columns.set(rule.field, index);
      }
    }
  });

  const records: AdminBotContactRecord[] = [];
  for (const row of rows) {
    const cell = (field: keyof AdminBotContactRecord): string => {
      const index = columns.get(field);
      return index === undefined ? "" : (row[index] ?? "").trim();
    };
    const name = (row[0] ?? "").trim();
    const record: AdminBotContactRecord = {
      ...EMPTY,
      name,
      email: cell("email"),
      slack_email: cell("slack_email"),
      calendar_email: cell("calendar_email"),
      location: cell("location"),
      member_type: cell("member_type"),
      projects: cell("projects"),
      theme: cell("theme"),
      tldr: cell("tldr"),
      research_interests: cell("research_interests"),
      notes: cell("notes"),
    };
    // A row with neither a name nor any address is spacing or a note, not a person.
    if (!record.name && !record.email && !record.slack_email && !record.calendar_email) {
      continue;
    }
    records.push(record);
  }
  return records;
}

/**
 * Finds the person this email belongs to.
 *
 * All three address columns are searched because the address an onboarding mail is sent to is
 * often not the "correspondence" one: Slack invitations go to the `@cs.toronto.edu` alias and
 * calendar invitations to the personal Gmail, and either may be what the operator typed.
 */
export function findContactByEmail(
  records: readonly AdminBotContactRecord[],
  email: string | undefined,
): AdminBotContactRecord | undefined {
  const wanted = normalizeEmail(email);
  if (!wanted.includes("@")) {
    return undefined;
  }
  return records.find(
    (record) =>
      normalizeEmail(record.email) === wanted ||
      normalizeEmail(record.slack_email) === wanted ||
      normalizeEmail(record.calendar_email) === wanted,
  );
}

/**
 * The `record_*` tokens the records-confirmation mail reads back to the recipient.
 *
 * Role comes from the freeform "tldr" background line -- the template doc's touchpoint map names
 * this record as "email + tldr background", and tldr is where a description like "Professor,
 * University of X" actually lives.
 *
 * "Member Type" is deliberately NOT a fallback for it, even though it is the column that reads
 * like a role. It holds the internal tier and the privilege flags -- real rows say
 * "full, adminbot-admin, adminbot-developer" and "alumni" -- so quoting it back would tell the
 * recipient which internal bucket they are in and, worse, disclose who holds admin. The copy rule
 * that subjects never name the tier applies at least as strongly to the body.
 *
 * Empty stays empty rather than becoming a guess: the send path already refuses on a missing
 * required value and names it, and an invented role reaching a senior collaborator is exactly what
 * this mail exists to avoid.
 */
export function contactRecordValues(
  record: AdminBotContactRecord | undefined,
): Record<string, string | undefined> {
  if (!record) {
    return {};
  }
  const role = record.tldr;
  const projects = record.projects || record.theme;
  return {
    ...(record.name ? { record_name: record.name } : {}),
    ...(record.email || record.slack_email
      ? { record_email: record.email || record.slack_email }
      : {}),
    ...(role ? { record_role: role } : {}),
    ...(projects ? { record_projects: projects } : {}),
  };
}

export type AdminBotContactSheetLookup = (
  email: string,
) => Promise<AdminBotContactRecord | undefined>;

export type ContactSheetLookupOptions = {
  env?: NodeJS.ProcessEnv;
  readRows?: (spreadsheetId: string, range: string) => Promise<string[][]>;
  /** How long one read of the sheet is reused. Onboarding sends come in bursts from one tab. */
  cacheMs?: number;
  now?: () => number;
};

export function contactSheetId(env: NodeJS.ProcessEnv = process.env): string {
  return env.ADMINBOT_CONTACT_SHEET_ID?.trim() || ADMINBOT_CONTACT_SHEET_DEFAULT_ID;
}

export function contactSheetRange(env: NodeJS.ProcessEnv = process.env): string {
  return env.ADMINBOT_CONTACT_SHEET_RANGE?.trim() || ADMINBOT_CONTACT_SHEET_DEFAULT_RANGE;
}

/**
 * A lookup over the contact sheet, cached briefly and failing soft.
 *
 * Soft failure is deliberate. The sheet fills in defaults the operator may also type by hand, so
 * an unreachable sheet must degrade to "the operator supplies these" and not block onboarding
 * entirely. Anything genuinely required is still caught by the send path's missing-values check,
 * which names the fields -- so the worst case is the form asking for four values it could have
 * pre-filled.
 */
export function createContactSheetLookup(
  options: ContactSheetLookupOptions = {},
): AdminBotContactSheetLookup {
  const env = options.env ?? process.env;
  const readRows =
    options.readRows ??
    ((spreadsheetId: string, range: string) => readGogSheetRows(spreadsheetId, { range, env }));
  const cacheMs = options.cacheMs ?? 60_000;
  const now = options.now ?? Date.now;
  let cached: { at: number; records: AdminBotContactRecord[] } | undefined;

  return async (email: string) => {
    if (!normalizeEmail(email).includes("@")) {
      return undefined;
    }
    if (!cached || now() - cached.at >= cacheMs) {
      try {
        const matrix = await readRows(contactSheetId(env), contactSheetRange(env));
        cached = { at: now(), records: parseContactSheetRows(matrix) };
      } catch {
        // Keep any usable earlier read rather than dropping to "no contact data" on one blip.
        if (!cached) {
          return undefined;
        }
      }
    }
    return findContactByEmail(cached.records, email);
  };
}

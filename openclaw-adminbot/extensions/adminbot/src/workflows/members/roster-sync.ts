/**
 * The lab's member spreadsheet against the lab's database: who is on one and not the other, and
 * whose Member Type has moved.
 *
 * The spreadsheet is where membership is actually decided -- admins add a row when somebody joins
 * and edit column S when what they are changes -- and the database is what every sweep reads. They
 * drift, because keeping them together was a thing somebody had to remember to do. This closes that
 * gap for exactly two columns: the roster itself, and Member Type.
 *
 * Deliberately only those two. `member-sheet-poller.ts` already carries the profile fields, and
 * widening this to the rest of the sheet would make a spreadsheet typo able to overwrite what a
 * member typed about themselves on their own profile page.
 *
 * Pure: this decides, the service applies the record changes and proposes the access ones. Nothing
 * here reads Google, touches the store, or sends anything.
 */
import type { AdminBotLabMember } from "../../contracts/actions.js";

/** The columns this sync reads. Titles as the sheet spells them, matched case-insensitively. */
export const ROSTER_SHEET_MEMBER_TYPE_HEADER = "Member Type";
export const ROSTER_SHEET_NAME_HEADER = "Name";
/**
 * Every column that might carry an address, most authoritative first.
 *
 * A row is matched to a member by *any* of them, because the roster stores three addresses per
 * person and the sheet does not say which one a given row used. Matching on one column alone left
 * people whose Slack address differs from their correspondence address looking like new joiners.
 */
export const ROSTER_SHEET_EMAIL_HEADERS = [
  "Email for correspondence (the more professional the better)",
  "Slack email",
  "Email",
] as const;
/** Optional. When the sheet carries it, it beats every address match. */
export const ROSTER_SHEET_ID_HEADERS = ["AdminBot ID", "Member ID"] as const;

export type RosterSheetRow = {
  sheet_row: number;
  name: string;
  /** From the id column when the sheet has one. */
  member_id?: string;
  /** Every address on the row, lowercased. May be empty. */
  emails: string[];
  /** Verbatim, including its spacing and case: it is stored as the sheet spells it. */
  member_type: string;
};

export type RosterSheetParse = {
  rows: RosterSheetRow[];
  /** Rows with neither an id nor an address: nothing can be matched or created from them. */
  unidentifiable: { sheet_row: number; name: string }[];
};

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
}

/** Every address in a cell. One cell routinely holds two, comma- or newline-separated. */
function addressesIn(cell: string | undefined): string[] {
  return (cell ?? "")
    .split(/[\n,;]/u)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.includes("@"));
}

function columnFor(header: readonly string[], titles: readonly string[]): number {
  const normalized = header.map(normalizeHeader);
  for (const title of titles) {
    const index = normalized.indexOf(normalizeHeader(title));
    if (index >= 0) {
      return index;
    }
  }
  return -1;
}

/**
 * The sheet as rows this sync can reason about.
 *
 * Throws when the Member Type column is missing, and names the headers it did see. That is the one
 * failure worth stopping the whole pass for: without the column every row reads as "type cleared",
 * which is a mass revocation dressed up as a sync. A renamed tab, a truncated read and a
 * permissions error all arrive here as the same missing column, so the message has to be
 * actionable rather than just true.
 *
 * Blank rows are skipped rather than treated as departures -- the sheet has spacer rows.
 */
export function parseRosterSheet(
  header: readonly string[],
  body: readonly {
    sheetRow: number;
    cells: readonly string[];
  }[],
): RosterSheetParse {
  const typeAt = columnFor(header, [ROSTER_SHEET_MEMBER_TYPE_HEADER]);
  if (typeAt < 0) {
    throw new Error(
      `the member sheet has no "${ROSTER_SHEET_MEMBER_TYPE_HEADER}" column (saw: ${header
        .filter((title) => title.trim())
        .join(", ")})`,
    );
  }
  const nameAt = columnFor(header, [ROSTER_SHEET_NAME_HEADER]);
  const idAt = columnFor(header, ROSTER_SHEET_ID_HEADERS);
  const emailColumns = ROSTER_SHEET_EMAIL_HEADERS.map((title) => columnFor(header, [title])).filter(
    (index) => index >= 0,
  );

  const rows: RosterSheetRow[] = [];
  const unidentifiable: RosterSheetParse["unidentifiable"] = [];
  for (const row of body) {
    if (row.cells.every((cell) => !cell.trim())) {
      continue;
    }
    const name = (nameAt >= 0 ? (row.cells[nameAt] ?? "") : (row.cells[0] ?? "")).trim();
    const memberId = idAt >= 0 ? (row.cells[idAt] ?? "").trim() : "";
    const emails = [...new Set(emailColumns.flatMap((index) => addressesIn(row.cells[index])))];
    if (!memberId && emails.length === 0) {
      unidentifiable.push({ sheet_row: row.sheetRow, name });
      continue;
    }
    rows.push({
      sheet_row: row.sheetRow,
      name,
      ...(memberId ? { member_id: memberId } : {}),
      emails,
      member_type: (row.cells[typeAt] ?? "").trim(),
    });
  }
  return { rows, unidentifiable };
}

/**
 * Two Member Type cells that say the same thing.
 *
 * Token-wise and order-insensitive, because the column is a comma-separated list somebody types by
 * hand: "full, coauthor-major" and "coauthor-major,full" are one membership written two ways, and
 * treating them as a change would refile the same proposals every night forever.
 */
export function sameMemberType(left: string | undefined, right: string | undefined): boolean {
  const tokens = (value: string | undefined) =>
    [
      ...new Set(
        (value ?? "")
          .split(",")
          .map((part) => part.trim().toLowerCase())
          .filter(Boolean),
      ),
    ].toSorted();
  const a = tokens(left);
  const b = tokens(right);
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

export type RosterMemberTypeChange = {
  member_id: string;
  member_name: string;
  sheet_row: number;
  /** What the database holds. Absent when the record has never carried a type. */
  from?: string;
  /** What the sheet says. Empty string means the cell was cleared, which is not the same as absent. */
  to: string;
};

export type RosterAddition = {
  sheet_row: number;
  name: string;
  email?: string;
  member_type: string;
};

export type RosterAbsence = {
  member_id: string;
  member_name: string;
  member_type?: string;
};

export type RosterSyncPlan = {
  member_type_changes: RosterMemberTypeChange[];
  /** Sheet rows matching nobody on the roster. Reported, never created -- see the service. */
  additions: RosterAddition[];
  /** Roster members no sheet row matches. Reported only; a missing row is not a departure. */
  absent: RosterAbsence[];
  unidentifiable: RosterSheetParse["unidentifiable"];
  /** Sheet rows that matched a member and needed nothing. The denominator for the summary. */
  unchanged: number;
  /** Two sheet rows resolving to one member: a duplicate to fix on the sheet, not here. */
  duplicates: { member_id: string; sheet_rows: number[] }[];
};

function addressesOf(member: AdminBotLabMember): string[] {
  return [member.email, member.calendar_email, member.correspondence_email]
    .map((email) => (email ?? "").trim().toLowerCase())
    .filter(Boolean);
}

/**
 * What would have to change for the database to agree with the sheet.
 *
 * Matching is id first, then any address against any address. Both directions are reported: a sheet
 * row with no member is a possible joiner, a member with no sheet row is a possible leaver, and
 * neither is acted on here because both have an innocent explanation that is far more common than
 * the guilty one -- a row added before onboarding ran, and an address the sheet spells differently.
 *
 * `unchanged` counts matched rows that needed nothing, which is what makes the summary readable: a
 * pass that reports "3 changes" is only reassuring next to "and 197 rows already agreed".
 */
export function planRosterSync(params: {
  sheet: RosterSheetParse;
  members: readonly AdminBotLabMember[];
}): RosterSyncPlan {
  const { sheet, members } = params;
  const byId = new Map(members.map((member) => [member.id, member]));
  const byAddress = new Map<string, AdminBotLabMember>();
  for (const member of members) {
    for (const address of addressesOf(member)) {
      // First writer wins, as everywhere else that indexes the roster by address: two rows sharing
      // an address is a duplicate to resolve on the roster, and picking arbitrarily here would make
      // the plan depend on store ordering.
      if (!byAddress.has(address)) {
        byAddress.set(address, member);
      }
    }
  }

  const member_type_changes: RosterMemberTypeChange[] = [];
  const additions: RosterAddition[] = [];
  const matchedRows = new Map<string, number[]>();
  let unchanged = 0;

  for (const row of sheet.rows) {
    const matched =
      (row.member_id ? byId.get(row.member_id) : undefined) ??
      row.emails.map((email) => byAddress.get(email)).find(Boolean);
    if (!matched) {
      additions.push({
        sheet_row: row.sheet_row,
        name: row.name,
        ...(row.emails[0] ? { email: row.emails[0] } : {}),
        member_type: row.member_type,
      });
      continue;
    }
    const seen = matchedRows.get(matched.id) ?? [];
    matchedRows.set(matched.id, [...seen, row.sheet_row]);
    // A duplicate row is reported below and otherwise ignored: applying the second row's type over
    // the first would make the result depend on sheet order.
    if (seen.length > 0) {
      continue;
    }
    if (sameMemberType(matched.member_type, row.member_type)) {
      unchanged += 1;
      continue;
    }
    member_type_changes.push({
      member_id: matched.id,
      member_name: matched.name,
      sheet_row: row.sheet_row,
      ...(matched.member_type === undefined ? {} : { from: matched.member_type }),
      to: row.member_type,
    });
  }

  const absent: RosterAbsence[] = [];
  for (const member of members) {
    if (matchedRows.has(member.id)) {
      continue;
    }
    absent.push({
      member_id: member.id,
      member_name: member.name,
      ...(member.member_type === undefined ? {} : { member_type: member.member_type }),
    });
  }

  return {
    member_type_changes,
    additions,
    absent,
    unidentifiable: sheet.unidentifiable,
    unchanged,
    duplicates: [...matchedRows]
      .filter(([, sheetRows]) => sheetRows.length > 1)
      .map(([member_id, sheet_rows]) => ({ member_id, sheet_rows })),
  };
}

/**
 * How much of the roster a single pass may rewrite before it is treated as a bad read.
 *
 * A truncated Sheets response, a tab renamed to something the fallback also matches, or a filter
 * left on by an admin all arrive as a perfectly well-formed sheet with most of the lab missing from
 * it -- and the plan built from that would clear a hundred Member Types and revoke access from
 * everybody at once. There is no read that both looks like that and is correct: the lab does not
 * re-type a third of its roster in one night.
 *
 * A fraction rather than a count, with a floor, so it stays right for a lab of 20 and a lab of 200.
 */
export const ADMINBOT_ROSTER_SYNC_MAX_CHANGE_FRACTION = 0.25;
export const ADMINBOT_ROSTER_SYNC_MIN_CHANGES = 10;

/**
 * Why this plan must not be applied, or undefined when it is safe to.
 *
 * Checked against member-type changes only. `absent` is deliberately not counted: it is never acted
 * on, so a short read shows up there harmlessly, and folding it in would block the pass on exactly
 * the sheets that need it most -- a lab mid-onboarding always has rows the roster has not caught up
 * with.
 */
export function rosterSyncRefusal(plan: RosterSyncPlan, rosterSize: number): string | undefined {
  if (plan.member_type_changes.length === 0) {
    return undefined;
  }
  const ceiling = Math.max(
    ADMINBOT_ROSTER_SYNC_MIN_CHANGES,
    Math.ceil(rosterSize * ADMINBOT_ROSTER_SYNC_MAX_CHANGE_FRACTION),
  );
  if (plan.member_type_changes.length > ceiling) {
    return `refusing to apply ${plan.member_type_changes.length} member-type changes in one pass (ceiling ${ceiling} for a roster of ${rosterSize}) -- this is what a truncated or filtered sheet read looks like; re-run with force once the sheet has been checked`;
  }
  return undefined;
}

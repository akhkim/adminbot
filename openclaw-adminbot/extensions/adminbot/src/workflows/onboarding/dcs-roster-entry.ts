/**
 * The DCS roster sheet row a member gets when they become a full member or a major coauthor.
 *
 * The sheet is the one the department's sysadmin works from. It used to be filed only by the
 * full-member onboarding guide (`dcs-roster-sheet.ts`), positionally and with a generated password
 * in it. Two things changed. The lab asked for major coauthors to be on it too, and for a row to be
 * filed whenever somebody *becomes* one of the two -- an Add member, a sheet sweep, a Member Type
 * change on the Lab Members tab or in the spreadsheet -- rather than only when a guide happens to
 * be mailed. And the sheet's columns moved: `dcs_password` was taken off it and `UTORid` was added,
 * which made the positional writer refuse every row.
 *
 * So this row is keyed by header name, not by position. A column the sheet gains is left blank,
 * a column it loses is simply not written, and nothing here ever writes a password -- if a
 * `dcs_password` column comes back, it stays empty, because the place a credential goes is a
 * decision for whoever put the column back, not a side effect of a role change.
 */
import {
  adminBotIsAlumniMember,
  adminBotIsCoauthorMajorType,
  adminBotIsFullMemberType,
  type AdminBotLabMember,
} from "../../contracts/actions.js";
import {
  adminBotComputeAccessRegistry,
  formatComputeAccessCell,
  isAdminBotComputeAccess,
} from "../../contracts/compute-access.js";
import {
  chooseDcsUsername,
  DCS_DEFAULT_PERMISSION,
  dcsUsernameCandidates,
  normalizeDcsUsername,
} from "./dcs-roster-sheet.js";

/** The roles that put somebody on the DCS roster sheet, most-committed first. */
export type DcsRosterRole = "full" | "coauthor-major";

/**
 * Which DCS-roster role a record holds, if any.
 *
 * `full` wins over `coauthor-major` when somebody is both, for the same reason the onboarding
 * template does: the full-member setup covers the coauthor one. Alumni hold neither, whatever the
 * type column still says -- the column keeps `full` after somebody leaves, and asking the
 * sysadmin for an account for a person who has gone is the mistake the Vector sheet already made.
 */
export function dcsRosterRoleOf(member: {
  status?: string;
  member_type?: string;
}): DcsRosterRole | undefined {
  if (adminBotIsAlumniMember(member)) {
    return undefined;
  }
  if (adminBotIsFullMemberType(member.member_type)) {
    return "full";
  }
  return adminBotIsCoauthorMajorType(member.member_type) ? "coauthor-major" : undefined;
}

/**
 * The role a save moved this person into, when it moved them into one.
 *
 * "Into" is a change of role, not a change of the type string: `full` -> `full, coauthor-major`
 * is still a full member and files nothing, while `coauthor-major` -> `full` is becoming a full
 * member and does.
 */
export function dcsRosterRoleGained(
  before: { status?: string; member_type?: string },
  after: { status?: string; member_type?: string },
): DcsRosterRole | undefined {
  const next = dcsRosterRoleOf(after);
  return next && next !== dcsRosterRoleOf(before) ? next : undefined;
}

/** The sheet's columns this row fills. Anything else the header carries is left blank. */
export const DCS_ROSTER_ENTRY_COLUMNS = [
  "full_name",
  "adminbot_internal_id",
  "dcs_username",
  "non_dcs_email",
  "career_stage",
  "at_uoft_or_not",
  "permission",
  "date_of_this_row_change",
] as const;

export type DcsRosterEntryColumn = (typeof DCS_ROSTER_ENTRY_COLUMNS)[number];

/**
 * The two columns a row cannot be filed without: who it is, and the id the next filing checks for
 * a duplicate against. A header missing either is a different sheet, not a moved column.
 */
const REQUIRED_COLUMNS: readonly DcsRosterEntryColumn[] = ["full_name", "adminbot_internal_id"];

export type DcsRosterEntryValues = Record<DcsRosterEntryColumn, string>;

const DCS_ADDRESS_SUFFIX = "@cs.toronto.edu";

/** The first address on file that is not the DCS account's own, which is what the column means. */
function nonDcsEmail(member: AdminBotLabMember): string {
  return (
    [member.correspondence_email, member.email, member.calendar_email]
      .map((entry) => entry?.trim() ?? "")
      .find((entry) => entry && !entry.toLowerCase().endsWith(DCS_ADDRESS_SUFFIX)) ?? ""
  );
}

/**
 * The `permission` cell: the DCS access already granted, or the newcomer-safe default.
 *
 * Only DCS values. The member's access list can also carry Vector or Compute Canada grants, and
 * those are another sysadmin's business -- writing them here would ask this one to act on them.
 */
function permissionCell(member: AdminBotLabMember): string {
  const dcs = (member.compute_access ?? []).filter(
    (value) =>
      isAdminBotComputeAccess(value.trim()) &&
      adminBotComputeAccessRegistry[value.trim() as keyof typeof adminBotComputeAccessRegistry]
        .provider === "dcs",
  );
  return formatComputeAccessCell(dcs) || DCS_DEFAULT_PERMISSION;
}

/**
 * The row's values for one member, by column name.
 *
 * `career_stage` carries the Member Type, as the rows the guide filed always did; it is what the
 * sysadmin reads to tell a lab member from a coauthor. `dcs_username` is the stored account name
 * when there is one and blank otherwise -- the candidates travel separately, because which one is
 * free can only be answered against the sheet at the moment the row is written.
 */
export function dcsRosterEntryValues(
  member: AdminBotLabMember,
  now: Date = new Date(),
): DcsRosterEntryValues {
  const atUoft = member.at_uoft === undefined ? "" : member.at_uoft ? "yes" : "no";
  return {
    full_name: member.name.trim(),
    adminbot_internal_id: member.id,
    dcs_username: normalizeDcsUsername(member.dcs_username ?? ""),
    non_dcs_email: nonDcsEmail(member),
    career_stage: member.member_type?.trim() ?? "",
    at_uoft_or_not: atUoft,
    permission: permissionCell(member),
    date_of_this_row_change: now.toISOString().slice(0, 10),
  };
}

/** The account names to try, best first, when the member has none stored. */
export function dcsRosterUsernameCandidates(member: AdminBotLabMember): string[] {
  return member.dcs_username?.trim() ? [] : dcsUsernameCandidates(member.name);
}

function headerOf(rows: readonly (readonly string[])[]): string[] {
  return (rows[0] ?? []).map((cell) => cell.trim());
}

/**
 * The sheet row (1-based, header included) already filed for this member id, if any.
 *
 * The sheet is one row per person, so a second row for somebody already on it is a second account
 * request -- and the sysadmin's roster is keyed on what she reads, so two rows for one person is
 * two things to reconcile by hand. Compared case-insensitively because the column is typed into.
 */
export function findDcsRosterRow(
  rows: readonly (readonly string[])[],
  memberId: string,
): number | undefined {
  const at = headerOf(rows).indexOf("adminbot_internal_id");
  const wanted = memberId.trim().toLowerCase();
  if (at < 0 || !wanted) {
    return undefined;
  }
  const index = rows.findIndex(
    (row, rowIndex) => rowIndex > 0 && (row[at] ?? "").trim().toLowerCase() === wanted,
  );
  return index < 0 ? undefined : index + 1;
}

/** Every account name already on the sheet, for the "is this one taken?" check. */
export function dcsRosterSheetUsernames(rows: readonly (readonly string[])[]): string[] {
  const at = headerOf(rows).indexOf("dcs_username");
  return at < 0
    ? []
    : rows
        .slice(1)
        .map((row) => (row[at] ?? "").trim())
        .filter(Boolean);
}

/**
 * The values, laid out under the sheet's own header.
 *
 * Throws when the header lacks a column the row cannot do without, so a sheet that was swapped
 * for a different one refuses the write instead of filing a person under someone else's columns.
 * Trailing blanks are trimmed so the append carries no tail of empty strings.
 */
export function dcsRosterRowForHeader(
  rows: readonly (readonly string[])[],
  values: DcsRosterEntryValues,
): string[] {
  const header = headerOf(rows);
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new Error(
      `the DCS roster sheet has no ${missing.join(" or ")} column (its header reads ${header.join(", ") || "(empty)"}); refusing to append`,
    );
  }
  const row = header.map((column) =>
    (DCS_ROSTER_ENTRY_COLUMNS as readonly string[]).includes(column)
      ? values[column as DcsRosterEntryColumn]
      : "",
  );
  while (row.length > 1 && row.at(-1) === "") {
    row.pop();
  }
  return row;
}

/**
 * The account name to write: the stored one, else the first candidate nobody holds.
 *
 * Blank when every candidate is taken or none can be built (a one-word name). A blank cell is what
 * most of the sheet already carries for "the sysadmin picks", which is a better answer than a
 * guess that collides with somebody else's account.
 */
export function resolveDcsRosterUsername(
  values: DcsRosterEntryValues,
  candidates: readonly string[],
  taken: Iterable<string>,
): string {
  return values.dcs_username || chooseDcsUsername(candidates, taken) || "";
}

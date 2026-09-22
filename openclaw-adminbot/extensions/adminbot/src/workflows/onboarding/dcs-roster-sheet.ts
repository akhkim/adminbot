/**
 * Filing a new full member on the DCS roster sheet, which is what the lab asks the department's
 * sysadmin to act on.
 *
 * This replaces the Microsoft-Forms automation that used to live in `dcs-form.ts`. That form was
 * driven by a headless browser through selectors Microsoft could relayout without notice, it could
 * only carry First/Last/Email, and its submission was fire-and-shrug: the form hands back no
 * receipt, so "submitted" only ever meant "the click did not throw". The sheet is the same request
 * expressed as a row the sysadmin already reads, it carries every fact she needs rather than the
 * four the form had room for, and a row that landed can be read back and checked.
 *
 * One row is one account. The sheet has a single `dcs_username` and a single `dcs_password`, so
 * the "top three usernames" the lab picks from are candidates for *this* row, not three rows --
 * three rows would ask for three accounts for one person, each with a different password.
 *
 * The password here is the initial credential for the account the sysadmin creates. It is written
 * into the sheet because that is the column the sheet has and the sysadmin provisions from it, and
 * it is mailed to the member so they can sign in. It is deliberately never put in the audit log
 * (see `recordDcsRosterRowAttempt`) and never returned to any model-visible surface: the row and
 * the member's inbox are the only two places it is meant to exist.
 */

import { randomInt } from "node:crypto";

/**
 * The sheet's header row, in the order the columns appear.
 *
 * Declared once and appended against positionally. Read off the live sheet on 2026-09-20. If a
 * column is inserted, renamed or reordered on the sheet, change it here in the same commit --
 * `assertDcsRosterHeader` compares this list against the sheet's own first row before anything is
 * appended, so a drifted sheet refuses the write instead of filing a row whose password lands in
 * the career-stage column.
 */
export const DCS_ROSTER_SHEET_COLUMNS = [
  "full_name",
  "adminbot_internal_id",
  "dcs_username",
  "dcs_password",
  "non_dcs_email",
  "career_stage",
  "at_uoft_or_not",
  "permission",
  "date_of_this_row_change",
] as const;

/**
 * The domain every sponsored DCS account is minted under.
 *
 * Used to render the address a member signs in with. It is deliberately not part of the value
 * stored in `dcs_username`: see `dcsUsernameCandidates`.
 */
export const DCS_USERNAME_DOMAIN = "cs.toronto.edu";

/** The full address a bare account name corresponds to. */
export function dcsAddressOf(username: string): string {
  return `${username}@${DCS_USERNAME_DOMAIN}`;
}

/**
 * An account name as it can be compared against another.
 *
 * Strips a domain if the value carries one, then lowercases. The column is meant to hold a bare
 * name, but it is typed into by hand and one row may well arrive as a full address; comparing the
 * two spellings literally would report a taken name as free and propose a collision to the
 * sysadmin. Normalizing both sides is what makes the "is this taken?" check mean anything.
 */
export function normalizeDcsUsername(value: string): string {
  return value.trim().toLowerCase().split("@")[0] ?? "";
}

/**
 * The roster's one free-text `name`, as the separate first/last parts the username rules need.
 *
 * Split on the last run of whitespace: everything before it is the first name (which covers middle
 * names and initials), the final token is the last name.
 *
 * `undefined` when there is no last name to give, which the caller must treat as "cannot file
 * this". Moved here unchanged from the retired DCS form connector, where it existed because the
 * form answered a one-word name by putting that word in *both* fields and a real DCS account was
 * once requested for "Eric Eric". The rules below have the same failure mode -- two of the three
 * candidates are built from the last name -- so the refusal travels with them.
 *
 * Whitespace is matched as a class rather than as a literal " " for the same reason: a name pasted
 * out of Slack or Sheets can carry a non-breaking or full-width space, and against a literal space
 * "Eric Zhang" looked exactly like a mononym and was duplicated whole.
 */
export function splitDisplayName(
  name: string,
): { firstName: string; lastName: string } | undefined {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const lastName = parts.length > 1 ? parts.at(-1) : undefined;
  if (!lastName) {
    return undefined;
  }
  return { firstName: parts.slice(0, -1).join(" "), lastName };
}

/**
 * A name part as a unix account name can spell it.
 *
 * Decomposes accents away rather than dropping the letter (NFD then strip combining marks), so
 * "Bilodeau" survives as `bilodeau` and not `bildeau`. Everything that is still not an ASCII
 * letter or digit goes, which covers the hyphens and apostrophes in "O'Neill" and "Sainte-Marie"
 * -- DCS account names carry neither.
 */
export function usernamePart(value: string): string {
  return value
    .normalize("NFD")
    .replaceAll(/\p{M}+/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "");
}

/**
 * The three candidate account names the lab asks for, in the order it prefers them.
 *
 * The rules, as the lab states them: `firstname`, else `lastname`, else
 * `{first initial}{lastname}`. Deduped, because "Li Li" would otherwise offer the same string
 * twice and hand the sysadmin a choice that is not one.
 *
 * Bare names, not addresses. The rules were handed over written out as `firstname@cs.toronto.edu`,
 * which describes the address the member ends up signing in with -- but `dcs_username` is the unix
 * account DCS sponsors, the roster contract spells it bare ("e.g. akim"), the sysadmin's own roster
 * is keyed on that string, and the rows already on the sheet are bare. Writing an address into that
 * column would key her roster on a value that does not exist on her side. The address is rendered
 * where it belongs, in the mail to the member; see `dcsAddressOf`.
 *
 * Empty when the name has no last name in it, or when what survives normalization is nothing at
 * all (a name written entirely in a non-Latin script). Both are "a person has to pick this by
 * hand", not "guess something".
 */
export function dcsUsernameCandidates(name: string): string[] {
  const parts = splitDisplayName(name);
  if (!parts) {
    return [];
  }
  const first = usernamePart(parts.firstName);
  const last = usernamePart(parts.lastName);
  if (!first || !last) {
    return [];
  }
  return [...new Set([first, last, `${first.slice(0, 1)}${last}`])];
}

/**
 * The first candidate nobody already holds.
 *
 * "Taken" is judged against the usernames already on the sheet plus whatever the roster knows,
 * which is everything this side can see. It is not the department's whole account namespace -- the
 * sysadmin is still the one who finds out that `jchen@` collided with a student in another group --
 * so a chosen name is a proposal, and the two candidates it beat travel with the row so she can
 * take the next one without coming back to ask.
 *
 * Comparison runs through `normalizeDcsUsername` on both sides, so case, padding and a stray
 * full-address spelling all still match.
 */
export function chooseDcsUsername(
  candidates: readonly string[],
  taken: Iterable<string>,
): string | undefined {
  const used = new Set([...taken].map(normalizeDcsUsername).filter(Boolean));
  return candidates.find((candidate) => !used.has(normalizeDcsUsername(candidate)));
}

/**
 * The alphabet the temporary password is drawn from.
 *
 * No `0`/`O` or `1`/`l`/`I`: this string is read off a screen and typed into a terminal by someone
 * who has never had this account before, and a failed first sign-in on an ambiguous glyph costs a
 * round-trip with the sysadmin. Punctuation is left out for the same reason -- it survives a
 * spreadsheet cell badly (a leading `=` or `+` is a formula) and travels badly through the mail.
 */
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Length in characters. At ~5.8 bits each, 20 characters is ~116 bits -- far past anything that
 * matters for a credential that is meant to be changed on first sign-in, and short enough to
 * retype.
 */
const PASSWORD_LENGTH = 20;

/**
 * A fresh temporary password.
 *
 * `randomInt` rather than `randomBytes(n) % alphabet.length`: the modulo is biased whenever the
 * alphabet does not divide 256, which it does not here, and `randomInt` does the rejection
 * sampling itself. Unique per member by construction -- the point of the change that added this is
 * that every seeded account used to start on the same shared word.
 */
export function generateDcsTemporaryPassword(
  randomIndex: (max: number) => number = (max) => randomInt(max),
): string {
  let password = "";
  for (let index = 0; index < PASSWORD_LENGTH; index += 1) {
    password += PASSWORD_ALPHABET[randomIndex(PASSWORD_ALPHABET.length)];
  }
  return password;
}

/** The roster facts a row needs, as the composition root can look them up. */
export type DcsRosterMemberFacts = {
  /** AdminBot's own member id, for `adminbot_internal_id`. */
  id?: string;
  /** Free-text member type, which is what the sheet calls `career_stage`. */
  member_type?: string;
  /**
   * Whether this person holds a UofT affiliation.
   *
   * `undefined` is not `false`. The roster contract is explicit that a blank here means "we do not
   * know", and reporting that to DCS as "not at UofT" would be a claim about somebody's
   * eligibility rather than an absence of information -- so it is written as a blank cell.
   */
  at_uoft?: boolean;
  /** The address the lab writes to, which is by definition not the `@cs.toronto.edu` one. */
  correspondence_email?: string;
  /** What the lab has already granted, if anything. See contracts/compute-access.ts. */
  compute_access?: string[];
};

/**
 * What a brand-new account is asked for when nothing else says otherwise.
 *
 * The least-privileged provisioned value in the DCS vocabulary, and the one the registry marks
 * newcomer-safe: it shares no queue and no purchased machine, so granting it on day one cannot
 * cost anybody else anything. Matches the repository rule that new members default to the
 * least-privileged tier unless an explicit, authorized choice says otherwise -- an escalation is a
 * separate, deliberate row on this sheet, not a side effect of onboarding.
 */
export const DCS_DEFAULT_PERMISSION = "UofT-slack-only";

export type DcsRosterRowInput = {
  name: string;
  /** The address the onboarding mail went to. Used as `non_dcs_email` when the roster has none. */
  email: string;
  username: string;
  password: string;
  facts?: DcsRosterMemberFacts;
  /** Defaults to today. Injected so a test is not a clock. */
  now?: Date;
};

/**
 * One row, in `DCS_ROSTER_SHEET_COLUMNS` order.
 *
 * Every cell is a string because that is what the Sheets values API takes and what the sysadmin
 * reads; booleans become "yes"/"no" and an unknown becomes "", never "no".
 */
export function buildDcsRosterRow(input: DcsRosterRowInput): string[] {
  const facts = input.facts ?? {};
  const permission = facts.compute_access?.find((entry) => entry.trim()) ?? DCS_DEFAULT_PERMISSION;
  const atUoft = facts.at_uoft === undefined ? "" : facts.at_uoft ? "yes" : "no";
  const row: Record<(typeof DCS_ROSTER_SHEET_COLUMNS)[number], string> = {
    full_name: input.name.trim(),
    adminbot_internal_id: facts.id?.trim() ?? "",
    dcs_username: input.username,
    dcs_password: input.password,
    non_dcs_email: facts.correspondence_email?.trim() || input.email.trim(),
    career_stage: facts.member_type?.trim() ?? "",
    at_uoft_or_not: atUoft,
    permission,
    date_of_this_row_change: (input.now ?? new Date()).toISOString().slice(0, 10),
  };
  return DCS_ROSTER_SHEET_COLUMNS.map((column) => row[column]);
}

/**
 * Refuses a sheet whose header is not the one this module was written against.
 *
 * Positional appends are only safe while the columns are where they were. The failure this
 * prevents is silent and bad: insert one column on the sheet and every later row files a password
 * under `non_dcs_email`, in a document other people can read.
 */
export function assertDcsRosterHeader(header: readonly string[] | undefined): void {
  const actual = (header ?? [])
    .slice(0, DCS_ROSTER_SHEET_COLUMNS.length)
    .map((cell) => cell.trim());
  const matches =
    actual.length === DCS_ROSTER_SHEET_COLUMNS.length &&
    DCS_ROSTER_SHEET_COLUMNS.every((column, index) => actual[index] === column);
  if (!matches) {
    throw new Error(
      `the DCS roster sheet's columns are not the ones AdminBot writes: expected ${DCS_ROSTER_SHEET_COLUMNS.join(", ")} but found ${actual.join(", ") || "(an empty first row)"}`,
    );
  }
}

/**
 * The mail that hands a new member their account name and its temporary password.
 *
 * A fixed constant rather than one of the operator-editable onboarding templates in `emails.ts`.
 * Those exist so the tab can reword a welcome; this one carries a live credential, and the two
 * sentences that matter -- that the account does not exist yet, and that the password is to be
 * changed on first sign-in -- are not copy to be tuned. An edited template that lost them would
 * leave a shared-readable initial password standing on an account indefinitely.
 *
 * Sent as its own message rather than folded into the guide: the guide is cc'd to project leads
 * and reply-to'd elsewhere on most sends, and a credential does not belong on a thread with an
 * audience.
 */
export function dcsCredentialsEmail(params: { name: string; username: string; password: string }): {
  subject: string;
  body: string;
} {
  const firstName = splitDisplayName(params.name)?.firstName ?? params.name.trim();
  return {
    subject: "Your University of Toronto CS account request",
    body: [
      `Hi ${firstName},`,
      "",
      "We have asked the Department of Computer Science to create a CS account for you. Here is what it will be, and the temporary password it will start with:",
      "",
      `  Username: ${dcsAddressOf(params.username)}`,
      `  Temporary password: ${params.password}`,
      "",
      "The account does not exist yet — the department creates it from our request, which usually takes a few working days. You will not be able to sign in until then, so please keep this message until you can.",
      "",
      "When you do sign in for the first time, change this password immediately. It was generated for you and was sent over email, so treat it as temporary in the real sense: it is good for exactly one sign-in.",
      "",
      "If the username above is already taken, the department may give you a near variant of it instead — they will let us know, and we will pass it on.",
      "",
      "Reply to this message if anything does not work.",
    ].join("\n"),
  };
}

/** The index of `dcs_username` in a row, used to read the taken names back off the sheet. */
const USERNAME_COLUMN_INDEX = DCS_ROSTER_SHEET_COLUMNS.indexOf("dcs_username");

/** What a successful filing tells the caller. The password is included so the mail can carry it. */
export type DcsRosterRowRecord = {
  username: string;
  password: string;
  /** Every candidate considered, best first, so the sysadmin can take the next one on a collision. */
  candidates: string[];
};

export type DcsRosterRowRecorder = (params: {
  name: string;
  email: string;
}) => Promise<DcsRosterRowRecord>;

export type DcsRosterSheetOptions = {
  spreadsheetId: string;
  /** Reads the sheet, header row included. */
  readRows: (spreadsheetId: string) => Promise<string[][]>;
  /** Appends one row after the last populated one. */
  appendRows: (spreadsheetId: string, rows: string[][]) => Promise<void>;
  /** Roster facts for the person being filed, by the address the mail went to. */
  lookupMember?: (email: string) => DcsRosterMemberFacts | undefined;
  /** Usernames held by people who are not on the sheet yet. */
  rosterUsernames?: () => Iterable<string>;
  now?: () => Date;
  generatePassword?: () => string;
};

/**
 * The production recorder: read the sheet, pick a free username, append one row.
 *
 * Reads before it writes because "taken" can only be answered by what is already there, and
 * because the header check has to happen against the live sheet rather than against a copy of it
 * in this file. Throws on every failure -- a caller that has already mailed the guide decides
 * whether that is fatal, and in the send path it is not.
 */
export function createDcsRosterSheetRecorder(
  options: DcsRosterSheetOptions,
): DcsRosterRowRecorder | undefined {
  const spreadsheetId = options.spreadsheetId.trim();
  if (!spreadsheetId) {
    return undefined;
  }
  return async ({ name, email }) => {
    const candidates = dcsUsernameCandidates(name);
    if (candidates.length === 0) {
      throw new Error(
        `no DCS username can be built from "${name}" — the rules need a first and a last name. Put the full name on the roster and re-send, or file the row by hand.`,
      );
    }
    const rows = await options.readRows(spreadsheetId);
    assertDcsRosterHeader(rows[0]);
    const onSheet = rows
      .slice(1)
      .map((row) => row[USERNAME_COLUMN_INDEX] ?? "")
      .filter(Boolean);
    const username = chooseDcsUsername(candidates, [
      ...onSheet,
      ...(options.rosterUsernames?.() ?? []),
    ]);
    if (!username) {
      throw new Error(
        `all three candidate usernames for "${name}" are already taken (${candidates.join(", ")}) — pick one by hand and add the row yourself.`,
      );
    }
    const password = (options.generatePassword ?? generateDcsTemporaryPassword)();
    const row = buildDcsRosterRow({
      name,
      email,
      username,
      password,
      ...(options.lookupMember?.(email) ? { facts: options.lookupMember(email) } : {}),
      ...(options.now ? { now: options.now() } : {}),
    });
    await options.appendRows(spreadsheetId, [row]);
    return { username, password, candidates };
  };
}

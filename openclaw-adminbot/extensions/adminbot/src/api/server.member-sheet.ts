/**
 * The Membership tab's view of the lab's member spreadsheet: read it, edit it, onboard from it.
 *
 * Three jobs, deliberately separated. Reading is free and hits Google every time, because the
 * sheet is where the admins already work and a cached copy would be wrong within minutes. Editing
 * produces a `sheet.update_cells` proposal rather than a write, because the roster is what the
 * onboarding and nudge sweeps read and because Member Type and the address columns decide who can
 * reach what -- the approval card is where that gets a second pair of eyes. Onboarding produces
 * `email.send` proposals for the same reason: nothing reaches Gmail without passing the gate.
 */
import type {
  AdminBotLabMember,
  AdminBotLabMemberInput,
  AdminBotSheetValueRange,
  AdminBotStoredProposal,
} from "../contracts/actions.js";
import type { AdminBotService, AdminBotServiceResponse } from "../kernel/service.js";
import { subgroupForMemberType } from "../workflows/members/collaborator-subgroups.js";
import {
  planSheetEdits,
  type SheetCellEdit,
  toSheetGrid,
  touchesAccess,
} from "../workflows/members/member-sheet-grid.js";
import {
  parseRosterSheet,
  rosterRowForMember,
  type RosterSheetParse,
  sameMemberType,
} from "../workflows/members/roster-sync.js";
import { composeOnboardingGuide } from "../workflows/onboarding/guide.js";
import { templateForMemberType } from "../workflows/onboarding/member-type-template.js";
import { memberIdForRow } from "../workflows/onboarding/onboarding-sweep.js";
import type { NewMemberGuideStep, NewMemberOnboardingResult } from "./server.member-onboarding.js";
import type { MemberTypeChangeResult } from "./server.member-type-change.js";

export type MemberSheetSource = {
  spreadsheetId: string;
  tab: string;
  /**
   * The tab actually to read, when the deployment names it by gid rather than by title.
   *
   * A gid survives a rename and a title does not, so a deployment configured by URL asks the
   * spreadsheet what its tab is called now. Resolved once per request rather than at startup: the
   * service runs for weeks, and a tab renamed in the meantime must not need a restart. `tab` above
   * stays the fallback, so a metadata call that fails costs nothing.
   */
  resolveTab?: () => Promise<{ tab: string; gid?: number }>;
  read: (range: string) => Promise<string[][]>;
};

export type MemberSheetView = {
  spreadsheet_id: string;
  tab: string;
  /** So the tab can link to the sheet it is showing. */
  url: string;
  header: string[];
  rows: { sheet_row: number; cells: string[] }[];
  read_at: string;
};

/**
 * Reads the whole tab. Sheets caps an open-ended range at the used region, so this is not 702
 * columns -- but it was 26: `A:Z` quietly dropped everything past column Z, and the roster is 30
 * columns wide, so the grid showed a sheet four columns narrower than the one people edit.
 */
const RANGE = "A:ZZ";

function rangeFor(tab: string): string {
  return `${tab}!${RANGE}`;
}

/**
 * The tab title and link this request should use.
 *
 * Every entry point resolves before it reads, because the title also ends up in the `A1` ranges of
 * a `sheet.update_cells` proposal: resolving on the read path alone would let an edit be written
 * back to a tab under its old name.
 */
async function resolveTarget(source: MemberSheetSource): Promise<{ tab: string; url: string }> {
  const resolved = await source.resolveTab?.();
  const tab = resolved?.tab || source.tab;
  const base = `https://docs.google.com/spreadsheets/d/${source.spreadsheetId}/edit`;
  return { tab, url: resolved?.gid === undefined ? base : `${base}#gid=${resolved.gid}` };
}

export async function readMemberSheet(source: MemberSheetSource): Promise<MemberSheetView> {
  const target = await resolveTarget(source);
  const grid = toSheetGrid(await source.read(rangeFor(target.tab)));
  return {
    spreadsheet_id: source.spreadsheetId,
    tab: target.tab,
    url: target.url,
    header: grid.header,
    rows: grid.rows.map((row) => ({ sheet_row: row.sheetRow, cells: row.cells })),
    read_at: new Date().toISOString(),
  };
}

/**
 * The roster tab, parsed into the rows the nightly sync diffs against the database.
 *
 * Reads the same tab through the same source as the Membership grid -- one configuration, one
 * resolved tab title, one set of failure messages -- so a deployment cannot end up with the grid
 * showing one sheet and the sync reconciling another.
 *
 * A missing Member Type column comes back as a 422 rather than an exception, because it is the one
 * failure an admin can fix in the spreadsheet: every other read failure is Google's and is already
 * described by `describeMemberSheetReadFailure`.
 */
export async function readRosterSheet(source: MemberSheetSource): Promise<
  | { parsed: RosterSheetParse; tab: string; url: string }
  | {
      error: { status: number; message: string };
    }
> {
  const target = await resolveTarget(source);
  const grid = toSheetGrid(await source.read(rangeFor(target.tab)));
  try {
    return {
      parsed: parseRosterSheet(
        grid.header,
        grid.rows.map((row) => ({ sheetRow: row.sheetRow, cells: row.cells })),
      ),
      tab: target.tab,
      url: target.url,
    };
  } catch (error) {
    return {
      error: { status: 422, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

export type MemberSheetEditRequest = {
  edits: { sheet_row: number; column: number; value: string }[];
  /**
   * What each edited cell held when the grid was drawn, keyed "row:column".
   *
   * Optional, but the UI always sends it: without it a write against a cell somebody else changed
   * in the meantime silently reverts their work.
   */
  expected?: Record<string, string>;
};

export type MemberSheetEditResult = {
  proposal?: AdminBotStoredProposal;
  updates: AdminBotSheetValueRange[];
  conflicts: {
    sheet_row: number;
    column: number;
    header: string;
    expected: string;
    actual: string;
  }[];
  unchanged: number;
  touches_access: boolean;
};

/**
 * Turns grid edits into one approval-gated write.
 *
 * The sheet is re-read here rather than trusting what the browser last saw: the whole point of the
 * conflict check is that the tab may have been open for an hour.
 */
export async function proposeMemberSheetEdits(
  service: AdminBotService,
  source: MemberSheetSource,
  request: MemberSheetEditRequest,
  actor: string,
): Promise<MemberSheetEditResult | { error: { status: number; message: string } }> {
  const edits: SheetCellEdit[] = (request.edits ?? []).map((edit) => ({
    sheetRow: edit.sheet_row,
    column: edit.column,
    value: typeof edit.value === "string" ? edit.value : String(edit.value ?? ""),
  }));
  if (edits.length === 0) {
    return { error: { status: 400, message: "edits is required and must not be empty" } };
  }

  const target = await resolveTarget(source);
  const grid = toSheetGrid(await source.read(rangeFor(target.tab)));
  const expected = new Map(Object.entries(request.expected ?? {}));

  let plan;
  try {
    plan = planSheetEdits(target.tab, edits, grid, expected);
  } catch (error) {
    return {
      error: { status: 400, message: error instanceof Error ? error.message : String(error) },
    };
  }

  const conflicts = plan.conflicts.map((conflict) => ({
    sheet_row: conflict.sheetRow,
    column: conflict.column,
    header: grid.header[conflict.column] ?? "",
    expected: conflict.expected,
    actual: conflict.actual,
  }));
  const accessTouched = touchesAccess(grid.header, edits);

  if (plan.updates.length === 0) {
    // Nothing to write is not an error: every edit was a conflict, or a no-op. Both are answers
    // the tab has to show rather than a failed request.
    return {
      updates: [],
      conflicts,
      unchanged: plan.unchanged.length,
      touches_access: accessTouched,
    };
  }

  const cells = plan.updates.length === 1 ? "1 cell" : `${plan.updates.length} cells`;
  const created = service.createProposal({
    type: "sheet.update_cells",
    summary: `${actor}: edit ${cells} in the member roster${accessTouched ? " (includes an access column)" : ""}`,
    proposed_payload: {
      spreadsheet_id: source.spreadsheetId,
      updates: plan.updates,
      before: plan.before,
    },
  });
  if (!created.ok) {
    return { error: { status: created.status, message: created.error.message } };
  }
  return {
    proposal: created.payload,
    updates: plan.updates,
    conflicts,
    unchanged: plan.unchanged.length,
    touches_access: accessTouched,
  };
}

export type MemberSheetOnboardRequest = {
  sheet_rows: number[];
  /** Overrides the address column, for a row whose usable address is not the first one found. */
  addresses?: Record<string, string>;
  /**
   * Extra template values per sheet row, keyed by row number.
   *
   * Several onboarding mails need something the spreadsheet does not hold -- a Slack Connect
   * invite, a Drive folder, a portal password -- because those are provisioned when the mail is
   * sent rather than recorded on the roster. Rather than half-render a mail around them, a row
   * missing one is skipped with the token named, and the tab collects it and asks again.
   */
  values?: Record<string, Record<string, string>>;
};

export type MemberSheetOnboardResult = {
  created: { sheet_row: number; email: string; template_id: string; proposal_id: string }[];
  /**
   * Rows not yet on the roster, now created and given the access their Member Type grants -- the
   * same enrollment every other way onto the roster runs, including the no-mail types whose whole
   * onboarding this is.
   */
  enrolled: { sheet_row: number; member_id: string; member_type_change: MemberTypeChangeResult }[];
  /** `missing` names the template values the tab should collect before asking again. */
  skipped: { sheet_row: number; reason: string; missing?: string[] }[];
};

const NAME_HEADER = "Name";
const CORRESPONDENCE_HEADER = "Email for correspondence (the more professional the better)";
const SLACK_EMAIL_HEADER = "Slack email";
const MEMBER_TYPE_HEADER = "Member Type";

function firstAddress(cell: string | undefined): string | undefined {
  return (cell ?? "")
    .split(/[\n,;]/u)
    .map((part) => part.trim())
    .find((part) => part.includes("@"));
}

/** One row's mail, fully composed, exactly as executing the onboarding would queue it. */
export type PlannedOnboardEmail = {
  sheet_row: number;
  name: string;
  email: string;
  member_type: string;
  template_id: string;
  subject: string;
  body: string;
  reply_to: string;
};

/** A row whose Member Type the access design onboards without a mail. */
export type PlannedAccessOnly = {
  sheet_row: number;
  name: string;
  email: string;
  member_type: string;
  reason: string;
};

export type MemberSheetOnboardPreview = {
  planned: PlannedOnboardEmail[];
  access_only: PlannedAccessOnly[];
  skipped: MemberSheetOnboardResult["skipped"];
};

/**
 * Resolves each selected row to the mail it would get, queueing nothing.
 *
 * Shared by the preview route and the execution so that what the admin read is what gets queued:
 * both run this same resolution over a fresh read of the sheet, and the only thing execution adds
 * is the proposal. A row that changes between preview and confirm is therefore re-resolved at
 * confirm time -- the same freshest-read rule the edit path follows.
 */
async function planOnboardFromMemberSheet(
  source: MemberSheetSource,
  request: MemberSheetOnboardRequest,
  env: NodeJS.ProcessEnv,
): Promise<MemberSheetOnboardPreview | { error: { status: number; message: string } }> {
  const wanted = new Set(request.sheet_rows ?? []);
  if (wanted.size === 0) {
    return { error: { status: 400, message: "sheet_rows is required and must not be empty" } };
  }

  const grid = toSheetGrid(await source.read(rangeFor((await resolveTarget(source)).tab)));
  const at = (name: string): number => grid.header.indexOf(name);
  const nameAt = at(NAME_HEADER) < 0 ? 0 : at(NAME_HEADER);
  const typeAt = at(MEMBER_TYPE_HEADER);
  const corrAt = at(CORRESPONDENCE_HEADER);
  const slackAt = at(SLACK_EMAIL_HEADER);
  if (typeAt < 0) {
    return {
      error: { status: 422, message: `the sheet has no "${MEMBER_TYPE_HEADER}" column` },
    };
  }

  const planned: PlannedOnboardEmail[] = [];
  const accessOnly: PlannedAccessOnly[] = [];
  const skipped: MemberSheetOnboardResult["skipped"] = [];
  const overrides = request.addresses ?? {};

  for (const row of grid.rows) {
    if (!wanted.has(row.sheetRow)) {
      continue;
    }
    wanted.delete(row.sheetRow);
    const memberType = (row.cells[typeAt] ?? "").trim();
    const email =
      overrides[String(row.sheetRow)]?.trim() ||
      firstAddress(corrAt >= 0 ? row.cells[corrAt] : undefined) ||
      firstAddress(slackAt >= 0 ? row.cells[slackAt] : undefined);
    if (!email) {
      skipped.push({ sheet_row: row.sheetRow, reason: "no email address on this row" });
      continue;
    }
    const name = (row.cells[nameAt] ?? "").trim();
    const template = templateForMemberType(memberType);
    if (!template.ok) {
      // A type the design onboards without a mail is still onboarded: its access is the whole of it.
      if (subgroupForMemberType(memberType)) {
        accessOnly.push({
          sheet_row: row.sheetRow,
          name,
          email,
          member_type: memberType,
          reason: template.reason,
        });
      } else {
        skipped.push({ sheet_row: row.sheetRow, reason: template.reason });
      }
      continue;
    }
    // The Drive folder and the Slack Connect link are provisioned when the guide is sent, so they
    // stand in for themselves here, as they do in the sender's own preview.
    const composed = composeOnboardingGuide(
      template.templateId,
      {
        first_name: name.split(/\s+/u)[0] ?? "",
        drive_folder_link: "{drive_folder_link}",
        slack_connect_link: "{slack_connect_link}",
        ...request.values?.[String(row.sheetRow)],
      },
      env,
    );
    if (!composed.ok) {
      skipped.push({
        sheet_row: row.sheetRow,
        reason: `${template.templateId}: ${composed.reason}${
          composed.missing.length > 0 ? ` (${composed.missing.join(", ")})` : ""
        }`,
        ...(composed.reason === "missing-values" && { missing: composed.missing }),
      });
      continue;
    }
    planned.push({
      sheet_row: row.sheetRow,
      name,
      email,
      member_type: memberType,
      template_id: template.templateId,
      subject: composed.guide.subject ?? "",
      body: composed.guide.body,
      // AdminBot sends from a mailbox nobody reads, and these mails invite a reply.
      reply_to: env.ADMINBOT_REPLY_TO?.trim() || "akim@cs.toronto.edu",
    });
  }

  for (const missing of wanted) {
    skipped.push({ sheet_row: missing, reason: "no such row in the sheet" });
  }
  return { planned, access_only: accessOnly, skipped };
}

/**
 * What onboarding the selected rows would do, for the tab to show before anything is queued.
 *
 * The mails are composed for real -- same templates, same addresses, same values -- so the
 * preview is the mail, not a summary of it. Nothing is created: no proposal, no audit entry.
 */
export async function previewOnboardFromMemberSheet(
  source: MemberSheetSource,
  request: MemberSheetOnboardRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemberSheetOnboardPreview | { error: { status: number; message: string } }> {
  return planOnboardFromMemberSheet(source, request, env);
}

/**
 * Composes the onboarding mail for each selected row and queues it for approval.
 *
 * A row is skipped, with its reason, rather than half-onboarded: no address, a Member Type whose
 * onboarding is the backend access grant rather than a mail, or a template whose placeholders this
 * row cannot fill. The tab shows those next to the rows they belong to, which is the whole point
 * of running this from the roster rather than from a script.
 */
export async function onboardFromMemberSheet(
  service: AdminBotService,
  source: MemberSheetSource,
  request: MemberSheetOnboardRequest,
  onboarding: {
    /** Steps 1-2 of the shared onboarding for a row not yet on the roster. */
    enroll: (
      input: AdminBotLabMemberInput,
    ) => Promise<AdminBotServiceResponse<NewMemberOnboardingResult>>;
    /** Step 3, queued for approval: this tab has always put mail in front of an approver. */
    queueGuide: (
      memberId: string,
      options: { email: string; values?: Record<string, string> },
    ) => Promise<NewMemberGuideStep>;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemberSheetOnboardResult | { error: { status: number; message: string } }> {
  const plan = await planOnboardFromMemberSheet(source, request, env);
  if ("error" in plan) {
    return plan;
  }

  const created: MemberSheetOnboardResult["created"] = [];
  const enrolled: MemberSheetOnboardResult["enrolled"] = [];
  const skipped = [...plan.skipped];
  const roster = service.listLabMembers();
  const members = roster.ok ? roster.payload.members : [];
  // Matched on any address the record carries, and on the id Add row and the sweep would give
  // the row, so somebody already on the roster is mailed rather than created a second time.
  const findMember = (name: string, email: string) => {
    const address = email.trim().toLowerCase();
    const id = memberIdForRow(name);
    return members.find(
      (member) =>
        (id && member.id === id) ||
        [member.email, member.correspondence_email, member.calendar_email].some(
          (candidate) => candidate?.trim().toLowerCase() === address,
        ),
    );
  };

  for (const row of [...plan.planned, ...plan.access_only]) {
    let memberId = findMember(row.name, row.email)?.id;
    if (!memberId) {
      const id = memberIdForRow(row.name);
      if (!id) {
        skipped.push({
          sheet_row: row.sheet_row,
          reason: "the name has no letters or digits to make an id from",
        });
        continue;
      }
      const onboarded = await onboarding.enroll({
        id,
        name: row.name,
        email: row.email,
        member_type: row.member_type,
      });
      if (!onboarded.ok) {
        skipped.push({ sheet_row: row.sheet_row, reason: onboarded.error.message });
        continue;
      }
      memberId = onboarded.payload.member.id;
      enrolled.push({
        sheet_row: row.sheet_row,
        member_id: memberId,
        member_type_change: onboarded.payload.member_type_change,
      });
    }
    if (!("template_id" in row)) {
      continue;
    }
    const values = request.values?.[String(row.sheet_row)];
    const guide = await onboarding.queueGuide(memberId, {
      email: row.email,
      ...(values ? { values } : {}),
    });
    if (guide.status === "queued" || guide.status === "done") {
      created.push({
        sheet_row: row.sheet_row,
        email: row.email,
        template_id: guide.template_id,
        proposal_id: guide.proposal_id,
      });
    } else {
      skipped.push({ sheet_row: row.sheet_row, reason: guide.reason });
    }
  }
  return { created, enrolled, skipped };
}

export type MemberSheetAddRowRequest = {
  name: string;
  member_type: string;
  /** The address the onboarding guide goes to. */
  email: string;
  slack_email?: string;
  member_attributes?: string;
};

/** How one step of an Add row went, so the tab can say which of the three landed. */
export type MemberSheetAddRowStep =
  | { status: "done"; proposal_id?: string; detail?: string; template_id?: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string; proposal_id?: string; template_id?: string };

export type MemberSheetAddRowResult = {
  member_id: string;
  sheet: MemberSheetAddRowStep;
  member: MemberSheetAddRowStep;
  /** The rooms, meetings and calendar access the new member's type grants. */
  member_type_change?: MemberTypeChangeResult;
  onboarding: MemberSheetAddRowStep;
};

/** Who clicked, as the approval gate records them. */
export type MemberSheetApprover = { approver_role: string; approver_id: string };

const MEMBER_ATTRIBUTES_HEADER = "Member Attributes";
const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * Propose, approve as the clicking admin, and execute, in one call.
 *
 * Add row is one deliberate click by an administrator on a form that says everything it will do,
 * and "immediately" is the requirement -- so the click is the approval. A Member Type change saved
 * on the Lab Members tab is applied the same way (server.member-type-change.ts). It still goes through the
 * gate rather than around it: a typed proposal, an approval naming the admin, an execution and its
 * audit, exactly what Pending Actions records when the same admin approves there.
 */
export async function approveAndExecute(
  service: AdminBotService,
  proposal: AdminBotStoredProposal,
  approver: MemberSheetApprover,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const approved = service.approve(proposal.id, {
    payload_hash: proposal.payload_hash,
    ...approver,
    note: "approved by the admin who submitted Add row",
  });
  if (!approved.ok) {
    return { ok: false, reason: approved.error.message };
  }
  const executed = await service.execute(proposal.id, {
    dry_run: false,
    idempotency_key: `add-row-${proposal.id}`,
  });
  if (!executed.ok) {
    return { ok: false, reason: executed.error.message };
  }
  // A connector that recognized the action but did not perform it answers `simulated`: nothing
  // reached the outside world, so the step must not be reported as done.
  return executed.payload.status === "executed"
    ? { ok: true }
    : { ok: false, reason: "approved, but the connector did not carry it out; see the audit log" };
}

function hasAddress(cell: string | undefined, addresses: ReadonlySet<string>): boolean {
  return (cell ?? "").split(/[\n,;]/u).some((part) => addresses.has(part.trim().toLowerCase()));
}

/**
 * The Onboarding tab's Add row: put a new person on the roster and onboard them, now.
 *
 * Three steps, each reported on its own, ordered so that a failure leaves nothing worse than what
 * the daily sweep would have done:
 *
 *   1. **The sheet row** (`sheet.append_rows`), in the sheet's own column order, so it lands under
 *      the right headings whatever the tab's layout is today.
 *   2. **The member** (`upsertLabMember`), which is the backend onboarding: privilege defaults,
 *      access grants, the onboarding checklist and the channel proposals all hang off creation.
 *   3. **The guide** (`onboarding.send_guide`), which mails them and provisions their Drive folder,
 *      Slack invite and DCS row. Member Types whose onboarding is access alone skip this step.
 *
 * A failed sheet write does not stop the other two. The roster tab can be protected against the
 * bot's account, and the person should not wait on a spreadsheet permission; the sweep matches
 * members by address, so a row an admin types in by hand later is recognised rather than
 * onboarded twice. The reverse is refused up front: somebody already on the sheet or the roster is
 * a 409, because Add row on an existing person is the mistake this form invites.
 */
export async function addMemberSheetRow(
  service: AdminBotService,
  source: MemberSheetSource,
  request: MemberSheetAddRowRequest,
  approver: MemberSheetApprover,
  actor: string,
  onboard: (
    input: AdminBotLabMemberInput,
  ) => Promise<AdminBotServiceResponse<NewMemberOnboardingResult>>,
): Promise<MemberSheetAddRowResult | { error: { status: number; message: string } }> {
  const name = String(request.name ?? "").trim();
  const memberType = String(request.member_type ?? "").trim();
  const email = String(request.email ?? "").trim();
  const slackEmail = String(request.slack_email ?? "").trim();
  const attributes = String(request.member_attributes ?? "").trim();
  if (!name) {
    return { error: { status: 400, message: "name is required" } };
  }
  if (!memberType) {
    return { error: { status: 400, message: "member_type is required" } };
  }
  if (!ADDRESS_PATTERN.test(email)) {
    return { error: { status: 400, message: "email must be an email address" } };
  }
  if (slackEmail && !ADDRESS_PATTERN.test(slackEmail)) {
    return { error: { status: 400, message: "slack_email must be an email address" } };
  }
  const memberId = memberIdForRow(name);
  if (!memberId) {
    return { error: { status: 400, message: "name has no letters or digits to make an id from" } };
  }

  const target = await resolveTarget(source);
  const grid = toSheetGrid(await source.read(rangeFor(target.tab)));
  const at = (header: string): number => grid.header.indexOf(header);
  const typeAt = at(MEMBER_TYPE_HEADER);
  if (typeAt < 0) {
    return { error: { status: 422, message: `the sheet has no "${MEMBER_TYPE_HEADER}" column` } };
  }
  const corrAt = at(CORRESPONDENCE_HEADER);
  const slackAt = at(SLACK_EMAIL_HEADER);
  if (corrAt < 0 && slackAt < 0) {
    return {
      error: { status: 422, message: "the sheet has no email column to put the address in" },
    };
  }
  const nameAt = at(NAME_HEADER) < 0 ? 0 : at(NAME_HEADER);

  const addresses = new Set([email.toLowerCase(), slackEmail.toLowerCase()].filter(Boolean));
  const onSheet = grid.rows.find(
    (row) =>
      (corrAt >= 0 && hasAddress(row.cells[corrAt], addresses)) ||
      (slackAt >= 0 && hasAddress(row.cells[slackAt], addresses)),
  );
  if (onSheet) {
    return {
      error: {
        status: 409,
        message: `${email} is already on the sheet (row ${onSheet.sheetRow}); onboard that row instead`,
      },
    };
  }
  const roster = service.listLabMembers();
  const known = roster.ok
    ? roster.payload.members.find(
        (member) =>
          member.id === memberId || addresses.has((member.email ?? "").trim().toLowerCase()),
      )
    : undefined;
  if (known) {
    return {
      error: {
        status: 409,
        message: `${known.name || known.id} is already a lab member (${known.id})`,
      },
    };
  }

  // The row in the sheet's column order, trimmed after the last filled cell so the append carries
  // no tail of empty strings.
  const row = Array.from({ length: grid.header.length }, () => "");
  row[nameAt] = name;
  row[typeAt] = memberType;
  if (corrAt >= 0) {
    row[corrAt] = email;
  }
  if (slackAt >= 0) {
    row[slackAt] = slackEmail || (corrAt < 0 ? email : "");
  }
  const attributesAt = at(MEMBER_ATTRIBUTES_HEADER);
  if (attributes && attributesAt >= 0) {
    row[attributesAt] = attributes;
  }
  while (row.length > 1 && row.at(-1) === "") {
    row.pop();
  }

  let sheet: MemberSheetAddRowStep;
  const appended = service.createProposal({
    type: "sheet.append_rows",
    summary: `${actor}: add ${name} <${email}> (${memberType}) to the member roster`,
    target: { service: "google", channel: "sheets", target: source.spreadsheetId },
    proposed_payload: {
      spreadsheet_id: source.spreadsheetId,
      range: rangeFor(quoteTab(target.tab)),
      rows: [row],
    },
  });
  if (!appended.ok) {
    sheet = { status: "failed", reason: appended.error.message };
  } else {
    const ran = await approveAndExecute(service, appended.payload, approver);
    sheet = ran.ok
      ? { status: "done", proposal_id: appended.payload.id }
      : { status: "failed", reason: ran.reason, proposal_id: appended.payload.id };
  }

  // Steps 2 and 3 are the shared onboarding every way onto the roster runs
  // (server.member-onboarding.ts): the record with the level its type implies, the access design's
  // rooms and invites, and the guide -- approved by this admin's click, like the row above.
  const onboarded = await onboard({ id: memberId, name, email, member_type: memberType });
  if (!onboarded.ok) {
    return {
      member_id: memberId,
      sheet,
      member: { status: "failed", reason: onboarded.error.message },
      onboarding: { status: "skipped", reason: "the member was not created" },
    };
  }
  const guide = onboarded.payload.onboarding;
  return {
    member_id: memberId,
    sheet,
    member: { status: "done" },
    member_type_change: onboarded.payload.member_type_change,
    onboarding: !guide
      ? { status: "skipped", reason: "no onboarding guide step ran" }
      : guide.status === "done" || guide.status === "queued"
        ? {
            status: "done",
            proposal_id: guide.proposal_id,
            template_id: guide.template_id,
            detail: guide.detail,
          }
        : guide,
  };
}

/** Same rule as `a1Range`: quote a tab title only when Sheets requires it. */
function quoteTab(tab: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(tab) ? tab : `'${tab.replace(/'/gu, "''")}'`;
}

/** How writing a Member Type back to the sheet went. */
export type MemberTypeSheetWrite =
  | { status: "done"; proposal_id: string; sheet_row: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string; proposal_id?: string };

/**
 * Put a member's new Member Type on their sheet row, approved by the admin who changed it.
 *
 * The nightly roster sync copies the sheet's Member Type onto the database. A type changed on the
 * Lab Members tab and left off the sheet is therefore undone the next morning -- and the sync then
 * files the reverse access changes as proposals. Writing the cell keeps the two agreeing.
 *
 * Guarded like a grid edit: the cell must still hold what the sheet said when it was read, so a
 * concurrent edit by somebody working in the spreadsheet is not overwritten.
 */
export async function writeMemberTypeToSheet(
  service: AdminBotService,
  source: MemberSheetSource,
  member: AdminBotLabMember,
  approver: MemberSheetApprover,
  actor: string,
): Promise<MemberTypeSheetWrite> {
  const target = await resolveTarget(source);
  const grid = toSheetGrid(await source.read(rangeFor(target.tab)));
  const typeAt = grid.header.indexOf(MEMBER_TYPE_HEADER);
  if (typeAt < 0) {
    return { status: "failed", reason: `the sheet has no "${MEMBER_TYPE_HEADER}" column` };
  }
  let parsed: RosterSheetParse;
  try {
    parsed = parseRosterSheet(
      grid.header,
      grid.rows.map((row) => ({ sheetRow: row.sheetRow, cells: row.cells })),
    );
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  const row = rosterRowForMember(parsed, member);
  if (!row) {
    return {
      status: "skipped",
      reason: "no single sheet row matches this member's id or addresses",
    };
  }
  const value = member.member_type ?? "";
  if (sameMemberType(row.member_type, value)) {
    return { status: "skipped", reason: `row ${row.sheet_row} already says "${row.member_type}"` };
  }
  const planned = await proposeMemberSheetEdits(
    service,
    source,
    {
      edits: [{ sheet_row: row.sheet_row, column: typeAt, value }],
      expected: { [`${row.sheet_row}:${typeAt}`]: row.member_type },
    },
    actor,
  );
  if ("error" in planned) {
    return { status: "failed", reason: planned.error.message };
  }
  if (!planned.proposal) {
    return {
      status: "skipped",
      reason: planned.conflicts.length
        ? `row ${row.sheet_row} changed while it was being read; left as it is`
        : "nothing to write",
    };
  }
  const ran = await approveAndExecute(service, planned.proposal, approver);
  return ran.ok
    ? { status: "done", proposal_id: planned.proposal.id, sheet_row: row.sheet_row }
    : {
        status: "failed",
        reason: /protected cell|protected object/i.test(ran.reason)
          ? `Google Sheets blocked row ${row.sheet_row}: the member-type cell is protected. Ask the spreadsheet owner to allow the AdminBot connector account to edit this range, then retry. The sheet was not updated.`
          : ran.reason,
        proposal_id: planned.proposal.id,
      };
}

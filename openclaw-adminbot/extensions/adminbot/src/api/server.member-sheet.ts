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
  AdminBotSheetValueRange,
  AdminBotStoredProposal,
} from "../contracts/actions.js";
import type { AdminBotService } from "../kernel/service.js";
import {
  planSheetEdits,
  type SheetCellEdit,
  toSheetGrid,
  touchesAccess,
} from "../workflows/members/member-sheet-grid.js";
import { composeOnboardingGuide } from "../workflows/onboarding/guide.js";
import { templateForMemberType } from "../workflows/onboarding/member-type-template.js";

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
async function resolveTarget(
  source: MemberSheetSource,
): Promise<{ tab: string; url: string }> {
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
  conflicts: { sheet_row: number; column: number; header: string; expected: string; actual: string }[];
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
  template_id: string;
  subject: string;
  body: string;
  reply_to: string;
};

export type MemberSheetOnboardPreview = {
  planned: PlannedOnboardEmail[];
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
  const skipped: MemberSheetOnboardResult["skipped"] = [];
  const overrides = request.addresses ?? {};

  for (const row of grid.rows) {
    if (!wanted.has(row.sheetRow)) {
      continue;
    }
    wanted.delete(row.sheetRow);
    const memberType = row.cells[typeAt] ?? "";
    const template = templateForMemberType(memberType);
    if (!template.ok) {
      skipped.push({ sheet_row: row.sheetRow, reason: template.reason });
      continue;
    }
    const email =
      overrides[String(row.sheetRow)]?.trim() ||
      firstAddress(corrAt >= 0 ? row.cells[corrAt] : undefined) ||
      firstAddress(slackAt >= 0 ? row.cells[slackAt] : undefined);
    if (!email) {
      skipped.push({ sheet_row: row.sheetRow, reason: "no email address on this row" });
      continue;
    }
    const name = (row.cells[nameAt] ?? "").trim();
    const composed = composeOnboardingGuide(
      template.templateId,
      {
        first_name: name.split(/\s+/u)[0] ?? "",
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
  return { planned, skipped };
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
  actor: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemberSheetOnboardResult | { error: { status: number; message: string } }> {
  const plan = await planOnboardFromMemberSheet(source, request, env);
  if ("error" in plan) {
    return plan;
  }

  const created: MemberSheetOnboardResult["created"] = [];
  const skipped = [...plan.skipped];
  for (const mail of plan.planned) {
    const proposal = service.createProposal({
      type: "email.send",
      summary: `${actor}: onboard ${mail.name || mail.email} (${mail.template_id}) from the member roster`,
      proposed_payload: {
        to: mail.email,
        subject: mail.subject,
        body: mail.body,
        reply_to: mail.reply_to,
      },
    });
    if (!proposal.ok) {
      skipped.push({ sheet_row: mail.sheet_row, reason: proposal.error.message });
      continue;
    }
    created.push({
      sheet_row: mail.sheet_row,
      email: mail.email,
      template_id: mail.template_id,
      proposal_id: proposal.payload.id,
    });
  }
  return { created, skipped };
}

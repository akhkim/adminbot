// AdminBot client: onboarding
//
// Mirrors the service's api/routes/onboarding.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import {
  authedJson,
  type AuthErrorKind,
  type AuthResult,
  type LabMember,
  mapErrorResponse,
  type MemberNudgeChannel,
  type MemberNudgeResult,
  type MemberTypeChangeSummary,
} from "../auth/session.ts";

export type MemberOnboardingGuideQueued = {
  status?: "done" | "queued";
  proposal_id: string;
  template_id: string;
  email: string;
};

// Puts one roster member through onboarding: the service composes nothing here, it files an
// `onboarding.send_guide` proposal. Standard full-member guides are approved and sent immediately;
// other guides wait for review. Admin Bearer session only, like every other write
// on this page that reaches a person -- the shared service principal is refused (403) by the route
// itself.
//
// A refusal is expected traffic rather than a fault: no address (422), a Member Type whose
// onboarding is the backend access grant (422), or a guide already sent or already queued (409).
// Each one names what it refused, and that sentence is the whole value of the notice -- so the
// message is carried up from any status here, not only from the 400 `mapErrorResponse` keeps it
// for.
export async function queueMemberOnboardingGuide(
  memberId: string,
  sessionToken: string,
  baseUrl: string,
  slackChannels?: string[],
): Promise<AuthResult<MemberOnboardingGuideQueued>> {
  const result = await authedJson(
    baseUrl,
    `/lab/members/${encodeURIComponent(memberId)}/onboarding/guide`,
    "POST",
    sessionToken,
    slackChannels?.length ? { slack_project_channels: slackChannels } : {},
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    const refusal = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    return {
      ok: false,
      ...mapErrorResponse(result.response, result.body, { weakOn400: false }),
      ...(typeof refusal === "string" && refusal.trim() ? { message: refusal.trim() } : {}),
    };
  }
  return { ok: true, value: result.body as MemberOnboardingGuideQueued };
}

// LinkedIn (and every other checklist step) is roster state, not something observed: no LinkedIn
// API can report whether a given person follows or works at an organization, so completion is
// only ever what the member or an admin recorded here.
export async function setOnboardingStep(
  memberId: string,
  stepId: string,
  complete: boolean,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LabMember>> {
  const result = await authedJson(
    baseUrl,
    `/lab/members/${encodeURIComponent(memberId)}/onboarding/${encodeURIComponent(stepId)}`,
    "POST",
    sessionToken,
    { complete },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as LabMember };
}

export async function nudgeOnboardingStep(
  stepId: string,
  channel: MemberNudgeChannel,
  sessionToken: string,
  baseUrl: string,
  message?: string,
): Promise<AuthResult<MemberNudgeResult>> {
  const result = await authedJson(
    baseUrl,
    `/onboarding/${encodeURIComponent(stepId)}/nudge`,
    "POST",
    sessionToken,
    { channel, ...(message ? { message } : {}) },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as MemberNudgeResult };
}

/** The lab's member spreadsheet as the Membership grid shows it. */
export type MemberSheetView = {
  spreadsheet_id: string;
  tab: string;
  url: string;
  header: string[];
  rows: { sheet_row: number; cells: string[] }[];
  read_at: string;
};

export type MemberSheetEditResult = {
  proposal?: { id: string; status: string };
  updates: { range: string; values: string[][] }[];
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

export type MemberSheetOnboardResult = {
  /** `sent`: already mailed on this admin's approval. `queued`: waiting in Pending Actions. */
  created: {
    sheet_row: number;
    email: string;
    template_id: string;
    proposal_id: string;
    status?: "sent" | "queued";
  }[];
  /** Rows not yet on the roster, added with the access their Member Type grants. */
  enrolled?: {
    sheet_row: number;
    member_id: string;
    member_type_change?: MemberTypeChangeSummary;
  }[];
  skipped: { sheet_row: number; reason: string; missing?: string[] }[];
};

/**
 * The service's own sentence about why a member-sheet call failed.
 *
 * The three routes here fail for reasons only the service can name -- a spreadsheet it cannot read
 * because the host's Google token expired (502), a deployment pointed at a sheet that does not
 * exist -- and `mapErrorResponse` carries a message only for 400. Without this the grid answered
 * every one of them with "The member sheet could not be reached", which is true and useless.
 */
function memberSheetFailure(
  response: Response,
  body: unknown,
): { ok: false; kind: AuthErrorKind; message?: string } {
  const mapped = mapErrorResponse(response, body, { weakOn400: false });
  if (mapped.message) {
    return { ok: false, ...mapped };
  }
  const raw = (body as { error?: { message?: unknown } } | null)?.error?.message;
  const message = typeof raw === "string" ? raw.trim() : "";
  // The service's catch-all 404 for an unrouted path. The Control UI ships from Vercel and the
  // service from Aurora, so the UI is routinely ahead: a Membership tab talking to a service that
  // predates /membership/sheet answered with the word "not found", which reads as a missing sheet
  // and sent people looking at Google. It is a missing deployment.
  if (response.status === 404 && (!message || message === "not found")) {
    return {
      ok: false,
      ...mapped,
      message:
        "This AdminBot service has no /membership/sheet route, so it is older than this page. The sheet is fine; the service needs a deploy.",
    };
  }
  return message ? { ok: false, ...mapped, message } : { ok: false, ...mapped };
}

export async function fetchMemberSheet(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MemberSheetView>> {
  const result = await authedJson(baseUrl, "/membership/sheet", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return memberSheetFailure(result.response, result.body);
  }
  return { ok: true, value: withFullRows(result.body as MemberSheetView) };
}

/**
 * The service leaves each row's trailing empty cells off; every row is padded back to the header's
 * width here, so the grid, its edit diff and its column lookups see the same rectangle they did.
 * An older service's already-full rows pass through unchanged.
 */
export function withFullRows(view: MemberSheetView): MemberSheetView {
  if (!Array.isArray(view?.header) || !Array.isArray(view.rows)) {
    return view;
  }
  const width = view.header.length;
  return {
    ...view,
    rows: view.rows.map((row) =>
      row.cells.length >= width
        ? row
        : {
            ...row,
            cells: [...row.cells, ...Array.from({ length: width - row.cells.length }, () => "")],
          },
    ),
  };
}

/**
 * `expected` carries what each edited cell held when the grid was drawn, so the service can refuse
 * a write against a cell somebody else has changed since. Sending the edits without it would let
 * this tab silently revert whoever was editing the sheet in Google at the same time.
 */
export async function proposeMemberSheetEdits(
  edits: { sheet_row: number; column: number; value: string }[],
  expected: Record<string, string>,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MemberSheetEditResult>> {
  const result = await authedJson(baseUrl, "/membership/sheet", "POST", sessionToken, {
    edits,
    expected,
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return memberSheetFailure(result.response, result.body);
  }
  return { ok: true, value: result.body as MemberSheetEditResult };
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

/** A row whose Member Type is onboarded by its access alone, with no email. */
export type PlannedAccessOnly = {
  sheet_row: number;
  name: string;
  email: string;
  member_type: string;
  reason: string;
};

export type MemberSheetOnboardPreview = {
  planned: PlannedOnboardEmail[];
  /** Absent from a service older than the shared onboarding. */
  access_only?: PlannedAccessOnly[];
  skipped: MemberSheetOnboardResult["skipped"];
};

/**
 * What onboarding the selected rows would do (POST /membership/sheet/onboard/preview) — the
 * composed mails and the rows that would be skipped, with nothing queued.
 *
 * Deliberately its own route rather than a flag on the executing one: against a service too old
 * to know it, a flag would be dropped and the "preview" would quietly onboard people. A 404 here
 * is reported as the missing deploy it is.
 */
export async function previewOnboardFromMemberSheet(
  sheetRows: number[],
  values: Record<string, Record<string, string>>,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MemberSheetOnboardPreview>> {
  const result = await authedJson(
    baseUrl,
    "/membership/sheet/onboard/preview",
    "POST",
    sessionToken,
    {
      sheet_rows: sheetRows,
      ...(Object.keys(values).length > 0 ? { values } : {}),
    },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return memberSheetFailure(result.response, result.body);
  }
  return { ok: true, value: result.body as MemberSheetOnboardPreview };
}

export async function onboardFromMemberSheet(
  sheetRows: number[],
  values: Record<string, Record<string, string>>,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MemberSheetOnboardResult>> {
  const result = await authedJson(baseUrl, "/membership/sheet/onboard", "POST", sessionToken, {
    sheet_rows: sheetRows,
    ...(Object.keys(values).length > 0 ? { values } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return memberSheetFailure(result.response, result.body);
  }
  return { ok: true, value: result.body as MemberSheetOnboardResult };
}

export type MemberSheetAddRowInput = {
  name: string;
  member_type: string;
  email: string;
  slack_email?: string;
  member_attributes?: string;
};

/** How one of Add row's three steps went. Mirrors the service's `MemberSheetAddRowStep`. */
export type MemberSheetAddRowStep =
  | { status: "done"; proposal_id?: string; detail?: string; template_id?: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string; proposal_id?: string; template_id?: string };

export type MemberSheetAddRowResult = {
  member_id: string;
  sheet: MemberSheetAddRowStep;
  member: MemberSheetAddRowStep;
  /** The rooms, meetings and calendar access the new member's type grants. */
  member_type_change?: MemberTypeChangeSummary;
  onboarding: MemberSheetAddRowStep;
};

/**
 * Adds a person to the roster and onboards them, now: the service appends the row, creates the
 * member and sends the guide, each approved as the signed-in admin.
 */
export async function addMemberSheetRow(
  input: MemberSheetAddRowInput,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MemberSheetAddRowResult>> {
  const result = await authedJson(baseUrl, "/membership/sheet/rows", "POST", sessionToken, input);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return memberSheetFailure(result.response, result.body);
  }
  return { ok: true, value: result.body as MemberSheetAddRowResult };
}

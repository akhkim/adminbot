// AdminBot client: The Opportunities board and its deadline proposals.
//
// Mirrors the service's api/routes/deadlines.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import { authedJson, type AuthResult, mapErrorResponse } from "../auth/session.ts";
import type {
  AdminBotOpportunityDraft,
  AdminBotOpportunityView,
} from "../data/opportunities-data.ts";

/**
 * The board's member-contributed entries.
 *
 * `token` is nullable because this tab renders for signed-out visitors: the service serves the
 * approved rows to an anonymous caller and adds the caller's own pending ones when there is a
 * session. What comes back is already filtered for who asked -- the UI does not get to widen it.
 */
export async function fetchOpportunities(
  baseUrl: string,
  token: string | null,
): Promise<AuthResult<AdminBotOpportunityView[]>> {
  const result = await authedJson(baseUrl, "/opportunities", "GET", token);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const opportunities = (result.body as { opportunities?: AdminBotOpportunityView[] } | null)
    ?.opportunities;
  return { ok: true, value: opportunities ?? [] };
}

export async function submitOpportunity(
  input: AdminBotOpportunityDraft,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<AdminBotOpportunityView>> {
  const result = await authedJson(baseUrl, "/opportunities", "POST", sessionToken, input);
  return readOpportunityResult(result);
}

export async function updateOpportunity(
  opportunityId: string,
  input: AdminBotOpportunityDraft,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<AdminBotOpportunityView>> {
  const result = await authedJson(
    baseUrl,
    `/opportunities/${encodeURIComponent(opportunityId)}`,
    "PUT",
    sessionToken,
    input,
  );
  return readOpportunityResult(result);
}

export async function decideOpportunity(
  opportunityId: string,
  decision: "approve" | "reject",
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<AdminBotOpportunityView>> {
  const result = await authedJson(
    baseUrl,
    `/opportunities/${encodeURIComponent(opportunityId)}/${decision}`,
    "POST",
    sessionToken,
    {},
  );
  return readOpportunityResult(result);
}

/**
 * Accept the refresh sweep's date onto the board, or throw the proposal away.
 *
 * The sweep may only ever propose (see the service), so this is the only path by which a swept
 * date reaches a board members plan against.
 */
export async function decideOpportunityDeadline(
  opportunityId: string,
  accept: boolean,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<AdminBotOpportunityView>> {
  const result = await authedJson(
    baseUrl,
    `/opportunities/${encodeURIComponent(opportunityId)}/deadline-proposal/decision`,
    "POST",
    sessionToken,
    { accept },
  );
  return readOpportunityResult(result);
}

export async function deleteOpportunity(
  opportunityId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<true>> {
  const result = await authedJson(
    baseUrl,
    `/opportunities/${encodeURIComponent(opportunityId)}`,
    "DELETE",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: true };
}

function readOpportunityResult(
  result: { response: Response; body: unknown } | { unreachable: true },
): AuthResult<AdminBotOpportunityView> {
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const opportunity = (result.body as { opportunity?: AdminBotOpportunityView } | null)
    ?.opportunity;
  return opportunity ? { ok: true, value: opportunity } : { ok: false, kind: "auth-failed" };
}

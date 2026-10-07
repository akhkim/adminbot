// AdminBot client: Approving, executing, and withdrawing pending actions.
//
// Mirrors the service's api/routes/governance.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import { authedJson, type AuthResult, mapErrorResponse } from "../auth/session.ts";

// Approvals go over the member session rather than the gateway tool: the service records the
// approver from the authenticated principal, and the shared service principal every agent tool
// call uses cannot name a person (extensions/adminbot/src/api/server.ts).
export async function approveActionAsMember(
  actionId: string,
  payloadHash: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<AdminBotProposalView>> {
  return await privilegedActionCall<AdminBotProposalView>(
    baseUrl,
    `/approvals/${encodeURIComponent(actionId)}/approve`,
    sessionToken,
    { payload_hash: payloadHash },
  );
}

export async function executeActionAsMember(
  actionId: string,
  idempotencyKey: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<AdminBotExecutionView>> {
  return await privilegedActionCall<AdminBotExecutionView>(
    baseUrl,
    `/actions/${encodeURIComponent(actionId)}/execute`,
    sessionToken,
    { idempotency_key: idempotencyKey, dry_run: false },
  );
}

export type AdminBotProposalView = {
  id: string;
  status: "pending" | "approved" | "executed" | "rejected";
  approval_requirement: { min_approvals: number; approver_roles: string[] };
  approvals: Array<{ approver_role: string; approver_id?: string }>;
};

export type AdminBotExecutionView = {
  action_id: string;
  status: "simulated" | "executed";
  dry_run: boolean;
};

async function privilegedActionCall<T>(
  baseUrl: string,
  path: string,
  sessionToken: string,
  body: unknown,
): Promise<AuthResult<T>> {
  const result = await authedJson(baseUrl, path, "POST", sessionToken, body);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    const mapped = mapErrorResponse(result.response, result.body, { weakOn400: false });
    // A refused execute is almost always the connector's own sentence -- "You are trying to edit a
    // protected cell", "gog: token expired" -- and a conflict names what changed under the
    // approval. mapErrorResponse keeps a message only for a 400, which left the operator with
    // "Couldn't record this approval" and nothing to act on. The route is privileged, so the
    // service's text is safe to show.
    const message = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    if (
      !mapped.message &&
      (result.response.status === 409 || result.response.status >= 500) &&
      typeof message === "string" &&
      message.trim()
    ) {
      return { ok: false, ...mapped, message: message.trim() };
    }
    return { ok: false, ...mapped };
  }
  return { ok: true, value: result.body as T };
}

export type ApprovalExecutionResult = { status: string; [key: string]: unknown };

// Dismiss a pending action with the signed-in member's own Bearer session
// (POST /proposals/:id/remove). Approve and execute live in approveActionAsMember /
// executeActionAsMember above: the server records the approver from the authenticated
// principal, so the caller cannot name itself and the two-distinct-approver requirement
// on high-risk actions actually binds.
//
// This deliberately does NOT go through the gateway `tools.invoke` path. That path always
// authenticates as the shared service principal regardless of who is chatting, so routing
// approvals through it would let any member drive a privileged action by asking the
// AdminBot agent to do it in chat. The server answers these routes with
// requireMemberPrivileged, which rejects the service principal outright (403) and demands a
// real admin session — so the capability exists only where a genuine privileged
// member session is present: this UI path.
export async function removePendingAction(
  actionId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<ApprovalExecutionResult>> {
  return await approvalCall(
    `/proposals/${encodeURIComponent(actionId)}/remove`,
    { actor: "control-ui" },
    sessionToken,
    baseUrl,
  );
}

async function approvalCall(
  path: string,
  payload: unknown,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<ApprovalExecutionResult>> {
  const result = await authedJson(baseUrl, path, "POST", sessionToken, payload);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: (result.body ?? {}) as ApprovalExecutionResult };
}

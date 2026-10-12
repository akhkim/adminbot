// Who may reach a route, declared on the route itself.
//
// Each decorator wraps a handler and runs its check before the body does, so the route table reads
// as method, path, and audience in one line, and a handler cannot forget its own gate. The checks
// are the same functions the remaining inline call sites use, which keeps every refusal's status
// and wording identical whichever way a route states it.
//
// These hide nothing and grant nothing beyond what the principal already is: the principal comes
// from resolvePrincipal in server.ts, and the service re-checks resource ownership itself.
import type { ServerResponse } from "node:http";
import type { AdminBotMemberPrincipal } from "../../workflows/identity/auth.js";
import { sendJson } from "../server.http.js";
import type { AdminBotPrincipal } from "./context.js";
import type { RouteHandler } from "./router.js";

export type GuardDenial = { status: number; message: string };

const MEMBER_SESSION_REQUIRED: GuardDenial = { status: 401, message: "member session required" };

/**
 * A signed-in member, and nobody else: not the service token, not an anonymous visitor.
 *
 * The handler receives the principal already narrowed to the member. `denial` exists because the
 * routes this replaced answered in a few different words and statuses, and clients match on them.
 */
export function memberOnly(
  handler: RouteHandler<AdminBotMemberPrincipal>,
  denial: GuardDenial = MEMBER_SESSION_REQUIRED,
): RouteHandler {
  return (request) => {
    const { principal } = request;
    if (principal.kind !== "member") {
      sendJson(request.res, denial.status, { error: { message: denial.message } });
      return;
    }
    return handler({ ...request, principal });
  };
}

/** An administrator's session, or the service token acting for an operator. */
export function privilegedOnly(handler: RouteHandler): RouteHandler {
  return (request) =>
    requirePrivileged(request.res, request.principal) ? handler(request) : undefined;
}

/** An administrator's own session. The service token is refused: a person has to own the act. */
export function adminSessionOnly(handler: RouteHandler): RouteHandler {
  return (request) =>
    requireMemberPrivileged(request.res, request.principal) ? handler(request) : undefined;
}

export function isPrivileged(principal: AdminBotPrincipal): boolean {
  if (principal.kind === "service") {
    return true;
  }
  if (principal.kind === "anonymous") {
    return false;
  }
  const level = principal.member.privilege_level;
  return level === "admin";
}

export function requirePrivileged(res: ServerResponse, principal: AdminBotPrincipal): boolean {
  if (isPrivileged(principal)) {
    return true;
  }
  sendJson(res, 403, { error: { message: "insufficient privileges" } });
  return false;
}

export function requireMemberPrivileged(
  res: ServerResponse,
  principal: AdminBotPrincipal,
): boolean {
  if (principal.kind === "service") {
    sendJson(res, 403, {
      error: {
        message:
          "this action requires an admin or core member session and cannot be performed by the service principal",
      },
    });
    return false;
  }
  return requirePrivileged(res, principal);
}

export function principalActor(principal: AdminBotPrincipal): string {
  if (principal.kind === "service") {
    return "service";
  }
  if (principal.kind === "anonymous") {
    return "anonymous";
  }
  return principal.impersonator?.id ?? principal.member.id;
}

export function approverIdentityFor(
  principal: AdminBotPrincipal,
): { approver_role: string; approver_id: string } | undefined {
  // Only a member principal names a person: the shared service principal is anonymous by
  // construction, and the anonymous reimbursement principal has no account at all.
  if (principal.kind !== "member") {
    return undefined;
  }
  return {
    approver_role: principal.member.privilege_level,
    approver_id: principal.member.id,
  };
}

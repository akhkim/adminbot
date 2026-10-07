// The task runner's HTTP surface: the visitor bootstrap, the `/tasks` routes every principal (and
// a visitor) may reach, and the helper zone routes use to hand a model-backed request to the
// runner instead of answering it inline.
//
// The `/tasks` block runs before the anonymous boundary in server.ts's routeRequest, because a
// visitor owns tasks without being a principal; it is therefore not part of AUTHENTICATED_ROUTES.
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../server.http.js";
import { handleTaskRoute, submitHttpTask } from "../server.tasks.js";
import type { AdminBotPrincipal, AdminBotRouteContext } from "./context.js";
import { isPrivileged, principalActor } from "./guards.js";
import { remoteIp } from "./origin.js";

/** POST /tasks/visitor: mint (or refresh) the visitor credential an anonymous caller owns tasks by. */
export function handleVisitorBootstrap(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
): void {
  if (!ctx.anonymousRateLimiter.check(remoteIp(req, ctx.trustProxyHeaders))) {
    sendJson(res, 429, {
      error: { message: "too many visitor session requests; try again later" },
    });
    return;
  }
  ctx.visitors.ensure(req, res);
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, 200, { visitor: { ready: true } });
}

/** `/tasks` and `/tasks/...`, for a principal or a visitor. Answers every request it is given. */
export async function handleTasksRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: AdminBotRouteContext,
  principal: AdminBotPrincipal | undefined,
): Promise<void> {
  const visitor = !principal ? ctx.visitors.resolve(req) : undefined;
  const owner = principal ? taskOwner(principal) : visitor;
  if (!owner) {
    sendJson(res, 401, { error: { message: "authentication required" } });
    return;
  }
  // A visitor reaching a task route has not passed the anonymous limiter in routeRequest -- this
  // block returns before it -- and Wait and retry both start model work. Without this, one
  // bootstrap plus one failed turn buys unlimited inference by retrying the same row, which is
  // exactly what that limiter exists to stop. Reads are left alone: they spend no GPU time, and the
  // status polling the UI does would exhaust a 60-per-hour budget in a minute.
  if (visitor && req.method === "POST" && /\/(?:wait|retry)$/u.test(url.pathname)) {
    const ip = remoteIp(req, ctx.trustProxyHeaders);
    if (!ctx.anonymousRateLimiter.check(ip)) {
      ctx.service.recordAnonymousReimbursementUse({
        route: url.pathname,
        outcome: "rate_limited",
        ...(ip ? { ip } : {}),
      });
      sendJson(res, 429, {
        error: { message: "too many reimbursement requests; please try again later" },
      });
      return;
    }
    ctx.service.recordAnonymousReimbursementUse({
      route: url.pathname,
      outcome: "accepted",
      ...(ip ? { ip } : {}),
    });
  }
  const handled = await handleTaskRoute(
    req,
    res,
    url,
    ctx.taskRuntime,
    owner,
    (task) => {
      if (visitor) {
        return task.kind === "reimbursement";
      }
      if (task.kind === "member-guidebook" && task.status !== "expired") {
        if (!task.input || typeof task.input !== "object") {
          return false;
        }
        const input = task.input as { approvedHash?: string; indexPath?: string };
        if (
          input.approvedHash !== (process.env.ADMINBOT_MEMBER_GUIDEBOOK_SHA256?.trim() ?? "") ||
          input.indexPath !== (process.env.ADMINBOT_MEMBER_GUIDEBOOK_INDEX?.trim() ?? "")
        ) {
          return false;
        }
      }
      if (task.kind.startsWith("cv.") && principal && !isPrivileged(principal)) {
        return false;
      }
      return true;
    },
    (task) =>
      Boolean(principal && isPrivileged(principal)) &&
      task.owner === "system:workshop-match" &&
      task.kind === "workshop.match",
  );
  if (!handled) {
    sendJson(res, 404, { error: { message: "not found" } });
  }
}

/**
 * Who owns a principal's tasks. An impersonated session owns its own rows rather than the
 * member's, so an admin viewing as someone never reads or steers that person's work.
 */
export function taskOwner(principal: AdminBotPrincipal): string {
  if (principal.kind === "member") {
    return `member:${principal.member.id}${principal.impersonator ? `:viewed-by:${principal.impersonator.id}` : ""}`;
  }
  return principal.kind;
}

/** Hands a route's model-backed work to the runner and answers with its result or its task. */
export async function submitRouteTask(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
  principal: AdminBotPrincipal,
  kind: string,
  input: unknown,
) {
  if (
    principal.kind === "anonymous" &&
    ctx.visitors.hasCredential(req) &&
    !ctx.visitors.resolve(req)
  ) {
    sendJson(res, 401, {
      error: {
        message:
          "Visitor session expired; establish a new session before submitting a new request.",
      },
    });
    return;
  }
  const owner =
    principal.kind === "anonymous" ? ctx.visitors.ensure(req, res) : taskOwner(principal);
  return submitHttpTask(
    req,
    res,
    ctx.taskRuntime,
    owner,
    kind,
    input,
    principal.kind !== "anonymous" &&
      ctx.inferenceGate.preferences(principalActor(principal)).inference_always_wait,
  );
}

// API usage telemetry: the recorder every request passes through, and the admin reads of it.
//
// The recorder learns who a request was from resolvePrincipal (session.ts), which notes the
// principal here, and what it was from the published contract, which turns a concrete path into its
// operationId. A request nobody authenticated is not recorded: it is not anybody's usage.
//
// The reads are admin-only. See contracts/api-usage.ts for what a row holds and what it never does.
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import {
  adminBotApiUsageClient,
  adminBotApiUsageDays,
  type AdminBotApiUsageEntry,
} from "../../contracts/api-usage.js";
import { automationRunReport } from "../../kernel/automation-runs.js";
import { withRunMetrics } from "../../kernel/run-metrics.js";
import type { ApiUsageLog } from "../../persistence/api-usage.js";
import { sendJson } from "../server.http.js";
import type { AdminBotPrincipal, AdminBotRouteContext } from "./context.js";
import { privilegedOnly } from "./guards.js";
import { contractOperation } from "./pilot-access.js";
import { limitParam } from "./query-params.js";
import { get, type Route } from "./router.js";
import { cookieToken } from "./session.js";

const principals = new WeakMap<IncomingMessage, AdminBotPrincipal>();

/** Called by resolvePrincipal with whoever the request turned out to be. */
export function noteUsagePrincipal(
  req: IncomingMessage,
  principal: AdminBotPrincipal | undefined,
): void {
  if (principal && principal.kind !== "anonymous") {
    principals.set(req, principal);
  }
}

/** The usage row for a finished request, or undefined when it is not one to keep. */
export function usageEntryFor(input: {
  req: IncomingMessage;
  principal: AdminBotPrincipal | undefined;
  status: number;
  durationMs: number;
  at: Date;
  metrics?: Record<string, number>;
}): AdminBotApiUsageEntry | undefined {
  const { req, principal } = input;
  if (!principal || principal.kind === "anonymous" || req.method === "OPTIONS") {
    return undefined;
  }
  const method = (req.method ?? "GET").toUpperCase();
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const operation = contractOperation(pathname, method)?.id ?? "unmatched";
  const userAgent = req.headers["user-agent"];
  const client = adminBotApiUsageClient(
    typeof userAgent === "string" ? userAgent : undefined,
    Boolean(cookieToken(req)),
  );
  const auth =
    principal.kind === "service" ? "service" : principal.apiToken ? "api_token" : "session";
  return {
    at: input.at.toISOString(),
    ...(principal.kind === "member"
      ? { member_id: principal.impersonator?.id ?? principal.member.id }
      : {}),
    auth,
    ...(principal.kind === "member" && principal.apiToken
      ? { token_id: principal.apiToken.id }
      : {}),
    client: client.client,
    ...(client.version ? { client_version: client.version } : {}),
    operation,
    method,
    status: input.status,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    ...(input.metrics && Object.keys(input.metrics).length > 0 && auth === "service"
      ? { metrics: input.metrics }
      : {}),
  };
}

/**
 * Times `handle` and records it once the response is gone. The work runs inside a run-metrics bag
 * so a sweep endpoint's counters (kernel/run-metrics.ts) land on its row.
 */
export function trackApiUsage(
  req: IncomingMessage,
  res: ServerResponse,
  log: ApiUsageLog,
  handle: () => Promise<void>,
): Promise<void> {
  const started = performance.now();
  const at = new Date();
  const { result, metrics } = withRunMetrics(handle);
  res.once("close", () => {
    try {
      const entry = usageEntryFor({
        req,
        principal: principals.get(req),
        // A client that hung up before any answer is told nothing; 499 says so, as nginx does.
        status: res.headersSent ? res.statusCode : 499,
        durationMs: performance.now() - started,
        at,
        metrics: metrics(),
      });
      if (entry) {
        log.record(entry);
      }
    } catch {
      // Telemetry never becomes the request's problem.
    }
  });
  return result;
}

function memberName(ctx: AdminBotRouteContext, id: string): string {
  return ctx.store.getLabMember(id)?.name ?? id;
}

export const usageRoutes: readonly Route[] = [
  get(
    "/usage/summary",
    privilegedOnly(({ res, url, ctx }) => {
      ctx.apiUsage.flush();
      const summary = ctx.apiUsage.summary({
        days: adminBotApiUsageDays(url.searchParams.get("days")),
      });
      sendJson(res, 200, {
        ...summary,
        by_member: summary.by_member.map((row) => ({
          ...row,
          name: memberName(ctx, row.member_id),
        })),
      });
    }),
  ),
  get(
    "/usage/requests",
    privilegedOnly(({ res, url, ctx }) => {
      ctx.apiUsage.flush();
      const memberId = url.searchParams.get("member_id")?.trim();
      const limit = limitParam(url);
      sendJson(res, 200, {
        requests: ctx.apiUsage.recent({
          ...(memberId ? { memberId } : {}),
          ...(limit === undefined ? {} : { limit }),
        }),
      });
    }),
  ),
  get(
    "/usage/automation",
    privilegedOnly(({ res, url, ctx }) => {
      ctx.apiUsage.flush();
      const days = adminBotApiUsageDays(url.searchParams.get("days"), 7);
      const from = new Date(Date.now() - days * 86_400_000).toISOString();
      sendJson(
        res,
        200,
        automationRunReport({
          events: ctx.store.listAuditEvents(),
          serviceRuns: ctx.apiUsage.serviceRuns(from),
          from,
          days,
        }),
      );
    }),
  ),
];

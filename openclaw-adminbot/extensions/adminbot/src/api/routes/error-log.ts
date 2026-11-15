// The error log: what went wrong for the people using AdminBot, and who it happened to.
//
// The write is open to every signed-in member, because the whole point is to hear from the people
// who are not admins. The reads are an operator's, like the rest of /ops.
import {
  adminBotErrorReportsPerMinute,
  parseAdminBotErrorReport,
  type AdminBotErrorGroup,
  type AdminBotErrorReport,
} from "../../contracts/error-log.js";
import { readJson, readRecord, sendJson } from "../server.http.js";
import type { AdminBotPrincipal, AdminBotRouteContext } from "./context.js";
import { memberOnly, principalActor, privilegedOnly } from "./guards.js";
import { limitParam } from "./query-params.js";
import { get, post, type Route } from "./router.js";

/** A report is a few short strings; anything larger is not one. */
const ERROR_REPORT_BODY_LIMIT_BYTES = 16 * 1024;

/** A group as an admin reads it: the member ids resolved to names where the roster still has them. */
type AdminBotErrorGroupView = AdminBotErrorGroup & {
  members: Array<{ id: string; name: string }>;
};

function groupView(ctx: AdminBotRouteContext, group: AdminBotErrorGroup): AdminBotErrorGroupView {
  return {
    ...group,
    members: group.member_ids.map((id) => ({
      id,
      name: ctx.store.getLabMember(id)?.name ?? id,
    })),
  };
}

/**
 * Files a route handler's own unexpected exception, from the dispatcher in server.ts.
 *
 * Never throws: the caller is already on its way to answering 500 with the original error, and a
 * log that failed to write must not be the error the member is told about instead.
 */
export function recordServerRouteError(
  ctx: AdminBotRouteContext,
  failure: { error: unknown; method: string | undefined; pathname: string },
  principal: AdminBotPrincipal,
): void {
  try {
    const { error } = failure;
    const parsed = parseAdminBotErrorReport({
      // Parsed as a request failure so the method and route survive validation, then filed under
      // the kind no browser is allowed to claim.
      kind: "api",
      message: error instanceof Error ? error.message || error.name : String(error),
      ...(error instanceof Error ? { name: error.name, stack: error.stack } : {}),
      api_method: failure.method ?? "",
      api_path: failure.pathname,
      api_status: 500,
    });
    if (!parsed.ok) {
      return;
    }
    const report: AdminBotErrorReport = { ...parsed.report, kind: "server" };
    ctx.errorLog.record(report, {
      ...(principal.kind === "member" ? { memberId: principalActor(principal) } : {}),
    });
  } catch {
    // See above: the original error is the one that matters.
  }
}

export const errorLogRoutes: readonly Route[] = [
  post(
    "/ui/errors",
    memberOnly(
      async ({ req, res, principal, ctx }) => {
        // Who hit it comes from the session, never from the body, and on a "view as" session it
        // is the admin at the keyboard: an admin's tour must not read as the member's bad day.
        const reporter = principalActor(principal);
        if (!ctx.errorLog.accepts(reporter)) {
          sendJson(res, 429, {
            error: {
              message: `no more than ${adminBotErrorReportsPerMinute} error reports a minute`,
            },
          });
          return;
        }
        const body = readRecord(await readJson(req, ERROR_REPORT_BODY_LIMIT_BYTES));
        const parsed = parseAdminBotErrorReport(body);
        if (!parsed.ok) {
          sendJson(res, 400, { error: { message: parsed.message } });
          return;
        }
        const group = ctx.errorLog.record(parsed.report, { memberId: reporter });
        // The id and count only. The group carries other members' ids, and the reporter is
        // whoever happened to hit the problem, not somebody entitled to read who else did.
        sendJson(res, 200, { recorded: true, id: group.id, count: group.count });
      },
      { status: 401, message: "sign in required" },
    ),
  ),
  get(
    "/ops/errors",
    privilegedOnly(({ res, url, ctx }) => {
      const includeResolved = url.searchParams.get("resolved") === "1";
      const limit = limitParam(url);
      const groups = ctx.errorLog.list({
        includeResolved,
        ...(limit === undefined ? {} : { limit }),
      });
      sendJson(res, 200, { groups: groups.map((group) => groupView(ctx, group)) });
    }),
  ),
  post(
    /^\/ops\/errors\/([^/]+)\/resolve$/u,
    privilegedOnly(({ res, principal, params, ctx }) => {
      const group = ctx.errorLog.resolve(
        decodeURIComponent(params[1] ?? ""),
        principalActor(principal),
      );
      if (!group) {
        sendJson(res, 404, { error: { message: "no such error group" } });
        return;
      }
      sendJson(res, 200, { group: groupView(ctx, group) });
    }),
  ),
];

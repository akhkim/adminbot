import type { AdminBotMemberPrincipal } from "../../workflows/identity/auth.js";
// Requests to the PI: signatures, rec letters, meeting requests, and the call sheet.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import {
  previewCallSheetPush,
  proposeCallSheetPush,
  queueCallSheetRow,
} from "../server.call-sheet.js";
import { readJsonOrEmpty, sendJson, sendServiceResult } from "../server.http.js";
import { handleLogisticsRoute } from "../server.logistics.js";
import type { AdminBotRouteContext } from "./context.js";
import { adminSessionOnly, memberOnly, principalActor, privilegedOnly } from "./guards.js";
import { post, route, type Route, under } from "./router.js";
import { principalRole, sendNotModified, versionEtag } from "./version-etag.js";

/**
 * GET /logistics/requests is the stored rows, scoped to the caller unless they are an admin,
 * filtered, sorted and paged by the query. Nothing in it reads the clock or a setting, so the
 * store's logistics version, the scope and the query string are every input.
 */
function logisticsQueueEtag(
  ctx: AdminBotRouteContext,
  principal: AdminBotMemberPrincipal,
  url: URL,
): string | undefined {
  const version = (ctx.store as { logisticsVersion?(): string }).logisticsVersion?.();
  if (version === undefined) {
    return undefined;
  }
  const isAdmin = principal.member.privilege_level === "admin";
  return versionEtag("logistics.requests", [
    version,
    principalRole(principal),
    isAdmin ? null : principal.member.id,
    url.search,
  ]);
}

export const logisticsRoutes: readonly Route[] = [
  route(
    "*",
    under("/logistics/requests"),
    memberOnly(async ({ req, res, url, ctx, principal }) => {
      const { service } = ctx;
      const etag =
        req.method === "GET" && url.pathname === "/logistics/requests"
          ? logisticsQueueEtag(ctx, principal, url)
          : undefined;
      if (etag && sendNotModified(res, etag)) {
        return;
      }
      const callSheetForSubmit = ctx.autoQueueMeetingRequests ? ctx.callSheet : undefined;
      await handleLogisticsRoute(
        req,
        res,
        url,
        ctx.service,
        principal.member,
        callSheetForSubmit
          ? (requestId) =>
              queueCallSheetRow(service, callSheetForSubmit, principalActor(principal), requestId)
          : undefined,
        etag,
      );
    }),
  ),
  // The WhatsApp call queue: which open `book_meeting` requests have a doc prep document that can
  // actually be opened, and a proposal to put those on Zhijing's tab. Admin-gated on both verbs --
  // GET names every member with an open call request and what they want to talk about, which is
  // not the requester's own data, and POST reaches Google.
  route(
    ["GET", "POST"],
    "/logistics/call-sheet",
    adminSessionOnly(async ({ req, res, ctx, principal }) => {
      const { service } = ctx;
      if (!ctx.callSheet) {
        sendJson(res, 503, {
          error: {
            message:
              "this deployment has no call spreadsheet configured; set ADMINBOT_CALL_SHEET_ID",
          },
        });
        return;
      }
      const requestIds =
        req.method === "POST"
          ? ((await readJsonOrEmpty(req)) as { request_ids?: string[] }).request_ids
          : undefined;
      const options = requestIds?.length ? { request_ids: requestIds } : {};
      const callResult =
        req.method === "GET"
          ? await previewCallSheetPush(service, ctx.callSheet, options)
          : await proposeCallSheetPush(service, ctx.callSheet, principalActor(principal), options);
      if ("error" in callResult) {
        sendJson(res, callResult.error.status, { error: { message: callResult.error.message } });
        return;
      }
      sendJson(res, 200, callResult);
    }),
  ),
  post(
    "/logistics/rec-letter-channel/run",
    privilegedOnly(async ({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, await service.syncRecLetterChannel(principalActor(principal)));
    }),
  ),
  post(
    "/logistics/rec-letter-reminders/run",
    privilegedOnly(async ({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, await service.sweepRecLetterReminders(principalActor(principal)));
    }),
  ),
];

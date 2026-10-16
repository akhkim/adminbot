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
import { del, get, post, route, type Route, under } from "./router.js";
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
  // Recommendation-letter eligibility. Advisory: nothing here gates a request. The member's own
  // read is its own path so no query parameter can turn it into a read of somebody else.
  get(
    "/logistics/eligibility/me",
    memberOnly(({ res, ctx, principal }) => {
      sendServiceResult(res, ctx.service.recLetterEligibility().own(principal.member.id));
    }),
  ),
  get(
    "/logistics/eligibility/summary",
    adminSessionOnly(({ res, url, ctx }) => {
      const memberIds = (url.searchParams.get("member_ids") ?? "").split(",");
      sendServiceResult(res, ctx.service.recLetterEligibility().summaries(memberIds));
    }),
  ),
  get(
    "/logistics/eligibility",
    adminSessionOnly(({ res, url, ctx }) => {
      sendServiceResult(
        res,
        ctx.service.recLetterEligibility().forAdmin({
          member_id: url.searchParams.get("member_id") ?? undefined,
          request_id: url.searchParams.get("request_id") ?? undefined,
        }),
      );
    }),
  ),
  // The freezes themselves: an admin's record, notes included, so admin sessions only -- the
  // service token has no person behind it to own an entry that withholds somebody's letter.
  route(
    ["GET", "POST"],
    "/logistics/freeze-incidents",
    adminSessionOnly(async ({ req, res, url, ctx, principal }) => {
      if (req.method === "GET") {
        sendServiceResult(
          res,
          ctx.service
            .recLetterEligibility()
            .listIncidents(url.searchParams.get("member_id") ?? undefined),
        );
        return;
      }
      sendServiceResult(
        res,
        ctx.service
          .recLetterEligibility()
          .createIncident(await readJsonOrEmpty(req), principalActor(principal)),
      );
    }),
  ),
  del(
    /^\/logistics\/freeze-incidents\/([^/]+)$/,
    adminSessionOnly(({ res, ctx, principal, params }) => {
      sendServiceResult(
        res,
        ctx.service
          .recLetterEligibility()
          .deleteIncident(decodeURIComponent(params[1] ?? ""), principalActor(principal)),
      );
    }),
  ),
  // An admin's confirmation that a member meets a criterion the records cannot show. Admin
  // sessions only, like the freezes: each entry has a named admin behind it and a note.
  route(
    ["GET", "POST"],
    "/logistics/eligibility-attestations",
    adminSessionOnly(async ({ req, res, url, ctx, principal }) => {
      if (req.method === "GET") {
        sendServiceResult(
          res,
          ctx.service
            .recLetterEligibility()
            .listAttestations(url.searchParams.get("member_id") ?? undefined),
        );
        return;
      }
      sendServiceResult(
        res,
        ctx.service
          .recLetterEligibility()
          .createAttestation(await readJsonOrEmpty(req), principalActor(principal)),
      );
    }),
  ),
  del(
    /^\/logistics\/eligibility-attestations\/([^/]+)$/,
    adminSessionOnly(({ res, ctx, principal, params }) => {
      sendServiceResult(
        res,
        ctx.service
          .recLetterEligibility()
          .deleteAttestation(decodeURIComponent(params[1] ?? ""), principalActor(principal)),
      );
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

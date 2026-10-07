// Settings, feedback, notifications, tab usage, and operator health reads.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import type { AdminBotSettingsInput } from "../../contracts/actions.js";
import { readLlmGatewayStatus } from "../../kernel/llm-gateway-client.js";
import {
  asString,
  readJson,
  readJsonOrEmpty,
  readRecord,
  sendJson,
  sendServiceResult,
} from "../server.http.js";
import { adminSessionOnly, memberOnly, principalActor, privilegedOnly } from "./guards.js";
import { asDays, limitParam } from "./query-params.js";
import { get, post, put, route, type Route } from "./router.js";

export const workspaceRoutes: readonly Route[] = [
  get("/ops/llm-load", async ({ res, ctx }) => {
    if (!process.env.LLM_GATEWAY_URL) {
      sendJson(res, 200, ctx.llmRouter.status());
      return;
    }
    try {
      sendJson(res, 200, await readLlmGatewayStatus());
    } catch {
      sendJson(res, 502, { error: { message: "shared LLM gateway is unreachable" } });
    }
  }),
  get(
    "/ops/failed-requests",
    privilegedOnly(({ res, ctx }) => {
      sendJson(res, 200, { requests: ctx.failedRequestLedger.list(100) });
    }),
  ),
  get(
    "/activity/updates",
    privilegedOnly(({ res, url, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, service.listRecentUpdates(limitParam(url)));
    }),
  ),
  post("/feedback", async ({ req, res, principal, ctx }) => {
    const { service } = ctx;
    // Any authenticated principal may leave feedback -- no privilege check, because a rating is
    // the one write in this service that a plain member is *more* entitled to than an admin. It
    // is not on the anonymous allowlist: the widget only renders on tabs behind a login, and an
    // open write endpoint on a publicly tunnelled service is a spam target for no gain. A public
    // surface that needs it later adds one line to ANONYMOUS_ROUTES, and the service already
    // stores anonymous rows (see adminBotFeedbackId).
    //
    // Who said it comes from the session, never from the body: a caller-named member id would let
    // anyone rate on anyone's behalf.
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.recordFeedback({
        featureId: asString(body.feature_id),
        rating: Number(body.rating),
        ...(typeof body.comment === "string" ? { comment: body.comment } : {}),
        ...(typeof body.github_file === "string" ? { githubFile: body.github_file } : {}),
        ...(principal.kind === "member"
          ? { memberId: principal.member.id, memberName: principal.member.name }
          : {}),
      }),
    );
  }),
  get(
    "/feedback",
    privilegedOnly(({ res, url, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, service.listFeedback(url.searchParams.get("feature_id") ?? undefined));
    }),
  ),
  get(
    "/settings",
    privilegedOnly(({ res, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, service.getSettings());
    }),
  ),
  put(
    "/settings",
    adminSessionOnly(async ({ req, res, ctx }) => {
      const { service } = ctx;
      const body = (await readJson(req)) as AdminBotSettingsInput;
      sendServiceResult(res, service.updateSettings(body));
    }),
  ),
  get(
    "/sensitive-info",
    adminSessionOnly(async ({ res, ctx }) => {
      const { sensitiveInfo } = ctx;
      sendJson(res, 200, await sensitiveInfo.get());
    }),
  ),
  put(
    "/sensitive-info",
    adminSessionOnly(async ({ req, res, ctx }) => {
      const { sensitiveInfo } = ctx;
      const body = readRecord(await readJson(req));
      const markdown = typeof body.markdown === "string" ? body.markdown : "";
      sendJson(res, 200, await sensitiveInfo.update(markdown));
    }),
  ),
  route(
    "*",
    "/notifications",
    memberOnly(({ req, res, principal, ctx }) => {
      const { service } = ctx;
      if (req.method === "GET") {
        sendServiceResult(res, service.listMemberNotifications(principal.member.id));
        return;
      }
      sendJson(res, 405, { error: { message: "method not allowed" } });
    }),
  ),
  post(
    "/notifications/read",
    memberOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const readBody = readRecord(await readJsonOrEmpty(req));
      const ids = Array.isArray(readBody.notification_ids)
        ? readBody.notification_ids.filter((id): id is string => typeof id === "string")
        : undefined;
      sendServiceResult(
        res,
        service.markMemberNotificationsRead(principal.member.id, ids?.length ? ids : undefined),
      );
    }),
  ),
  post(
    "/ui/tab-visits",
    memberOnly(
      async ({ req, res, principal, ctx }) => {
        const { service } = ctx;
        const visitBody = readRecord(await readJsonOrEmpty(req));
        sendServiceResult(
          res,
          service.recordTabVisit(principalActor(principal), {
            tab: asString(visitBody.tab),
            ...(principal.impersonator ? { impersonated: true } : {}),
          }),
        );
      },
      { status: 401, message: "sign in required" },
    ),
  ),
  get(
    "/ui/tab-visits",
    privilegedOnly(({ res, url, ctx }) => {
      const { service } = ctx;
      sendServiceResult(
        res,
        service.tabVisitReport({ days: asDays(url.searchParams.get("days")) }),
      );
    }),
  ),
  get(
    "/ui/tab-visits/rows",
    privilegedOnly(({ res, url, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, service.listTabVisits({ days: asDays(url.searchParams.get("days")) }));
    }),
  ),
];

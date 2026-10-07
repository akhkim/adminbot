// Proposals, approvals, execution, and the audit trail.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import type {
  AdminBotActionProposal,
  AdminBotApprovalRequest,
  AdminBotExecutionRequest,
  AdminBotPrivacyTaskRequest,
  AdminBotRemovePendingRequest,
} from "../../contracts/actions.js";
import { readJson, sendJson, sendServiceResult } from "../server.http.js";
import {
  adminSessionOnly,
  approverIdentityFor,
  privilegedOnly,
  requireMemberPrivileged,
} from "./guards.js";
import { limitParam } from "./query-params.js";
import { get, post, type Route } from "./router.js";

export const governanceRoutes: readonly Route[] = [
  post("/proposals", async ({ req, res, ctx }) => {
    const { service } = ctx;
    const body = (await readJson(req)) as AdminBotActionProposal;
    sendServiceResult(res, service.createProposal(body));
  }),
  post("/privacy/tasks", async ({ req, res, ctx }) => {
    const { privacyBroker } = ctx;
    const body = (await readJson(req)) as AdminBotPrivacyTaskRequest;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once("close", cancel);
    try {
      sendJson(res, 200, await privacyBroker.handle(body, controller.signal));
    } finally {
      res.off("close", cancel);
    }
  }),
  get(
    "/proposals/pending",
    privilegedOnly(({ res, url, ctx }) => {
      const { service } = ctx;
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit ? Number(rawLimit) : undefined;
      sendServiceResult(res, service.listPending(limit));
    }),
  ),
  post(/^\/proposals\/([^/]+)\/remove$/u, async ({ req, res, principal, ctx, params }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const actionId = decodeURIComponent(params[1]);
    const body = (await readJson(req)) as AdminBotRemovePendingRequest;
    // The note is client-authored; the actor is not. Keeping the two separate prevents an admin
    // from forging another member's identity in the immutable proposal audit trail.
    sendServiceResult(
      res,
      service.removePending(actionId, { ...body, actor: principal.member.id }),
    );
  }),
  post(
    /^\/approvals\/([^/]+)\/approve$/u,
    adminSessionOnly(async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      const actionId = decodeURIComponent(params[1]);
      const body = (await readJson(req)) as AdminBotApprovalRequest;
      // Role and approver id come from the session, never the body: a client-chosen role would make
      // the policy check self-attested, and a client-chosen id would let one person fill a
      // two-person quorum alone.
      const identity = approverIdentityFor(principal);
      if (!identity) {
        sendJson(res, 403, {
          error: {
            message:
              "approvals require an admin or core member session and cannot be recorded by the service principal",
          },
        });
        return;
      }
      sendServiceResult(res, service.approve(actionId, { ...body, ...identity }));
    }),
  ),
  post(
    /^\/actions\/([^/]+)\/execute$/u,
    adminSessionOnly(async ({ req, res, params, ctx }) => {
      const { service } = ctx;
      const actionId = decodeURIComponent(params[1]);
      const body = (await readJson(req)) as AdminBotExecutionRequest;
      sendServiceResult(res, await service.execute(actionId, body));
    }),
  ),
  get(
    "/audit",
    privilegedOnly(({ res, url, ctx }) => {
      const events = ctx.service.listAuditEvents();
      sendJson(res, 200, { events: events.slice(-(limitParam(url) ?? events.length)) });
    }),
  ),
];

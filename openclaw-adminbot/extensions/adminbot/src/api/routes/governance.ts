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
import { pageFrom, readPageQuery } from "../server.paging.js";
import { mapPayload } from "../server.paper-lists.wire.js";
import { proposalSummaryWire } from "../server.proposals.wire.js";
import {
  adminSessionOnly,
  approverIdentityFor,
  privilegedOnly,
  requireMemberPrivileged,
} from "./guards.js";
import { limitParam } from "./query-params.js";
import type { AdminBotPrincipal } from "./context.js";
import { get, post, type Route } from "./router.js";

/** How many of the newest audit events GET /audit sends when the caller gives no `limit`. */
export const AUDIT_DEFAULT_LIMIT = 1000;

// Member actions (enroll, remove, ...) write privilege straight to the roster when executed, past
// the PUT checks that keep a CLI pilot token from changing anyone's access. File, approve and
// execute them in the browser.
function pilotTokenMemberAction(principal: AdminBotPrincipal, type: unknown): boolean {
  return (
    principal.kind === "member" &&
    principal.apiToken?.role === "power_user" &&
    typeof type === "string" &&
    type.startsWith("lab_member.")
  );
}

const PILOT_MEMBER_ACTION_MESSAGE = "Use your browser to file, approve or run member changes";

export const governanceRoutes: readonly Route[] = [
  post("/proposals", async ({ req, res, ctx, principal }) => {
    const { service } = ctx;
    const body = (await readJson(req, 3_000_000)) as AdminBotActionProposal;
    if (pilotTokenMemberAction(principal, (body as { type?: unknown } | null)?.type)) {
      sendJson(res, 403, { error: { message: PILOT_MEMBER_ACTION_MESSAGE } });
      return;
    }
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
      // Oldest first, as the queue is worked: the panel shows 25 and asks for the next 25. `total`
      // is the whole queue, so the badge and "Select all" never read the page as the queue.
      const page = readPageQuery(url, { defaultLimit: 25, maxLimit: 100 });
      const pending = mapPayload(service.listPending(page.limit, page.offset), ({ proposals }) => {
        const { items, ...rest } = pageFrom(proposals, ctx.store.countPending(), page);
        return { proposals: items, ...rest };
      });
      // Opt-in so the gateway tool and older consoles, which read the payload, keep it.
      sendServiceResult(
        res,
        url.searchParams.get("view") === "summary"
          ? mapPayload(pending, ({ proposals, ...rest }) => ({
              proposals: proposals.map(proposalSummaryWire),
              ...rest,
            }))
          : pending,
      );
    }),
  ),
  // The dashboard's attention cards say only how many proposals and held emails are waiting, so
  // they read two numbers here instead of the full queues -- the email list in particular is
  // built alongside a PaperFlow stage sweep that the cards never show. The proposal number is the
  // whole queue: it used to stop at the 50 the panel loaded, and the panel now pages past that.
  get(
    "/admin/queue-counts",
    adminSessionOnly(({ res, ctx }) => {
      sendJson(res, 200, {
        pending_proposals: ctx.store.countPending(),
        email_reviews: ctx.store.listEmailReviews().length,
      });
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
      if (pilotTokenMemberAction(principal, ctx.store.getProposal(actionId)?.type)) {
        sendJson(res, 403, { error: { message: PILOT_MEMBER_ACTION_MESSAGE } });
        return;
      }
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
    adminSessionOnly(async ({ req, res, params, ctx, principal }) => {
      const { service } = ctx;
      const actionId = decodeURIComponent(params[1]);
      if (pilotTokenMemberAction(principal, ctx.store.getProposal(actionId)?.type)) {
        sendJson(res, 403, { error: { message: PILOT_MEMBER_ACTION_MESSAGE } });
        return;
      }
      const body = (await readJson(req)) as AdminBotExecutionRequest;
      sendServiceResult(res, await service.execute(actionId, body));
    }),
  ),
  get(
    "/audit",
    privilegedOnly(({ res, url, ctx }) => {
      // The log grows without bound (tens of thousands of events, megabytes of JSON), so a read
      // that does not say how many gets the newest AUDIT_DEFAULT_LIMIT. `?limit=all` is the whole
      // log, for an export; `total` says how many there are, so a short answer is visibly short.
      const events = ctx.service.listAuditEvents();
      const limit =
        url.searchParams.get("limit") === "all"
          ? events.length
          : (limitParam(url) ?? AUDIT_DEFAULT_LIMIT);
      sendJson(res, 200, {
        events: limit >= events.length ? events : events.slice(-limit),
        total: events.length,
      });
    }),
  ),
];

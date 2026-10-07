// Deadline proposals, deadline recommendations, and the Opportunities board.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import type { DeadlineProposalInput } from "../../contracts/deadline-proposals.js";
import {
  type AdminBotOpportunityInput,
  isAdminBotOpportunityCategory,
} from "../../contracts/opportunities.js";
import { DEADLINE_VENUES } from "../../workflows/deadlines/generated/dataset.js";
import { handleDeadlineExtraction } from "../server.deadline-extraction.js";
import { handleDeadlineRecommendationRoute } from "../server.deadline-recommendations.js";
import { asString, readJson, readRecord, sendJson, sendServiceResult } from "../server.http.js";
import {
  adminSessionOnly,
  approverIdentityFor,
  memberOnly,
  principalActor,
  privilegedOnly,
  requireMemberPrivileged,
} from "./guards.js";
import { del, get, post, put, route, type Route, under } from "./router.js";

export const deadlinesRoutes: readonly Route[] = [
  post("/internal/deadlines/extract-schedule", async ({ req, res, principal }) => {
    if (principal.kind !== "service") {
      sendJson(res, 403, { error: { message: "The collection service token is required." } });
      return;
    }
    await handleDeadlineExtraction(req, res);
  }),
  route("*", under("/deadline-recommendations"), async ({ req, res, url, ctx, principal }) => {
    const { service } = ctx;
    if (principal.kind !== "member" || principal.impersonator) {
      sendJson(res, 403, {
        error: { message: "Use your own member session to recommend a deadline." },
      });
      return;
    }
    await handleDeadlineRecommendationRoute(req, res, url, service, principal.member.id);
  }),
  post(
    "/deadline-proposals",
    memberOnly(
      async ({ req, res, principal, ctx }) => {
        const { service } = ctx;
        const body = readRecord(await readJson(req));
        const idempotencyKey = String(req.headers["idempotency-key"] ?? "").trim();
        sendServiceResult(
          res,
          service.submitDeadlineProposal(
            deadlineProposalInput(body),
            principal.member.id,
            idempotencyKey,
            DEADLINE_VENUES,
            undefined,
            asString(body.targetDeadlineId) || undefined,
          ),
        );
      },
      { status: 403, message: "member session required" },
    ),
  ),
  get("/deadline-proposals", ({ res, principal, ctx }) => {
    const { service } = ctx;
    if (principal.kind !== "member") {
      sendJson(res, principal.kind === "anonymous" ? 401 : 403, {
        error: { message: "member session required" },
      });
      return;
    }
    sendServiceResult(
      res,
      service.listDeadlineProposals(
        principal.member.privilege_level === "admin" ? undefined : principal.member.id,
      ),
    );
  }),
  post(
    /^\/deadline-proposals\/([^/]+)\/revisions$/u,
    async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
        return;
      }
      const body = readRecord(await readJson(req));
      sendServiceResult(
        res,
        service.reviseDeadlineProposal(
          decodeURIComponent(params[1]),
          deadlineProposalInput(body),
          principal.member.id,
          DEADLINE_VENUES,
        ),
      );
    },
  ),
  post(/^\/deadline-proposals\/([^/]+)\/reject$/u, async ({ req, res, principal, ctx, params }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.rejectDeadlineProposal(
        decodeURIComponent(params[1]),
        principal.member.id,
        asString(body.note),
      ),
    );
  }),
  post(
    /^\/deadline-proposals\/([^/]+)\/publish$/u,
    adminSessionOnly(async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      const identity = approverIdentityFor(principal);
      if (!identity) {
        sendJson(res, 403, { error: { message: "a named administrator session is required" } });
        return;
      }
      const body = readRecord(await readJson(req));
      sendServiceResult(
        res,
        await service.publishDeadlineProposal(
          decodeURIComponent(params[1]),
          asString(body.payload_hash),
          { payload_hash: asString(body.payload_hash), ...identity },
        ),
      );
    }),
  ),
  get("/opportunities", ({ res, principal, ctx }) => {
    const { service } = ctx;
    // Anonymous is a real case here, not a fallback: this tab renders for signed-out visitors.
    sendServiceResult(
      res,
      service.listOpportunities(
        principal.kind === "member"
          ? {
              memberId: principal.member.id,
              isAdmin: principal.member.privilege_level === "admin",
            }
          : {},
      ),
    );
  }),
  post(
    "/opportunities",
    memberOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      sendServiceResult(res, service.submitOpportunity(principal.member.id, readOpportunity(body)));
    }),
  ),
  put(
    /^\/opportunities\/([^/]+)$/u,
    memberOnly(async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      sendServiceResult(
        res,
        service.updateOpportunity(decodeURIComponent(params[1]!), readOpportunity(body), {
          memberId: principal.member.id,
          isAdmin: principal.member.privilege_level === "admin",
        }),
      );
    }),
  ),
  del(
    /^\/opportunities\/([^/]+)$/u,
    memberOnly(({ res, principal, params, ctx }) => {
      const { service } = ctx;
      sendServiceResult(
        res,
        service.deleteOpportunity(decodeURIComponent(params[1]!), {
          memberId: principal.member.id,
          isAdmin: principal.member.privilege_level === "admin",
        }),
      );
    }),
  ),
  // Both discovery feeds land here: the hub crawl and, when it lands, the inbox pass. One intake
  // rather than one per feed, so the dedupe and the suppression rule cannot differ between them.
  post(
    "/opportunities/discovered",
    privilegedOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      const discovery = readRecord(body.discovered);
      sendServiceResult(
        res,
        service.submitDiscoveredOpportunity({
          input: readOpportunity(body),
          discovery: {
            feed: asString(discovery.feed) || "web",
            source_url: asString(discovery.source_url),
            evidence: asString(discovery.evidence),
            found_at: new Date().toISOString(),
          },
          actor: principalActor(principal),
        }),
      );
    }),
  ),
  // The refresh sweep files what it read; a human decides. Two routes rather than one because the
  // two callers are different kinds of principal: the sweep runs from cron with the service token
  // and may only propose, while accepting a date onto a board members plan against is an admin act.
  post(
    /^\/opportunities\/([^/]+)\/deadline-proposal$/u,
    privilegedOnly(async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      sendServiceResult(
        res,
        service.proposeOpportunityDeadline({
          opportunityId: decodeURIComponent(params[1]!),
          deadlineAoe: asString(body.deadline_aoe),
          sourceUrl: asString(body.source_url),
          evidence: asString(body.evidence),
          actor: principalActor(principal),
        }),
      );
    }),
  ),
  post(
    /^\/opportunities\/([^/]+)\/deadline-proposal\/decision$/u,
    async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
        return;
      }
      const body = readRecord(await readJson(req));
      sendServiceResult(
        res,
        service.resolveOpportunityDeadlineProposal(
          decodeURIComponent(params[1]!),
          body.accept === true,
          principal.member.id,
        ),
      );
    },
  ),
  post(/^\/opportunities\/([^/]+)\/approve$/u, ({ res, principal, params, ctx }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    sendServiceResult(
      res,
      service.decideOpportunity(decodeURIComponent(params[1]!), "approved", principal.member.id),
    );
  }),
  post(/^\/opportunities\/([^/]+)\/reject$/u, ({ res, principal, params, ctx }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    sendServiceResult(
      res,
      service.decideOpportunity(decodeURIComponent(params[1]!), "rejected", principal.member.id),
    );
  }),
];

export function deadlineProposalInput(body: Record<string, unknown>): DeadlineProposalInput {
  return {
    ...(body.stage !== undefined ? { stage: body.stage as DeadlineProposalInput["stage"] } : {}),
    name: asString(body.name),
    parentConference: asString(body.parentConference),
    parentYear: asString(body.parentYear),
    entryType: asString(body.entryType) as DeadlineProposalInput["entryType"],
    deadlineDate: asString(body.deadlineDate),
    deadlineTime: asString(body.deadlineTime),
    timezone: asString(body.timezone),
    homepageUrl: asString(body.homepageUrl),
    cfpUrl: asString(body.cfpUrl),
    openReviewUrl: asString(body.openReviewUrl),
    note: asString(body.note),
  };
}

/**
 * Reads a submission off the wire, without deciding whether it is any good.
 *
 * Shape only: `validateAdminBotOpportunity` in the contract owns the rules, and both the member and
 * the admin route reach it through the service, so there is one place where "what counts as a valid
 * opportunity" is answered.
 */
export function readOpportunity(body: Record<string, unknown>): Partial<AdminBotOpportunityInput> {
  const category = body.category;
  return {
    name: asString(body.name),
    ...(isAdminBotOpportunityCategory(category) ? { category } : {}),
    deadline_aoe: asString(body.deadline_aoe),
    org: asString(body.org),
    link: asString(body.link),
    eligibility: asString(body.eligibility),
    note: asString(body.note),
    application_window: asString(body.application_window),
  };
}

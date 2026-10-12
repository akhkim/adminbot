// Badges, their assignments, nominations, and suggestions.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import {
  type AdminBotBadgeDefinitionInput,
  type AdminBotBadgeNominationStatus,
  adminBotBadgeNominationStatuses,
  type AdminBotBadgeSuggestionStatus,
  adminBotBadgeSuggestionStatuses,
} from "../../contracts/badges.js";
import { asString, readJson, readRecord, sendJson, sendServiceResult } from "../server.http.js";
import { memberOnly, requireMemberPrivileged } from "./guards.js";
import { del, get, post, put, type Route } from "./router.js";

export const badgesRoutes: readonly Route[] = [
  get("/badges", ({ res, principal, ctx }) => {
    const { service } = ctx;
    if (principal.kind === "anonymous") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    sendServiceResult(res, service.listBadgeDefinitions());
  }),
  post("/badges", async ({ req, res, principal, ctx }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = (await readJson(req)) as AdminBotBadgeDefinitionInput;
    sendServiceResult(res, service.createBadgeDefinition(body, principal.member.id));
  }),
  put(/^\/badges\/([^/]+)$/u, async ({ req, res, principal, ctx, params }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.updateBadgeDefinition(
        decodeURIComponent(params[1]!),
        body as Partial<AdminBotBadgeDefinitionInput>,
        principal.member.id,
      ),
    );
  }),
  post("/badges/assignments", async ({ req, res, principal, ctx }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.assignBadge(
        asString(body.member_id),
        asString(body.badge_id),
        principal.member.id,
        asString(body.evidence) || undefined,
        body.count,
      ),
    );
  }),
  del(/^\/badges\/assignments\/([^/]+)\/([^/]+)$/u, ({ res, principal, params, ctx }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    sendServiceResult(
      res,
      service.removeBadge(
        decodeURIComponent(params[1]!),
        decodeURIComponent(params[2]!),
        principal.member.id,
      ),
    );
  }),
  get(
    "/badges/nominations",
    memberOnly(({ res, url, principal, ctx }) => {
      const { service } = ctx;
      const rawStatus = url.searchParams.get("status");
      const status =
        rawStatus &&
        adminBotBadgeNominationStatuses.includes(rawStatus as AdminBotBadgeNominationStatus)
          ? (rawStatus as AdminBotBadgeNominationStatus)
          : undefined;
      const isAdmin = principal.member.privilege_level === "admin";
      sendServiceResult(
        res,
        service.listBadgeNominations({
          // A member sees both directions: badges put forward for them, and badges they put forward
          // for other people. Without the second half somebody's own nomination would vanish the
          // moment they submitted it, which reads as the form having failed.
          ...(!isAdmin
            ? { involvingMemberId: principal.member.id }
            : url.searchParams.get("member_id")
              ? { memberId: url.searchParams.get("member_id") ?? undefined }
              : {}),
          ...(status ? { status } : {}),
        }),
      );
    }),
  ),
  post(
    "/badges/nominations",
    memberOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      sendServiceResult(
        res,
        // The nominator is the session, never the body. `member_id` names who the badge is *for*,
        // which any member may nominate; who it came *from* is not theirs to claim.
        service.submitBadgeNomination(principal.member.id, {
          badge_id: asString(body.badge_id),
          ...(typeof body.member_id === "string" ? { member_id: body.member_id } : {}),
          ...(typeof body.evidence === "string" ? { evidence: body.evidence } : {}),
        }),
      );
    }),
  ),
  post(/^\/badges\/nominations\/([^/]+)\/approve$/u, ({ res, principal, params, ctx }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    sendServiceResult(
      res,
      service.decideBadgeNomination(
        decodeURIComponent(params[1]!),
        "approved",
        principal.member.id,
      ),
    );
  }),
  post(/^\/badges\/nominations\/([^/]+)\/reject$/u, ({ res, principal, params, ctx }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    sendServiceResult(
      res,
      service.decideBadgeNomination(
        decodeURIComponent(params[1]!),
        "rejected",
        principal.member.id,
      ),
    );
  }),
  get(
    "/badges/suggestions",
    memberOnly(({ res, url, principal, ctx }) => {
      const { service } = ctx;
      const rawStatus = url.searchParams.get("status");
      const status =
        rawStatus &&
        adminBotBadgeSuggestionStatuses.includes(rawStatus as AdminBotBadgeSuggestionStatus)
          ? (rawStatus as AdminBotBadgeSuggestionStatus)
          : undefined;
      const isAdmin = principal.member.privilege_level === "admin";
      sendServiceResult(
        res,
        service.listBadgeSuggestions({
          // A member reads their own suggestions and nobody else's. The queue is a list of things
          // the lab has not decided on, which is an admin's working surface rather than a board --
          // but somebody who filed one has to be able to see it is still there, or the form reads as
          // having swallowed it.
          ...(isAdmin ? {} : { suggestedBy: principal.member.id }),
          ...(status ? { status } : {}),
        }),
      );
    }),
  ),
  post(
    "/badges/suggestions",
    memberOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      sendServiceResult(
        // The suggester is the session, never the body -- the same rule a nomination follows.
        res,
        service.submitBadgeSuggestion(principal.member.id, {
          category: asString(body.category),
          name: asString(body.name),
          description: asString(body.description),
          rationale: asString(body.rationale),
          ...(typeof body.criteria_url === "string" ? { criteria_url: body.criteria_url } : {}),
          ...(typeof body.tier === "string" ? { tier: body.tier } : {}),
        }),
      );
    }),
  ),
  post(/^\/badges\/suggestions\/([^/]+)\/approve$/u, ({ res, principal, params, ctx }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    sendServiceResult(
      res,
      service.decideBadgeSuggestion(
        decodeURIComponent(params[1]!),
        "approved",
        principal.member.id,
      ),
    );
  }),
  post(/^\/badges\/suggestions\/([^/]+)\/reject$/u, ({ res, principal, params, ctx }) => {
    const { service } = ctx;
    if (!requireMemberPrivileged(res, principal) || principal.kind !== "member") {
      return;
    }
    sendServiceResult(
      res,
      service.decideBadgeSuggestion(
        decodeURIComponent(params[1]!),
        "rejected",
        principal.member.id,
      ),
    );
  }),
];

// A member's own record: profile drafts, location, travel, photo, and the self read.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import { redactConfidentialMemberFields } from "../../contracts/actions.js";
import { asString, readJson, readRecord, sendJson, sendServiceResult } from "../server.http.js";
import { handleMemberDraft } from "../server.member-drafts.js";
import { memberOnly, principalActor, privilegedOnly } from "./guards.js";
import { get, post, route, type Route, startingWith } from "./router.js";

export const profileRoutes: readonly Route[] = [
  route(
    "*",
    startingWith("/member-drafts/"),
    memberOnly(
      async ({ req, res, url, ctx, principal }) => {
        await handleMemberDraft(
          req,
          res,
          ctx.memberDrafts,
          principal.member.id,
          url.pathname.slice("/member-drafts/".length),
        );
      },
      { status: 403, message: "Member session required" },
    ),
  ),
  post(
    "/drive/check-edit-access",
    memberOnly(async ({ req, res, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      sendServiceResult(res, await service.checkDriveAccess(asString(body.url)));
    }),
  ),
  get(
    "/lab/members/self",
    memberOnly(
      ({ res, principal, ctx }) => {
        const { service } = ctx;
        const result = service.getLabMemberView(principal.member.id);
        sendServiceResult(
          res,
          result.ok
            ? {
                ...result,
                payload: {
                  member: redactConfidentialMemberFields(result.payload.member, {
                    memberId: principal.member.id,
                    isAdmin: principal.member.privilege_level === "admin",
                    isMemberSession: true,
                  }),
                },
              }
            : result,
        );
      },
      { status: 403, message: "member session required" },
    ),
  ),
  post(
    "/onboarding/ack",
    memberOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      const stepId = asString(body.step_id);
      if (!stepId) {
        sendJson(res, 400, { error: { message: "step_id is required" } });
        return;
      }
      sendServiceResult(res, service.acknowledgeOwnOnboardingStep(principal.member.id, stepId));
    }),
  ),
  get(
    "/profile/location-prompt",
    memberOnly(({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, service.memberLocationDrift(principal.member.id));
    }),
  ),
  post(
    "/profile/location-prompt",
    memberOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      sendServiceResult(
        res,
        service.answerLocationPrompt(principal.member.id, {
          ...(asString(body.current_city) ? { current_city: asString(body.current_city) } : {}),
          ...(asString(body.timezone) ? { timezone: asString(body.timezone) } : {}),
        }),
      );
    }),
  ),
  get(
    "/lab/location-drifts",
    privilegedOnly(({ res, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, service.listLocationDrifts());
    }),
  ),
  post(
    "/profile-photo/review/run",
    privilegedOnly(async ({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(
        res,
        await service.runProfilePhotoReviewAndReminders(principalActor(principal)),
      );
    }),
  ),
  post(
    "/profile-photo/polish",
    memberOnly(async ({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, await service.polishOwnProfilePhoto(principal.member.id));
    }),
  ),
  post(
    "/profile-photo/apply",
    memberOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      const variantId = asString(body.variant_id);
      if (!variantId) {
        sendJson(res, 400, { error: { message: "variant_id is required" } });
        return;
      }
      sendServiceResult(
        res,
        await service.applyOwnPolishedProfilePhoto(principal.member.id, variantId),
      );
    }),
  ),
];

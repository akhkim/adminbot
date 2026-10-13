// The automated email-triage loop and its human review queue.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import { readJson, readRecord, sendJson, sendServiceResult } from "../server.http.js";
import { adminSessionOnly, principalActor, privilegedOnly } from "./guards.js";
import { get, post, type Route } from "./router.js";

export const emailReviewRoutes: readonly Route[] = [
  post(
    "/automation/email/run",
    privilegedOnly(async ({ res, ctx }) => {
      if (!ctx.runEmailAutomation) {
        sendJson(res, 503, { error: { message: "email automation runner is not configured" } });
        return;
      }
      sendJson(res, 200, await ctx.runEmailAutomation());
    }),
  ),
  get(
    "/automation/email/review",
    adminSessionOnly(({ res, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, service.listEmailReviews());
    }),
  ),
  post(
    "/automation/email/review/propose",
    privilegedOnly(({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, service.proposeEmailReviewResolutions(principalActor(principal)));
    }),
  ),
  post(
    /^\/automation\/email\/review\/([^/]+)$/u,
    adminSessionOnly(async ({ req, res, principal, ctx, params }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      const kind = body.kind;
      if (kind !== "dismissed" && kind !== "paperflow_evidence") {
        sendJson(res, 400, { error: { message: "kind must be dismissed or paperflow_evidence" } });
        return;
      }
      sendServiceResult(
        res,
        service.resolveEmailReview({
          messageId: decodeURIComponent(params[1]),
          resolution:
            kind === "dismissed"
              ? { kind }
              : {
                  kind,
                  paper_id: typeof body.paper_id === "string" ? body.paper_id : "",
                  stage: typeof body.stage === "string" ? body.stage : "",
                },
          actor: principalActor(principal),
        }),
      );
    }),
  ),
];

// Reference and integrity checks over manuscripts, and the OpenReview reviewing cycle.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import { readJson, readRecord, sendJson, sendServiceResult } from "../server.http.js";
import { adminSessionOnly, principalActor, privilegedOnly } from "./guards.js";
import { get, post, route, type Route, startingWith } from "./router.js";

export const reviewsRoutes: readonly Route[] = [
  post(
    "/reference-check/pdf",
    adminSessionOnly(async ({ req, res, ctx, principal }) => {
      await ctx.checkUploadedPdf(req, res, principalActor(principal));
    }),
  ),
  get(
    "/openreview/citation-checks",
    privilegedOnly(({ res, ctx }) => {
      const watch = ctx.openReviewCitationWatch;
      sendJson(res, 200, {
        enabled: Boolean(watch),
        ...(watch ? watch.status() : { running: false }),
        checks: ctx.store.listOpenReviewCitationChecks(),
      });
    }),
  ),
  post(
    "/openreview/citation-checks/run",
    privilegedOnly(async ({ res, ctx }) => {
      const watch = ctx.openReviewCitationWatch;
      if (!watch) {
        sendJson(res, 503, {
          error: {
            message:
              "OpenReview citation checks are off — set ADMINBOT_OPENREVIEW_CITATION_CHECKS=1, OPENREVIEW_USERNAME and OPENREVIEW_PASSWORD",
          },
        });
        return;
      }
      try {
        sendJson(res, 202, await watch.start());
      } catch (error) {
        sendJson(res, 502, {
          error: {
            message:
              error instanceof Error ? error.message : "could not list OpenReview submissions",
          },
        });
      }
    }),
  ),
  get(
    "/openreview/integrity-checks",
    privilegedOnly(({ res, ctx }) => {
      const watch = ctx.iclrIntegrityWatch;
      sendJson(res, 200, {
        enabled: Boolean(watch),
        ...(watch ? watch.status() : { running: false }),
        checks: ctx.store.listPaperAiTextChecks(),
      });
    }),
  ),
  post(
    "/openreview/integrity-checks/run",
    privilegedOnly(async ({ res, ctx }) => {
      const watch = ctx.iclrIntegrityWatch;
      if (!watch) {
        sendJson(res, 503, {
          error: {
            message:
              "ICLR integrity checks are off — set ADMINBOT_ICLR_INTEGRITY_CHECKS=1, PANGRAM_API_KEY, OPENREVIEW_USERNAME and OPENREVIEW_PASSWORD",
          },
        });
        return;
      }
      try {
        sendJson(res, 202, await watch.start());
      } catch (error) {
        sendJson(res, 502, {
          error: {
            message:
              error instanceof Error ? error.message : "could not list OpenReview submissions",
          },
        });
      }
    }),
  ),
  route(
    ["GET", "POST"],
    "/reference-scans",
    privilegedOnly(async ({ req, res, url, ctx }) => {
      if (req.method === "GET") {
        const scan = ctx.referenceScans.get(
          url.searchParams.get("submission_id") ?? "",
          url.searchParams.get("pdf_sha256") ?? "",
        );
        sendJson(res, scan ? 200 : 404, scan ?? { error: { message: "scan not found" } });
        return;
      }
      const body = readRecord(await readJson(req));
      if (typeof body.submission_id !== "string" || typeof body.notify_email !== "string") {
        sendJson(res, 400, { error: { message: "submission_id and notify_email are required" } });
        return;
      }
      try {
        const result = await ctx.referenceScans.propose(body.submission_id, body.notify_email);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 422, {
          error: { message: error instanceof Error ? error.message : "scan proposal failed" },
        });
      }
    }),
  ),
  route(
    "*",
    startingWith("/openreview/"),
    privilegedOnly(async ({ req, res, url, ctx }) => {
      const { service } = ctx;
      if (!ctx.openReviewWorkflow) {
        sendJson(res, 503, { error: { message: "openreview workflow is not configured" } });
        return;
      }
      const workflow = ctx.openReviewWorkflow;
      if (req.method === "GET" && url.pathname === "/openreview/status") {
        sendServiceResult(res, service.listOpenReviewStatus());
        return;
      }
      if (req.method === "POST" && url.pathname === "/openreview/cycle/run") {
        // Dry run unless the caller explicitly asks to send, so a stray trigger of the
        // route reports what it would have done instead of mailing anyone.
        const body = (await readJson(req)) as { send?: boolean } | undefined;
        sendJson(res, 200, await workflow.runCycle({ dryRun: body?.send !== true }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/openreview/load-forms") {
        sendJson(res, 200, { forms: await workflow.loadForms() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/openreview/suggest-reviewers") {
        const venueId = url.searchParams.get("venue");
        if (!venueId) {
          sendJson(res, 400, { error: { message: "venue query parameter is required" } });
          return;
        }
        sendJson(res, 200, { submissions: await workflow.suggestReviewers(venueId) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/openreview/assignments") {
        const body = (await readJson(req)) as {
          venue_id?: string;
          submission?: string;
          reviewer?: string;
          remove?: boolean;
        };
        if (!body?.venue_id || !body?.submission || !body?.reviewer) {
          sendJson(res, 400, {
            error: { message: "venue_id, submission and reviewer are required" },
          });
          return;
        }
        const result = await workflow.applyAssignment({
          venueId: body.venue_id,
          submission: body.submission,
          reviewer: body.reviewer,
          ...(body.remove ? { remove: true } : {}),
        });
        sendJson(res, result.ok === true ? 200 : 502, result);
        return;
      }
      // A path under /openreview/ that none of the above answered.
      sendJson(res, 404, { error: { message: "not found" } });
    }),
  ),
];

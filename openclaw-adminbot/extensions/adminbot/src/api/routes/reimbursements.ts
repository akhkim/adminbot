// The reimbursement assistant and its packet generator.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AdminBotReimbursementBlocked,
  type AdminBotReimbursementRequest,
} from "../../workflows/reimbursements/workflow.js";
import { readJson, readRecord, sendJson, sendServiceResult } from "../server.http.js";
import { memberOnly } from "./guards.js";
import { post, type Route } from "./router.js";
import { submitRouteTask } from "./tasks.js";

export const reimbursementsRoutes: readonly Route[] = [
  post("/reimbursements/converse", async ({ req, res, ctx, principal }) => {
    if (!ctx.reimbursementWorkflow) {
      sendJson(res, 503, { error: { message: "reimbursement workflow is not configured" } });
      return;
    }
    const body = (await readJson(req)) as AdminBotReimbursementRequest;
    await submitRouteTask(req, res, ctx, principal, "reimbursement", body);
  }),
  post(
    "/reimbursements/submit",
    memberOnly(async ({ req, res, ctx, principal }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      const funder = String(body.funder ?? "");
      if (funder !== "DCS" && funder !== "MPI-IS") {
        sendJson(res, 400, { error: { message: "funder must be DCS or MPI-IS" } });
        return;
      }
      const artifacts = Array.isArray(body.artifacts)
        ? body.artifacts.flatMap((entry) => {
            const row = readRecord(entry);
            return typeof row.filename === "string" && typeof row.data_base64 === "string"
              ? [{ filename: row.filename, data_base64: row.data_base64 }]
              : [];
          })
        : [];
      const proof = typeof body.submission_proof === "string" ? body.submission_proof : "";
      const expected = reimbursementPackageProof(ctx.reimbursementSigningKey, funder, artifacts);
      if (
        !/^[a-f0-9]{64}$/u.test(proof) ||
        !timingSafeEqual(Buffer.from(proof), Buffer.from(expected))
      ) {
        sendJson(res, 422, {
          error: {
            message: "Generate and review the reimbursement forms again before sending them.",
          },
        });
        return;
      }
      sendServiceResult(
        res,
        await service.submitReimbursement({
          funder,
          memberId: principal.member.id,
          artifacts,
          ...(typeof body.trip_title === "string" ? { tripTitle: body.trip_title } : {}),
        }),
      );
    }),
  ),
  post("/reimbursements/generate", async ({ req, res, ctx }) => {
    if (!ctx.reimbursementWorkflow) {
      sendJson(res, 503, { error: { message: "reimbursement workflow is not configured" } });
      return;
    }
    const body = (await readJson(req)) as AdminBotReimbursementRequest;
    try {
      const generated = await ctx.reimbursementWorkflow.generate(body);
      const funder = body.funder ?? readRecord(body.draft).funder;
      sendJson(res, 200, {
        ...generated,
        ...(funder === "DCS" || funder === "MPI-IS"
          ? {
              submission_proof: reimbursementPackageProof(
                ctx.reimbursementSigningKey,
                funder,
                generated.artifacts,
              ),
            }
          : {}),
      });
    } catch (error) {
      // A blocked package is an answer, not a fault: 422 with the report, so the page can name
      // every rule that failed and what to supply. Letting this fall through to a 500 would tell
      // the claimant only that something went wrong, which is the state the check exists to end.
      if (error instanceof AdminBotReimbursementBlocked) {
        sendJson(res, 422, { error: { message: error.message }, check: error.check });
        return;
      }
      throw error;
    }
  }),
];

export function reimbursementPackageProof(
  key: Buffer,
  funder: "DCS" | "MPI-IS",
  artifacts: Array<{ filename: string; data_base64: string }>,
): string {
  return createHmac("sha256", key)
    .update(
      JSON.stringify({
        funder,
        artifacts: artifacts.map(({ filename, data_base64 }) => ({ filename, data_base64 })),
      }),
    )
    .digest("hex");
}

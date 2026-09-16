import type { AdminBotRouteContext } from "../api/server.js";
import type { AdminBotPrivacyTaskRequest } from "../contracts/actions.js";
import { draftMemberBlurb } from "../cv-scan.js";
import { askGuidebook } from "../guidebook/ask.js";
import { askMemberGuidebook } from "../guidebook/member-ask.js";
import type { ImportColumnMapper } from "../workflows/papers/import-columns.js";
import type { AdminBotReimbursementRequest } from "../workflows/reimbursements/workflow.js";
import { runPersistentCvScan } from "./cv-scan.js";
import type { TaskRuntime } from "./runtime.js";

export function registerServiceTaskHandlers(runtime: TaskRuntime, ctx: AdminBotRouteContext) {
  runtime.register("privacy", 1, (input, task) =>
    ctx.privacyBroker.handle(input as AdminBotPrivacyTaskRequest, undefined, {
      owner: task.owner,
      wait: true,
    }),
  );
  runtime.register("reimbursement", 1, (input, task) => {
    if (!ctx.reimbursementWorkflow) throw new Error("reimbursement workflow is not configured");
    return ctx.reimbursementWorkflow.converse(input as AdminBotReimbursementRequest, undefined, {
      owner: task.owner,
      wait: true,
    });
  });
  runtime.register("guidebook", 1, (input) =>
    askGuidebook(input as Parameters<typeof askGuidebook>[0], { gate: ctx.inferenceGate }),
  );
  runtime.register("member-guidebook", 1, (input) => {
    const snapshot = input as { question: string; approvedHash: string; indexPath: string };
    if (
      snapshot.approvedHash !== (process.env.ADMINBOT_MEMBER_GUIDEBOOK_SHA256?.trim() ?? "") ||
      snapshot.indexPath !== (process.env.ADMINBOT_MEMBER_GUIDEBOOK_INDEX?.trim() ?? "")
    )
      throw new Error("Member guidebook audience approval changed; submit a new question.");
    return askMemberGuidebook(snapshot.question, { gate: ctx.inferenceGate });
  });
  runtime.register("import-columns", 1, async (input) => ({
    mapping: ctx.importColumnMapper
      ? await ctx.importColumnMapper(input as Parameters<ImportColumnMapper>[0])
      : {},
  }));
  runtime.register("cv.blurb", 1, async (input, task) => {
    const snapshot = input as {
      member_id: string;
      member: Parameters<typeof draftMemberBlurb>[0];
      entries: Parameters<typeof draftMemberBlurb>[1];
    };
    const blurb = await draftMemberBlurb(snapshot.member, snapshot.entries, {
      gate: ctx.inferenceGate,
      owner: task.owner,
      wait: true,
    });
    return { member_id: snapshot.member_id, blurb };
  });
  runtime.register("cv.scan", 1, async () => {
    const scan = await runPersistentCvScan(ctx, ctx.service);
    if (!scan.ok) throw new Error(scan.failure.error.message);
    return scan.result;
  });
}

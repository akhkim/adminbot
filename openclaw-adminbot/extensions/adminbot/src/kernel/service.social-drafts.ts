// Social-draft content rules, cut from service.ts so it stays under its file-size ratchet.
// Pure: the service still owns the paper lookup, the ownership check and every store write.
import { randomUUID } from "node:crypto";
import type { AdminBotSocialDraftRecord } from "../contracts/actions.js";
import { readXThreadDraft } from "../workflows/papers/x-draft.js";

/**
 * Validate a save request and build the new draft record. A thread is the source of truth for
 * an X draft: the stored body is its posts joined, so the two cannot drift.
 */
export function prepareSocialDraft(params: {
  paperId: string;
  platform: string;
  body: string;
  model?: string;
  xThread?: unknown;
  memberId: string;
}): { ok: true; draft: AdminBotSocialDraftRecord } | { ok: false; message: string } {
  if (params.platform !== "x" && params.platform !== "linkedin") {
    return { ok: false, message: "platform must be x or linkedin" };
  }
  let xThread;
  if (params.xThread !== undefined) {
    if (params.platform !== "x") {
      return { ok: false, message: "Only X drafts support threads." };
    }
    try {
      xThread = readXThreadDraft(params.xThread);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }
  const body = xThread ? xThread.posts.map((post) => post.text).join("\n\n") : params.body.trim();
  if (!body) {
    return { ok: false, message: "a draft needs a body" };
  }
  return {
    ok: true,
    draft: {
      // Random suffix, not just the clock: two saves inside the same millisecond would otherwise
      // share an id, and the second would upsert over the first instead of superseding it --
      // losing the very version somebody may already have consented to.
      id: `${params.paperId}-${params.platform}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      paper_id: params.paperId,
      platform: params.platform,
      body,
      ...(xThread ? { x_thread: xThread } : {}),
      generated_at: new Date().toISOString(),
      generated_by_member_id: params.memberId,
      status: "draft",
      ...(params.model ? { model: params.model } : {}),
    },
  };
}

/** A new draft supersedes live drafts on the same platform -- and, for X, the same stage. */
export function socialDraftSupersedes(
  existing: AdminBotSocialDraftRecord,
  draft: AdminBotSocialDraftRecord,
): boolean {
  return (
    existing.platform === draft.platform &&
    existing.status !== "superseded" &&
    (draft.platform !== "x" ||
      (existing.x_thread?.stage ?? "arxiv") === (draft.x_thread?.stage ?? "arxiv"))
  );
}

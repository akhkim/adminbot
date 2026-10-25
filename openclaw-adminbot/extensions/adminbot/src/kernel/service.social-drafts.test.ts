import { describe, expect, it } from "vitest";
import { prepareSocialDraft } from "./service.social-drafts.js";

const base = { paperId: "p1", memberId: "m1" };

describe("prepareSocialDraft", () => {
  it("turns hand-written X text into a numbered thread the editor can open", () => {
    const prepared = prepareSocialDraft({
      ...base,
      platform: "x",
      body: "PruneGround is an EMNLP 2026 Oral!\n\nCome see the talk on Nov 5.",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.draft.x_thread).toEqual({
      stage: "arxiv",
      posts: [
        { text: "1/2 PruneGround is an EMNLP 2026 Oral!" },
        { text: "2/2 Come see the talk on Nov 5." },
      ],
    });
    expect(prepared.draft.body).toBe(
      "1/2 PruneGround is an EMNLP 2026 Oral!\n\n2/2 Come see the talk on Nov 5.",
    );
  });

  it("splits a pasted 900-character post instead of saving one X would refuse", () => {
    const prepared = prepareSocialDraft({
      ...base,
      platform: "x",
      body: "We prune retrieved context while keeping the evidence. ".repeat(16),
    });
    expect(prepared.ok && prepared.draft.x_thread?.posts.length).toBeGreaterThan(3);
  });

  it("keeps an explicit thread and its stage as sent", () => {
    const prepared = prepareSocialDraft({
      ...base,
      platform: "x",
      body: "ignored",
      xThread: { stage: "poster", posts: [{ text: "Come chat." }] },
    });
    expect(prepared.ok && prepared.draft.x_thread).toEqual({
      stage: "poster",
      posts: [{ text: "Come chat." }],
    });
  });

  it("leaves LinkedIn text as one post", () => {
    const prepared = prepareSocialDraft({ ...base, platform: "linkedin", body: "A\n\nB" });
    expect(prepared.ok && prepared.draft).toMatchObject({ body: "A\n\nB" });
    expect(prepared.ok && prepared.draft.x_thread).toBeUndefined();
  });

  it("still refuses an empty draft", () => {
    expect(prepareSocialDraft({ ...base, platform: "x", body: "  " })).toEqual({
      ok: false,
      message: "a draft needs a body",
    });
  });
});

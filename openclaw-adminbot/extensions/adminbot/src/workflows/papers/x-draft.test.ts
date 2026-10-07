import { describe, expect, it } from "vitest";
import { finishXThread, validateXThread, xDraftLength } from "./x-draft.js";

describe("X paper thread", () => {
  it("keeps every author, explicit organizations, links and per-post images", () => {
    const result = finishXThread({
      paper: {
        title: "Paper",
        abstract: "Evidence",
        authors: ["Ada Lovelace", "External Author"],
        url: "https://arxiv.org/abs/2608.27510",
      },
      members: [],
      organizations: [{ name: "Selected lab", x_handle: "@SelectedLab" }],
      posts: [
        {
          text: "A supported finding",
          media: [{ media_id: "123", alt_text: "Comparison of two measured conditions" }],
        },
      ],
    });
    expect(result.posts.map((post) => post.text)).toEqual([
      "1/4 A supported finding",
      "2/4 Authors: Ada Lovelace External Author",
      "3/4 Supported by: @SelectedLab",
      "4/4 Paper: https://arxiv.org/abs/2608.27510",
    ]);
    expect(result.posts[0].media?.[0].media_id).toBe("123");
    expect(result.issues).toHaveLength(2);
  });
  it("rejects empty, oversized and inaccessible image descriptions", () => {
    expect(() => validateXThread([{ text: " " }])).toThrow();
    expect(() => validateXThread([{ text: "x".repeat(281) }])).toThrow();
    expect(() =>
      validateXThread([{ text: "Figure", media: [{ media_id: "123", alt_text: "" }] }]),
    ).toThrow();
    expect(xDraftLength(`See https://example.com/${"x".repeat(400)}`)).toBe(27);
    expect(xDraftLength("你好")).toBe(4);
  });
});

import { describe, expect, it } from "vitest";
import {
  finishXThread,
  validateXThread,
  xDraftLength,
  readXAnnouncement,
  readXThreadDraft,
  readXCredits,
  xAnnouncementPrompt,
} from "./x-draft.js";

describe("X paper thread", () => {
  it("requires confirmed logistics for each conference stage", () => {
    expect(readXAnnouncement(undefined)).toEqual({ stage: "arxiv" });
    expect(() => readXAnnouncement({ stage: "acceptance" })).toThrow("conference name");
    expect(() => readXAnnouncement({ stage: "attendance", venue: "SyntheticConf" })).toThrow(
      "who is attending",
    );
    expect(() => readXAnnouncement({ stage: "poster", venue: "SyntheticConf" })).toThrow(
      "local date/time",
    );
    expect(
      xAnnouncementPrompt({
        stage: "poster",
        venue: "SyntheticConf",
        session: "7 Oct 2026, 10am IST, Hall A, #2",
      }),
    ).toContain("come chat");
    expect(() => readXAnnouncement({ stage: "invented" })).toThrow();
  });
  it("uses research threads for release/acceptance and short invitations for later stages", () => {
    expect(xAnnouncementPrompt({ stage: "arxiv" })).toContain("research-thread template");
    expect(xAnnouncementPrompt({ stage: "acceptance", venue: "SyntheticConf" })).toContain(
      "research-thread template",
    );
    for (const stage of ["attendance", "poster"] as const) {
      const prompt = xAnnouncementPrompt({
        stage,
        venue: "SyntheticConf",
        attendees: "Ada, 9 Oct",
        session: "9 Oct, Hall A",
      });
      expect(prompt).toContain("short invitation template");
      expect(prompt).not.toContain("Start with a concrete question");
    }
  });
  it("keeps figure bytes and rejects remote URLs or missing descriptions", () => {
    const draft = {
      stage: "arxiv",
      posts: [
        {
          text: "1/1 Evidence",
          images: [
            { data_uri: "data:image/png;base64,iVBORw0KGgo=", alt_text: "A synthetic comparison" },
          ],
        },
      ],
    };
    expect(readXThreadDraft(draft)).toEqual(draft);
    expect(() =>
      readXThreadDraft({
        ...draft,
        posts: [
          {
            text: "Evidence",
            images: [{ data_uri: "https://private.example/figure", alt_text: "Figure" }],
          },
        ],
      }),
    ).toThrow("PNG/JPEG");
    expect(() =>
      readXCredits({ organizations: [{ name: "Lab", x_handle: "guess handle!" }] }),
    ).toThrow();
  });
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

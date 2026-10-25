import { describe, expect, it } from "vitest";
import {
  finishXThread,
  validateXThread,
  xDraftLength,
  readXAnnouncement,
  readXThreadDraft,
  readXCredits,
  renumberXThread,
  splitXPostText,
  X_POST_TEXT_BUDGET,
  xAnnouncementPrompt,
  xThreadFromText,
} from "./x-draft.js";

describe("X paper thread", () => {
  it("requires confirmed logistics for each conference stage", () => {
    expect(readXAnnouncement(undefined)).toEqual({ stage: "arxiv" });
    expect(() => readXAnnouncement({ stage: "acceptance" })).toThrow("Fill in the conference");
    expect(() => readXAnnouncement({ stage: "attendance", venue: "SyntheticConf" })).toThrow(
      "who is attending",
    );
    expect(() => readXAnnouncement({ stage: "poster", venue: "SyntheticConf" })).toThrow(
      "local date/time plus the room and poster number or talk slot",
    );
    expect(
      xAnnouncementPrompt({
        stage: "poster",
        venue: "EMNLP 2026 (Oral)",
        session: "Nov 5, Hall B",
      }),
    ).toContain("talk");
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
    ).toThrow("not a PNG or JPEG");
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

describe("long posts and hand-written threads", () => {
  const sentence = "Grounding-aware pruning keeps the evidence the answer depends on. ";

  it("splits an over-long post at sentence boundaries, never mid-word", () => {
    const pieces = splitXPostText(sentence.repeat(10));
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(xDraftLength(piece)).toBeLessThanOrEqual(X_POST_TEXT_BUDGET);
      expect(piece.endsWith(".")).toBe(true);
    }
    expect(pieces.join(" ")).toBe(sentence.repeat(10).trim());
  });

  it("falls back to word boundaries for one huge sentence", () => {
    const pieces = splitXPostText("word ".repeat(120));
    expect(pieces.length).toBe(3);
    expect(pieces.every((piece) => !piece.startsWith(" ") && !piece.endsWith(" "))).toBe(true);
  });

  it("keeps a short post as is", () => {
    expect(splitXPostText("  Short.  ")).toEqual(["Short."]);
    expect(splitXPostText("   ")).toEqual([]);
  });

  it("turns pasted text into posts at blank lines and drops typed numbering", () => {
    const thread = xThreadFromText(
      "1/3 PruneGround is an EMNLP 2026 Oral!\r\n\r\n2/3 It keeps the evidence.\n\n\n3/ Come see the talk.",
    );
    expect(thread).toEqual([
      { text: "1/3 PruneGround is an EMNLP 2026 Oral!" },
      { text: "2/3 It keeps the evidence." },
      { text: "3/3 Come see the talk." },
    ]);
    expect(xThreadFromText("Just one post.")).toEqual([{ text: "Just one post." }]);
    expect(() => validateXThread(xThreadFromText("A long one. ".repeat(80)))).not.toThrow();
  });

  it("finishes a thread whose model post ran long instead of throwing it away", () => {
    const finished = finishXThread({
      posts: [{ text: sentence.repeat(8) }],
      paper: { title: "PruneGround", authors: [], abstract: "Evidence." },
      members: [],
    });
    expect(finished.posts.length).toBeGreaterThan(1);
    expect(() => validateXThread(finished.posts)).not.toThrow();
    expect(finished.posts[0]?.text.startsWith("1/")).toBe(true);
  });

  it("names the post and the fix in every refusal", () => {
    expect(() => validateXThread([{ text: "ok" }, { text: " " }])).toThrow(
      "Post 2 is empty. Write something in it or remove it.",
    );
    expect(() => validateXThread([{ text: "x".repeat(281) }])).toThrow(
      "Post 1 is 281 characters; X allows 280",
    );
    expect(() =>
      validateXThread([
        {
          text: "ok",
          images: [{ data_uri: "data:image/png;base64,iVBORw0KGgoAAAA", alt_text: " " }],
        },
      ]),
    ).toThrow("Post 1, figure 1 needs alt text");
  });
});

describe("renumberXThread", () => {
  it("drops cleared posts, splits grown ones and renumbers", () => {
    const posts = renumberXThread([
      { text: "1/3 Hook." },
      { text: "2/3 " },
      { text: `3/3 ${"A finding that grew. ".repeat(20)}` },
    ]);
    expect(posts[0]?.text).toBe(`1/${posts.length} Hook.`);
    expect(posts.length).toBeGreaterThan(2);
    expect(
      posts.every((post, index) => post.text.startsWith(`${index + 1}/${posts.length} `)),
    ).toBe(true);
    expect(() => validateXThread(posts)).not.toThrow();
  });

  it("keeps figures on the first piece and keeps a figure-only post for validation to name", () => {
    const image = { data_uri: "data:image/png;base64,iVBORw0KGgoAAAA", alt_text: "Chart" };
    const posts = renumberXThread([{ text: "", images: [image] }, { text: "Text." }]);
    expect(posts[0]).toEqual({ text: "", images: [image] });
    expect(() => validateXThread(posts)).toThrow("Post 1 is empty");
  });

  it("leaves a lone post unnumbered", () => {
    expect(renumberXThread([{ text: "1/1 Come chat." }])).toEqual([{ text: "Come chat." }]);
  });
});

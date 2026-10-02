import { describe, expect, it, vi } from "vitest";
import { reviewOpenReviewIdentity } from "./openreview-identity.js";
import { createOpenReviewForumProbe } from "./openreview-notes.js";

const abstract =
  "We study how causal models can guide resource allocation in changing environments. Our method combines intervention data with observational measurements to estimate the effects of alternative planning decisions. Experiments across several simulated environments show that the proposed approach improves allocation quality while reducing sensitivity to distribution shifts. We analyze the assumptions required for identification and discuss limitations when important variables remain unobserved.";
const otherAbstract =
  "This paper presents a new approach to image compression using frequency domain representations and adaptive quantization. The encoder learns a compact representation of visual information under a fixed transmission budget. We evaluate reconstruction quality using perceptual metrics and compare the results with established compression standards. Our experiments cover natural photographs and medical scans with varying spatial resolutions and distinct noise characteristics.";
const note = (id = "Current123", overrides: Record<string, unknown> = {}) => ({
  id,
  forum: id,
  cdate: 2000,
  content: {
    title: { value: "Causal resource allocation" },
    abstract: { value: abstract },
    authorids: { value: ["~Ada_Example1"] },
  },
  ...overrides,
});
const older = (id = "Earlier123", overrides: Record<string, unknown> = {}) =>
  note(id, {
    cdate: 1000,
    content: {
      title: { value: "Planning in gardens" },
      abstract: { value: abstract },
      authorids: { value: ["~Ada_Example1"] },
    },
    ...overrides,
  });
const response = (notes: unknown[]) => new Response(JSON.stringify({ notes }));

describe("public abstract comparison", () => {
  it("finds a renamed earlier submission through the actual probe and explains the evidence", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("?id=") ? response([note()]) : response([older()]),
    );
    const result = await createOpenReviewForumProbe({ fetchImpl })("Current123");
    expect(result).toMatchObject({
      status: "found",
      identity_review: {
        status: "checked",
        examined: 1,
        candidates: [
          {
            id: "Earlier123",
            title: "Planning in gardens",
            abstract_overlap: 100,
            shared_authors: ["~Ada_Example1"],
          },
        ],
      },
    });
    expect(String(fetchImpl.mock.calls[1][0])).toContain("content.authorids=%7EAda_Example1");
  });

  it("requires content overlap, public author overlap, and an earlier date", async () => {
    const sameTitleDifferentContent = older("Unrelated123", {
      content: { ...note().content, abstract: { value: otherAbstract } },
    });
    const noSharedAuthor = older("OtherAuthor123", {
      content: { ...note().content, authorids: { value: ["~Bob_Example1"] } },
    });
    const result = await reviewOpenReviewIdentity(
      note(),
      async () =>
        response([
          sameTitleDifferentContent,
          noSharedAuthor,
          note("Future123", { cdate: 3000 }),
          older("Reply123", { replyto: "Earlier123", forum: "Earlier123" }),
          older("Undated123", { cdate: undefined }),
        ]),
      "https://api2.openreview.net",
    );
    expect(result).toMatchObject({ status: "checked", examined: 1, candidates: [] });
  });

  it("recognizes a revised abstract with a different title", async () => {
    const result = await reviewOpenReviewIdentity(
      note(),
      async () =>
        response([
          older("Revised123", {
            content: {
              ...older().content,
              abstract: {
                value:
                  abstract.replace("allocation quality", "planning outcomes") +
                  " Additional analyses explore robustness.",
              },
            },
          }),
        ]),
      "https://api2.openreview.net",
    );
    expect(result.candidates[0]?.abstract_overlap).toBeGreaterThanOrEqual(65);
    expect(result.candidates[0]?.abstract_overlap).toBeLessThan(100);
  });

  it.each([
    { ...note().content, authorids: { value: ["Anonymous", "private@example.org"] } },
    { ...note().content, abstract: { value: "Too short for a reliable content comparison." } },
    { ...note().content, abstract: { value: "word ".repeat(100) } },
  ])("does not search without sufficient public evidence", async (content) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(
      await reviewOpenReviewIdentity(note("Current123", { content }), fetchImpl, ""),
    ).toMatchObject({ status: "insufficient" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds searches, deduplicates results, and exposes partial coverage", async () => {
    const source = note("Current123", {
      content: {
        ...note().content,
        authorids: { value: ["~Ada_Example1", "~Bob_Example1", "~Cara_Example1", "~Dan_Example1"] },
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => response([older(), older()]));
    const result = await reviewOpenReviewIdentity(source, fetchImpl, "https://api2.openreview.net");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ status: "limited", examined: 1 });
    expect(result.candidates).toHaveLength(1);
  });

  it("reports API failure instead of claiming no prior work", async () => {
    const result = await reviewOpenReviewIdentity(
      note(),
      async () => new Response("", { status: 403 }),
      "https://api2.openreview.net",
    );
    expect(result).toMatchObject({ status: "unavailable", candidates: [] });
  });
});

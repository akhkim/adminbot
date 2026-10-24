import { describe, expect, it, vi } from "vitest";
import { findRelevantLabPapers } from "./lab-relevance-search.js";
import { CONTROL_DOCUMENTS, type LabPaperInput } from "./lab-relevance.js";

function paper(overrides: Partial<LabPaperInput> & { id: string }): LabPaperInput {
  return { title: `Paper ${overrides.id}`, ...overrides };
}

const ON_TOPIC = [0.5, Math.sqrt(0.75), 0];
const OFF_TOPIC = [0, 0, 1];
const QUERY_AXIS = [1, 0, 0];

/**
 * A stand-in for the model that answers from the text alone, so a test can say which papers are
 * about the query without owning a vector space. Anything mentioning causality points at the query
 * axis; the query itself is the axis; everything else is orthogonal to both.
 */
function fakeEmbedder() {
  return vi.fn(async (texts: string[]) =>
    texts.map((text) => {
      if (text.startsWith("task: search result")) {
        return QUERY_AXIS;
      }
      return /causal/iu.test(text) ? ON_TOPIC : OFF_TOPIC;
    }),
  );
}

describe("findRelevantLabPapers", () => {
  it("embeds papers, query segments and controls in a single call, in that order", async () => {
    const embed = fakeEmbedder();
    await findRelevantLabPapers({
      papers: [paper({ id: "a", title: "Causal abstraction" }), paper({ id: "b" })],
      query: "causality",
      embed,
    });
    expect(embed).toHaveBeenCalledTimes(1);
    const sent = embed.mock.calls[0]?.[0] ?? [];
    expect(sent).toHaveLength(2 + 1 + CONTROL_DOCUMENTS.length);
    expect(sent[0]).toContain("Causal abstraction");
    expect(sent[2]?.startsWith("task: search result")).toBe(true);
    expect(sent[3]).toContain(CONTROL_DOCUMENTS[0]!.title);
  });

  it("ranks the paper the query is about and leaves the other off-topic", async () => {
    const report = await findRelevantLabPapers({
      papers: [paper({ id: "a", title: "Causal abstraction" }), paper({ id: "b" })],
      query: "causality",
      embed: fakeEmbedder(),
    });
    expect(report.matches.map((match) => match.paper_id)).toEqual(["a"]);
    expect(report.off_topic.map((match) => match.paper_id)).toEqual(["b"]);
    expect(report.scored).toBe(2);
    expect(report.query_kind).toBe("keywords");
  });

  it("skips embedding a paper the caller already holds a vector for, keeping the rest aligned", async () => {
    const embed = fakeEmbedder();
    const report = await findRelevantLabPapers({
      papers: [
        paper({ id: "cached" }),
        paper({ id: "fresh", title: "Causal abstraction" }),
        paper({ id: "other" }),
      ],
      query: "causality",
      embed,
      vectorFor: (entry) => (entry.id === "cached" ? ON_TOPIC : undefined),
    });
    // Two papers embedded rather than three, and the cached vector still lands on its own paper.
    const sent = embed.mock.calls[0]?.[0] ?? [];
    expect(sent).toHaveLength(2 + 1 + CONTROL_DOCUMENTS.length);
    expect(report.matches.map((match) => match.paper_id).toSorted()).toEqual(["cached", "fresh"]);
  });

  it("splits a proposal into sections and says which of them nothing covers", async () => {
    const report = await findRelevantLabPapers({
      papers: [paper({ id: "a", title: "Causal abstraction" })],
      query: [
        "# Causal representation learning",
        "Recovering causal structure from model internals.",
        "",
        "# Compute governance",
        "Reporting thresholds for frontier training runs.",
      ].join("\n"),
      embed: fakeEmbedder(),
    });
    expect(report.query_kind).toBe("proposal");
    expect(report.segment_count).toBe(2);
    // The fake points every segment at the same axis, so both are covered; the assertion that
    // matters is that sections are tracked individually rather than collapsed into one query.
    expect(report.matches[0]?.segments).toHaveLength(2);
    expect(report.uncovered_segments).toEqual([]);
  });

  it("throws rather than misaligning when the embedder returns the wrong number of vectors", async () => {
    await expect(
      findRelevantLabPapers({
        papers: [paper({ id: "a" })],
        query: "causality",
        embed: async () => [QUERY_AXIS],
      }),
    ).rejects.toThrow(/returned 1 vectors for 8 inputs/u);
  });

  it("returns an unscored report for an empty query without calling the model", async () => {
    const embed = fakeEmbedder();
    const report = await findRelevantLabPapers({
      papers: [paper({ id: "a" }), paper({ id: "b" })],
      query: "   ",
      embed,
    });
    expect(embed).not.toHaveBeenCalled();
    expect(report.matches).toEqual([]);
    expect(report.nothing_relevant).toBe(false);
    // The corpus size survives, so a caller can say "0 of 2" rather than "0 of 0".
    expect(report.scored).toBe(2);
  });

  it("returns an empty report for an empty corpus without calling the model", async () => {
    const embed = fakeEmbedder();
    const report = await findRelevantLabPapers({ papers: [], query: "causality", embed });
    expect(embed).not.toHaveBeenCalled();
    expect(report.scored).toBe(0);
  });
});

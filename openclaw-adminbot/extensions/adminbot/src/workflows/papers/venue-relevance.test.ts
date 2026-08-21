import { describe, expect, it } from "vitest";
import type { OpenReviewPaper } from "../../connectors/openreview-notes.js";
import {
  ABSOLUTE_FLOOR,
  cosineSimilarity,
  interestTerms,
  interestsEmbeddingText,
  interestsFromTopics,
  overlappingKeywords,
  paperEmbeddingText,
  rankPapers,
} from "./venue-relevance.js";

function paper(overrides: Partial<OpenReviewPaper> & { id: string }): OpenReviewPaper {
  return {
    title: `Paper ${overrides.id}`,
    abstract: "",
    keywords: [],
    venue: "ICLR 2025 Poster",
    forum_url: `https://openreview.net/forum?id=${overrides.id}`,
    ...overrides,
  };
}

describe("cosineSimilarity", () => {
  it("is 1 for identical directions and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  // Only ever happens when an index was built with a different model than the query. A wrong-
  // looking score beats a crashed search, and the index records its model so the cause is findable.
  it("returns 0 rather than throwing on mismatched or empty vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("paperEmbeddingText", () => {
  // The model's own document form. Both sides must use its prefixes or neither should.
  it("uses the model's document prefixes and names the title separately", () => {
    const text = paperEmbeddingText(
      paper({ id: "a", title: "On Safety", keywords: ["alignment"], abstract: "Body." }),
    );
    expect(text).toBe("title: On Safety | text: Keywords: alignment. Body.");
  });

  it("caps the abstract so a long one cannot crowd out the title and keywords", () => {
    const text = paperEmbeddingText(paper({ id: "a", abstract: "x".repeat(5000) }));
    expect(text.length).toBeLessThan(1000);
  });

  it("omits the sections a venue did not collect", () => {
    expect(paperEmbeddingText(paper({ id: "a", title: "Bare" }))).toBe("title: Bare | text: ");
  });
});

describe("interestTerms", () => {
  // Members write this field every way there is; the roster has all of these shapes in it.
  it("splits on commas, slashes and the word and", () => {
    expect(interestTerms("AI Safety, Reasoning")).toEqual(["ai safety", "reasoning"]);
    expect(interestTerms("causality and RL")).toEqual(["causality", "rl"]);
    expect(interestTerms("NLP/IR")).toEqual(["nlp", "ir"]);
  });

  it("folds case and punctuation so near-duplicates collapse to one term", () => {
    expect(interestTerms("AI Safety, ai safety")).toEqual(["ai safety"]);
  });

  // "RL" and "ML" are between them the most common topics on this roster, so a length floor that
  // dropped them would quietly break the tool for the people most likely to use it.
  it("keeps two-letter acronyms and drops only joining words", () => {
    expect(interestTerms("ML, a, of")).toEqual(["ml"]);
    expect(interestTerms("theory of mind")).toEqual(["theory of mind"]);
  });
});

describe("overlappingKeywords", () => {
  it("matches in both directions, so a broader interest claims a narrower keyword", () => {
    const terms = interestTerms("interpretability");
    expect(overlappingKeywords(["Mechanistic Interpretability", "diffusion"], terms)).toEqual([
      "Mechanistic Interpretability",
    ]);
    // And the reverse: a narrower interest still recognises the broader keyword.
    expect(
      overlappingKeywords(["interpretability"], interestTerms("mechanistic interpretability")),
    ).toEqual(["interpretability"]);
  });

  // The cost of keeping "RL" usable: as a substring it sits inside "world models" and "early
  // stopping", so short terms have to match a whole word or not at all.
  it("does not let a short acronym match inside an unrelated word", () => {
    const terms = interestTerms("RL");
    expect(overlappingKeywords(["world models", "early stopping"], terms)).toEqual([]);
    expect(overlappingKeywords(["RL", "offline RL"], terms)).toEqual(["RL", "offline RL"]);
  });

  it("finds nothing when the member listed no interests", () => {
    expect(overlappingKeywords(["alignment"], [])).toEqual([]);
  });
});

describe("rankPapers", () => {
  // A spread of scores so the median-relative cutoff has something to work with: three clearly
  // on-topic, three clearly not.
  function corpus() {
    return [
      { paper: paper({ id: "a", title: "Alignment", keywords: ["AI safety"] }), vector: [1, 0] },
      { paper: paper({ id: "b", title: "Bijection jailbreaks" }), vector: [0.9, 0.1] },
      { paper: paper({ id: "c", title: "Circuits" }), vector: [0.8, 0.2] },
      { paper: paper({ id: "d", title: "Diffusion" }), vector: [0.3, 0.9] },
      { paper: paper({ id: "e", title: "Estimators" }), vector: [0.2, 0.95] },
      { paper: paper({ id: "f", title: "Flows" }), vector: [0.1, 1] },
    ];
  }

  it("returns the papers above the venue's own cutoff, best first", () => {
    const { results, nothing_relevant } = rankPapers(corpus(), [1, 0], "AI safety");
    expect(nothing_relevant).toBe(false);
    expect(results.map((entry) => entry.paper.id)).toEqual(["a", "b", "c"]);
    expect(results[0]?.matched_keywords).toEqual(["AI safety"]);
  });

  // The reason the cutoff is relative at all: the same member's short interest string and long one
  // produce different score magnitudes, so any constant threshold is wrong for one of them.
  it("selects the same papers whether scores are large or small overall", () => {
    const strong = rankPapers(corpus(), [1, 0], "x");
    // Halving every vector halves every similarity's numerator and denominator alike, but a
    // constant threshold would not survive a corpus that simply scores lower across the board.
    const weak = rankPapers(
      corpus().map((entry) => ({
        paper: entry.paper,
        vector: [entry.vector[0] * 0.5 + 0.4, entry.vector[1]],
      })),
      [1, 0],
      "x",
    );
    expect(weak.results.length).toBeGreaterThan(0);
    expect(weak.results[0]?.paper.id).toBe(strong.results[0]?.paper.id);
  });

  it("reports relevance as 1 for the best match and never outside 0-1", () => {
    const { results } = rankPapers(corpus(), [1, 0], "x");
    expect(results[0]?.relevance).toBeCloseTo(1);
    for (const entry of results) {
      expect(entry.relevance).toBeGreaterThanOrEqual(0);
      expect(entry.relevance).toBeLessThanOrEqual(1);
    }
  });

  // The one case with a real answer for the member: this conference is not about their field.
  it("says nothing is relevant rather than returning the least-bad paper", () => {
    const { results, nothing_relevant } = rankPapers(
      [
        { paper: paper({ id: "a" }), vector: [0, 1] },
        { paper: paper({ id: "b" }), vector: [0, 1] },
      ],
      [1, 0],
      "AI safety",
    );
    expect(results).toEqual([]);
    expect(nothing_relevant).toBe(true);
  });

  it("caps how many come back", () => {
    expect(rankPapers(corpus(), [1, 0], "x", { limit: 1 }).results).toHaveLength(1);
  });

  it("handles an empty venue without claiming it was irrelevant", () => {
    expect(rankPapers([], [1, 0], "x")).toEqual({ results: [], nothing_relevant: false });
  });

  // No spread means no distribution to normalise against; every survivor is equally the best.
  it("reports full relevance when every paper scores the same", () => {
    const flat = [
      { paper: paper({ id: "a", title: "A" }), vector: [1, 0] },
      { paper: paper({ id: "b", title: "B" }), vector: [1, 0] },
    ];
    const { results } = rankPapers(flat, [1, 0], "x");
    expect(results.map((entry) => entry.relevance)).toEqual([1, 1]);
  });

  it("breaks ties by title so repeated searches agree", () => {
    const tied = [
      { paper: paper({ id: "z", title: "Zebra" }), vector: [1, 0] },
      { paper: paper({ id: "a", title: "Aardvark" }), vector: [1, 0] },
    ];
    expect(rankPapers(tied, [1, 0], "x").results.map((entry) => entry.paper.title)).toEqual([
      "Aardvark",
      "Zebra",
    ]);
  });

  // The whole reason for ranking by embedding: a paper can be relevant with no keyword in common.
  it("keeps a semantic match that shares no keyword at all", () => {
    const { results } = rankPapers(corpus(), [1, 0], "AI safety");
    expect(results.some((entry) => entry.matched_keywords.length === 0)).toBe(true);
  });

  it("keeps the sanity floor well under real interests and over foreign ones", () => {
    // Measured against the live model over ICLR 2025: real lab interests top 0.31-0.52,
    // plainly foreign subjects top 0.11-0.26.
    expect(ABSOLUTE_FLOOR).toBeGreaterThan(0.26);
    expect(ABSOLUTE_FLOOR).toBeLessThan(0.31);
  });
});

describe("interestsFromTopics", () => {
  it("joins stored topics into the text the box shows and the query embeds", () => {
    expect(interestsFromTopics(["AI Safety", " Reasoning "])).toBe("AI Safety, Reasoning");
  });

  it("is empty for a member who has set none", () => {
    expect(interestsFromTopics(undefined)).toBe("");
    expect(interestsFromTopics([])).toBe("");
  });
});

describe("interestsEmbeddingText", () => {
  it("uses the model's query prefix, matching the document form", () => {
    expect(interestsEmbeddingText("  AI   Safety, Reasoning ")).toBe(
      "task: search result | query: AI Safety, Reasoning",
    );
  });
});

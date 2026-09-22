import { describe, expect, it } from "vitest";
import {
  bandForMargin,
  classifyLabPapers,
  controlDocumentTexts,
  labPaperEmbeddingText,
  labPaperEvidence,
  parseRelevanceQuery,
  relevanceQueryFromDomains,
  type LabPaperInput,
  type RelevanceQuery,
  type ScoredLabPaper,
} from "./lab-relevance.js";

function paper(overrides: Partial<LabPaperInput> & { id: string }): LabPaperInput {
  return { title: `Paper ${overrides.id}`, ...overrides };
}

/**
 * A unit vector at a chosen cosine to AXIS, so a test can state the similarity it means rather
 * than a set of coordinates whose angle the reader has to work out.
 */
function atCosine(cosine: number): number[] {
  return [cosine, Math.sqrt(Math.max(0, 1 - cosine * cosine)), 0];
}

const AXIS = [1, 0, 0];
/** Orthogonal to AXIS, so a control built from it contributes no noise. */
const ORTHOGONAL = [0, 0, 1];

function keywordQuery(text = "causality"): RelevanceQuery {
  return parseRelevanceQuery(text);
}

describe("parseRelevanceQuery", () => {
  it("treats a short free-text topic as one keyword segment", () => {
    const query = parseRelevanceQuery("  causality  ");
    expect(query.kind).toBe("keywords");
    expect(query.segments).toEqual([{ id: "q", label: "causality", text: "causality" }]);
    expect(query.terms).toEqual(["causality"]);
  });

  it("splits a comma-separated topic list into terms without splitting the segment", () => {
    const query = parseRelevanceQuery("causality, mechanistic interpretability");
    expect(query.kind).toBe("keywords");
    // One segment: the whole phrase is the query, and embedding it as one string is what gives the
    // model the combination rather than two unrelated words.
    expect(query.segments).toHaveLength(1);
    expect(query.terms).toEqual(["causality", "mechanistic interpretability"]);
  });

  it("returns no segments for an empty query", () => {
    expect(parseRelevanceQuery("   ").segments).toEqual([]);
  });

  it("splits a markdown document into one segment per heading, heading first", () => {
    const query = parseRelevanceQuery(
      [
        "# Evaluation hacking",
        "Taxonomize where eval hacking can occur.",
        "",
        "## Misalignment",
        "Model organisms of deception.",
      ].join("\n"),
    );
    expect(query.kind).toBe("proposal");
    expect(query.segments.map((segment) => segment.label)).toEqual([
      "Evaluation hacking",
      "Misalignment",
    ]);
    expect(query.segments[0]?.text).toBe(
      "Evaluation hacking. Taxonomize where eval hacking can occur.",
    );
  });

  it("recognises the proposal's own numbered headings", () => {
    const query = parseRelevanceQuery(
      [
        "Part 1.1.1 Evaluation hacking",
        "Body text.",
        "A. Training-data hacking",
        "More body.",
      ].join("\n"),
    );
    expect(query.segments.map((segment) => segment.label)).toEqual([
      "Part 1.1.1 Evaluation hacking",
      "A. Training-data hacking",
    ]);
  });

  it("does not mistake a long sentence that opens with a number for a heading", () => {
    const sentence = `8 technical leads and roughly 40 researchers will work on evaluation validity, ${"misalignment and adversarial defense across the full two-year term of the grant. ".repeat(6)}`;
    const query = parseRelevanceQuery(sentence);
    // Long enough to be a proposal, but the one line is body, so it becomes a single labelled
    // opening segment rather than a heading with nothing under it.
    expect(query.kind).toBe("proposal");
    expect(query.segments).toHaveLength(1);
    expect(query.segments[0]?.label.endsWith("…")).toBe(true);
  });

  it("treats long unstructured prose as a proposal", () => {
    const prose = "We study causal representation learning in language models. ".repeat(10);
    const query = parseRelevanceQuery(prose);
    expect(query.kind).toBe("proposal");
    expect(query.segments.length).toBeGreaterThanOrEqual(1);
  });

  it("splits an oversized section into parts that each keep the heading", () => {
    const query = parseRelevanceQuery(
      ["# Adversarial defense", "Jailbreak robustness under distribution shift. ".repeat(60)].join(
        "\n",
      ),
    );
    expect(query.segments.length).toBeGreaterThan(1);
    expect(query.segments.map((segment) => segment.id)).toEqual(
      query.segments.map((_, index) => `s1.${index + 1}`),
    );
    for (const segment of query.segments) {
      expect(segment.text.startsWith("Adversarial defense.")).toBe(true);
    }
    expect(query.segments[1]?.label).toBe("Adversarial defense (part 2)");
  });
});

describe("relevanceQueryFromDomains", () => {
  it("makes one segment per domain and keeps the caller's ids", () => {
    const query = relevanceQueryFromDomains([
      { id: "whiteBox", label: "White-box", description: "read and edit the internals" },
      { id: "control", label: "Control", description: "assume that failed, contain it anyway" },
    ]);
    expect(query.segments.map((segment) => segment.id)).toEqual(["whiteBox", "control"]);
    expect(query.segments[0]?.text).toBe("White-box. read and edit the internals");
  });
});

describe("labPaperEmbeddingText", () => {
  it("leads with the title and repeats it when the record carries nothing else", () => {
    const text = labPaperEmbeddingText(paper({ id: "a", title: "Eval Awareness" }));
    expect(text).toBe("title: Eval Awareness | text: Eval Awareness");
  });

  it("puts keywords and the abstract ahead of the alias and the notes", () => {
    const text = labPaperEmbeddingText(
      paper({
        id: "a",
        title: "Causal AI Scientist",
        keywords: ["causality"],
        abstract: "We recover causal graphs from chain-of-thought traces.",
        alias: "cais",
        notes: "Waiting on the camera-ready.",
      }),
    );
    expect(text.indexOf("Keywords: causality.")).toBeLessThan(text.indexOf("We recover causal"));
    expect(text.indexOf("We recover causal")).toBeLessThan(text.indexOf("Project: cais."));
    expect(text.indexOf("Project: cais.")).toBeLessThan(text.indexOf("Waiting on"));
  });

  it("caps the notes so a long scratchpad cannot outweigh the title", () => {
    const text = labPaperEmbeddingText(
      paper({ id: "a", title: "Short", notes: "x".repeat(2_000) }),
    );
    expect(text.length).toBeLessThan(600);
  });
});

describe("labPaperEvidence", () => {
  it("is title_only for a bare record and rich once an abstract exists", () => {
    expect(labPaperEvidence(paper({ id: "a" }))).toBe("title_only");
    expect(labPaperEvidence(paper({ id: "a", abstract: "Anything at all." }))).toBe("rich");
  });

  it("is title_only for an alias alone but thin once there is real prose", () => {
    expect(labPaperEvidence(paper({ id: "a", alias: "cais" }))).toBe("title_only");
    expect(labPaperEvidence(paper({ id: "a", notes: "n".repeat(150) }))).toBe("thin");
  });
});

describe("bandForMargin", () => {
  it("bands on the margin, and refuses anything under the absolute guard", () => {
    expect(bandForMargin(0.2, 0.5)).toBe("core");
    expect(bandForMargin(0.12, 0.4)).toBe("related");
    expect(bandForMargin(0.05, 0.3)).toBe("peripheral");
    expect(bandForMargin(0.01, 0.3)).toBe("off_topic");
    // A big margin over a tiny score is the degenerate case the guard exists for.
    expect(bandForMargin(0.2, 0.1)).toBe("off_topic");
  });
});

describe("classifyLabPapers", () => {
  function classify(
    papers: readonly ScoredLabPaper[],
    options?: Parameters<typeof classifyLabPapers>[0]["options"],
    controlVectors: readonly (readonly number[])[] = [ORTHOGONAL],
  ) {
    return classifyLabPapers({
      papers,
      query: keywordQuery(),
      segmentVectors: [AXIS],
      controlVectors,
      options,
    });
  }

  it("bands papers by how far they clear the control floor", () => {
    // A control scoring 0.12 against the query, which is the realistic case: the bands measure the
    // distance above that, not the raw cosine.
    const report = classify(
      [
        { paper: paper({ id: "core" }), vector: atCosine(0.5) },
        { paper: paper({ id: "related" }), vector: atCosine(0.25) },
        { paper: paper({ id: "edge" }), vector: atCosine(0.2) },
        { paper: paper({ id: "off" }), vector: atCosine(0.02) },
      ],
      undefined,
      [atCosine(0.12)],
    );
    expect(report.matches.map((match) => [match.paper_id, match.band])).toEqual([
      ["core", "core"],
      ["related", "related"],
      ["edge", "peripheral"],
    ]);
    expect(report.off_topic.map((match) => match.paper_id)).toEqual(["off"]);
    expect(report.scored).toBe(4);
  });

  it("cannot reach the peripheral band when no controls are given", () => {
    // With no controls the margin is the raw cosine, and the absolute guard (0.15) sits above the
    // peripheral margin (0.04), so the weakest reachable band is `related`. Callers that want the
    // full four bands have to pass controls -- findRelevantLabPapers always does.
    const report = classify([{ paper: paper({ id: "a" }), vector: atCosine(0.16) }], undefined, []);
    expect(report.matches[0]?.band).toBe("related");
  });

  it("subtracts the noise floor, so the same cosine bands differently under a nearer control", () => {
    const rows = [{ paper: paper({ id: "a" }), vector: atCosine(0.3) }];
    expect(classify(rows, undefined, [ORTHOGONAL]).matches[0]?.band).toBe("core");
    // A control that itself scores 0.25 against the query leaves only 0.05 of real signal.
    expect(classify(rows, undefined, [atCosine(0.25)]).matches[0]?.band).toBe("peripheral");
  });

  it("scores a paper by its best section, not by its average across a whole proposal", () => {
    // One matching section among twenty is exactly the shape a grant report looks for: an
    // average would bury it, and burying it is the failure this test exists to catch.
    const segments = Array.from({ length: 20 }, (_, index) => ({
      id: `s${index + 1}`,
      label: `Part ${index + 1}`,
      text: `Part ${index + 1}`,
    }));
    const segmentVectors = segments.map((_, index) => (index === 7 ? AXIS : ORTHOGONAL));
    const report = classifyLabPapers({
      papers: [{ paper: paper({ id: "specialist" }), vector: atCosine(0.5) }],
      query: { kind: "proposal", segments, terms: [], source: "proposal" },
      segmentVectors,
      controlVectors: [[0, 1, 0]],
    });
    const match = report.matches[0];
    expect(match?.band).toBe("core");
    expect(match?.best_segment?.segment_id).toBe("s8");
    // Only the sections it actually answers are listed, not all twenty.
    expect(match?.segments.map((segment) => segment.segment_id)).toEqual(["s8"]);
  });

  it("lists the sections nothing covers, and does not count a peripheral hit as coverage", () => {
    const segments = [
      { id: "s1", label: "Evaluation hacking", text: "Evaluation hacking" },
      { id: "s2", label: "Compute governance", text: "Compute governance" },
    ];
    const report = classifyLabPapers({
      papers: [
        { paper: paper({ id: "strong" }), vector: [0.5, 0, Math.sqrt(0.75)] },
        { paper: paper({ id: "weak" }), vector: [0, 0.16, Math.sqrt(1 - 0.16 * 0.16)] },
      ],
      query: { kind: "proposal", segments, terms: [], source: "p" },
      segmentVectors: [AXIS, [0, 1, 0]],
      // Noise of 0 on s1 and 0.12 on s2, so the weak paper's 0.16 against s2 is only 0.04 of real
      // signal -- peripheral, which must not read as coverage.
      controlVectors: [[0, 0.12, Math.sqrt(1 - 0.12 * 0.12)]],
    });
    // s1 has a core match; s2 only has a peripheral one, which is not a track record.
    expect(report.uncovered_segments.map((segment) => segment.id)).toEqual(["s2"]);
  });

  it("reports nothing_relevant when the corpus was searched and nothing landed", () => {
    const report = classify([{ paper: paper({ id: "off" }), vector: ORTHOGONAL }]);
    expect(report.matches).toEqual([]);
    expect(report.nothing_relevant).toBe(true);
    expect(report.off_topic).toHaveLength(1);
  });

  it("does not claim nothing_relevant when it could not score the query at all", () => {
    const report = classifyLabPapers({
      papers: [{ paper: paper({ id: "a" }), vector: AXIS }],
      query: parseRelevanceQuery(""),
      segmentVectors: [],
    });
    expect(report.nothing_relevant).toBe(false);
    expect(report.scored).toBe(1);
  });

  it("scores nothing when the segment vectors do not line up with the segments", () => {
    const report = classifyLabPapers({
      papers: [{ paper: paper({ id: "a" }), vector: AXIS }],
      query: parseRelevanceQuery("# One\nbody\n# Two\nbody"),
      // One vector for two segments: pairing them would place papers against the wrong section.
      segmentVectors: [AXIS],
    });
    expect(report.matches).toEqual([]);
    expect(report.nothing_relevant).toBe(false);
  });

  it("matches on meaning even when no query term appears in the paper", () => {
    const report = classifyLabPapers({
      papers: [
        {
          paper: paper({ id: "a", title: "Structural discovery in transformers" }),
          vector: atCosine(0.5),
        },
      ],
      query: keywordQuery("causality"),
      segmentVectors: [AXIS],
      controlVectors: [ORTHOGONAL],
    });
    expect(report.matches[0]?.band).toBe("core");
    expect(report.matches[0]?.matched_terms).toEqual([]);
  });

  it("reports the query terms a paper does carry, without letting them decide the band", () => {
    const report = classifyLabPapers({
      papers: [{ paper: paper({ id: "a", title: "A causality benchmark" }), vector: ORTHOGONAL }],
      query: keywordQuery("causality"),
      segmentVectors: [AXIS],
      controlVectors: [[0, 1, 0]],
    });
    // The literal term is there and the paper is still off-topic: the note explains a match, it
    // never makes one.
    expect(report.off_topic[0]?.matched_terms).toEqual(["causality"]);
    expect(report.off_topic[0]?.band).toBe("off_topic");
  });

  it("honours limit and minBand without dropping the rest from off_topic", () => {
    const rows = [
      { paper: paper({ id: "a" }), vector: atCosine(0.6) },
      { paper: paper({ id: "b" }), vector: atCosine(0.5) },
      { paper: paper({ id: "c" }), vector: atCosine(0.16) },
    ];
    expect(classify(rows, { limit: 1 }).matches.map((m) => m.paper_id)).toEqual(["a"]);
    const strict = classify(rows, { minBand: "core" });
    expect(strict.matches.map((m) => m.paper_id)).toEqual(["a", "b"]);
    expect(strict.off_topic.map((m) => m.paper_id)).toEqual(["c"]);
  });

  it("breaks ties by title so two runs over the same corpus agree", () => {
    const report = classify([
      { paper: paper({ id: "b", title: "Beta" }), vector: atCosine(0.5) },
      { paper: paper({ id: "a", title: "Alpha" }), vector: atCosine(0.5) },
    ]);
    expect(report.matches.map((match) => match.title)).toEqual(["Alpha", "Beta"]);
  });

  it("carries the evidence tier onto every placement", () => {
    const report = classify([
      { paper: paper({ id: "bare" }), vector: atCosine(0.5) },
      { paper: paper({ id: "full", abstract: "Full abstract." }), vector: atCosine(0.5) },
    ]);
    const tiers = Object.fromEntries(report.matches.map((m) => [m.paper_id, m.evidence]));
    expect(tiers).toEqual({ bare: "title_only", full: "rich" });
  });
});

describe("controlDocumentTexts", () => {
  it("are embedded in the same document form the papers are", () => {
    const texts = controlDocumentTexts();
    expect(texts).toHaveLength(6);
    for (const text of texts) {
      expect(text.startsWith("title: ")).toBe(true);
      expect(text).toContain(" | text: ");
    }
  });
});

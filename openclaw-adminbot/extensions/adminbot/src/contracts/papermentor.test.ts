// What crosses the boundary, and what cannot.
import { describe, expect, it } from "vitest";
import {
  adminBotPaperMentorOpenSeverity,
  adminBotPaperMentorRunId,
  parsePaperMentorRunInput,
  summarizePaperMentorReview,
} from "./papermentor.js";

// The fork's own shape, from AiTutorReviewOrchestrator.mjs: the object it writes to
// <cache>/<projectId>/review_comments.json at the end of a run.
const REVIEW = {
  projectId: "65f2a1c9d4e3b7a801f6",
  model: "gpt-5.2-chat-latest",
  reviewedAt: "2026-09-12T11:04:09.221Z",
  classification: {
    paperType: "method_improvement",
    paperTypeSummary: "Proposes a new decoding strategy and evaluates it on three benchmarks.",
  },
  commentsByDoc: {
    "main.tex": [
      {
        highlightText: "We propose a novel method",
        comment: "[AI Tutor] [critical] [abstract] The abstract never states the result.",
        severity: "critical",
        category: "abstract",
      },
      {
        highlightText: "as shown in Table 2",
        comment: "[AI Tutor] [warning] [results] Table 2 has no significance test.",
        severity: "warning",
        category: "results",
      },
    ],
    "sections/related.tex": [
      {
        highlightText: "Prior work",
        comment: "[AI Tutor] [suggestion] [related work] Missing the 2025 line of work.",
        severity: "suggestion",
        category: "related_work",
      },
    ],
  },
  summary: {
    total: 3,
    byCategory: { abstract: 1, results: 1, related_work: 1 },
    bySeverity: { critical: 1, warning: 1, suggestion: 1 },
  },
  failedAgents: [{ id: "figures", name: "figures", reason: "model timed out" }],
  roleModelPapers: ["attention-is-all-you-need.pdf"],
};

describe("summarizePaperMentorReview", () => {
  it("keeps the counts", () => {
    expect(summarizePaperMentorReview(REVIEW)).toEqual({
      project_id: "65f2a1c9d4e3b7a801f6",
      reviewed_at: "2026-09-12T11:04:09.221Z",
      model: "gpt-5.2-chat-latest",
      paper_type: "method_improvement",
      comments_total: 3,
      by_severity: { critical: 1, warning: 1, suggestion: 1 },
      by_category: { abstract: 1, results: 1, related_work: 1 },
      by_document: [
        { path: "main.tex", comments: 2 },
        { path: "sections/related.tex", comments: 1 },
      ],
      failed_agents: ["figures"],
    });
  });

  // The property the whole design rests on: this is an allow-list, so nothing the reviewers wrote
  // about the paper -- their comments, the text they quoted, the classification prose, the agents'
  // own error messages -- can appear in the result, whatever the input looks like.
  it("carries no word of the paper, and no prose at all", () => {
    const summarized = JSON.stringify(summarizePaperMentorReview(REVIEW));
    for (const leak of [
      "We propose a novel method",
      "The abstract never states the result",
      "Table 2 has no significance test",
      "Proposes a new decoding strategy",
      "model timed out",
      "attention-is-all-you-need",
    ]) {
      expect(summarized).not.toContain(leak);
    }
  });

  it("refuses anything that is not a finished review", () => {
    for (const value of [
      undefined,
      null,
      "a string",
      [],
      {},
      { projectId: "65f2a1c9d4e3b7a801f6" },
      { projectId: "65f2a1c9d4e3b7a801f6", reviewedAt: "not a date" },
      { reviewedAt: "2026-09-12T11:04:09.221Z" },
    ]) {
      expect(summarizePaperMentorReview(value)).toBeUndefined();
    }
  });

  it("takes a review that found nothing at its word", () => {
    const clean = summarizePaperMentorReview({
      ...REVIEW,
      commentsByDoc: {},
      summary: { total: 0, byCategory: {}, bySeverity: {} },
    });

    // Zero is an answer, not a missing value: a clean paper must not be recorded as three comments
    // because some other field still mentions them.
    expect(clean?.comments_total).toBe(0);
    expect(clean?.by_document).toEqual([]);
  });

  it("falls back to counting the documents when an older file has no total", () => {
    const { summary: _dropped, ...withoutSummary } = REVIEW;
    expect(summarizePaperMentorReview(withoutSummary)?.comments_total).toBe(3);
  });

  it("drops counts that are not counts, rather than storing them", () => {
    const odd = summarizePaperMentorReview({
      ...REVIEW,
      summary: {
        total: -4,
        byCategory: { abstract: "lots", results: 2 },
        bySeverity: { critical: Number.NaN, warning: 1 },
      },
    });

    expect(odd?.comments_total).toBe(3);
    expect(odd?.by_category).toEqual({ results: 2 });
    expect(odd?.by_severity).toEqual({ warning: 1 });
  });
});

describe("parsePaperMentorRunInput", () => {
  it("reads back what the collector sends", () => {
    const sent = summarizePaperMentorReview(REVIEW);
    expect(parsePaperMentorRunInput(structuredClone(sent))).toEqual(sent);
  });

  it("refuses a body with no project or no instant", () => {
    expect(parsePaperMentorRunInput({ reviewed_at: "2026-09-12T11:04:09.221Z" })).toBeUndefined();
    expect(parsePaperMentorRunInput({ project_id: "abc" })).toBeUndefined();
  });

  it("drops fields the contract does not have, however the caller shapes them", () => {
    const parsed = parsePaperMentorRunInput({
      project_id: "65f2a1c9d4e3b7a801f6",
      reviewed_at: "2026-09-12T11:04:09.221Z",
      comments_total: 1,
      // A caller trying to push paper content through the wire finds nowhere for it to land.
      comments: [{ comment: "the abstract never states the result" }],
      by_document: [{ path: "main.tex", comments: 1, text: "We propose a novel method" }],
    });

    expect(JSON.stringify(parsed)).not.toContain("novel method");
    expect(JSON.stringify(parsed)).not.toContain("never states");
    expect(parsed?.by_document).toEqual([{ path: "main.tex", comments: 1 }]);
  });
});

describe("run identity", () => {
  it("is the project and the instant, so re-reading one cache file is one run", () => {
    expect(adminBotPaperMentorRunId("p1", "2026-09-12T11:04:09.221Z")).toBe(
      "p1:2026-09-12T11:04:09.221Z",
    );
  });

  it("counts what somebody still has to answer", () => {
    expect(
      adminBotPaperMentorOpenSeverity({ by_severity: { critical: 2, warning: 3, suggestion: 9 } }),
    ).toBe(5);
    expect(adminBotPaperMentorOpenSeverity({ by_severity: {} })).toBe(0);
  });
});

// What the lab says about a review, and when a review stops counting.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperMentorRun } from "../../contracts/papermentor.js";
import {
  adminBotPaperMentorFreshnessDays,
  isPaperMentorReviewStale,
  paperMentorFixesDetail,
  paperMentorReviewDetail,
  paperMentorReviewState,
} from "./papermentor-nudges.js";

const NOW = new Date("2026-09-13T09:00:00Z");
const LAB = "overleaf.safe.eu";

function run(overrides: Partial<AdminBotPaperMentorRun> = {}): AdminBotPaperMentorRun {
  return {
    id: "p:1",
    paper_id: "p1",
    project_id: "65f2a1c9d4e3b7a801f6",
    reviewed_at: "2026-09-12T11:04:09.221Z",
    ingested_at: "2026-09-12T12:00:00.000Z",
    comments_total: 14,
    by_severity: { critical: 3, warning: 5, suggestion: 6 },
    by_category: { abstract: 2 },
    by_document: [{ path: "main.tex", comments: 14 }],
    failed_agents: [],
    ...overrides,
  };
}

describe("paperMentorReviewState", () => {
  it("says nothing about a paper with no Overleaf project yet -- that is the link's own slot", () => {
    expect(paperMentorReviewState({}, NOW)).toEqual({ kind: "no_project" });
  });

  // The case worth catching in week one rather than in deadline week.
  it("marks a draft on another Overleaf as one PaperMentor cannot read", () => {
    expect(
      paperMentorReviewState({ project: { lab: false, host: "www.overleaf.com" } }, NOW),
    ).toEqual({ kind: "unreachable", host: "www.overleaf.com" });
  });

  it("separates never reviewed from reviewed recently", () => {
    expect(paperMentorReviewState({ project: { lab: true, host: LAB } }, NOW)).toEqual({
      kind: "never",
    });
    expect(
      paperMentorReviewState({ project: { lab: true, host: LAB }, latest: run() }, NOW),
      // Yesterday's review, counted in calendar days: the reminder says "yesterday" because that
      // is what the reader would say, not "today" because 22 hours have passed.
    ).toMatchObject({ kind: "fresh", days_ago: 1 });
  });

  it("calls a review stale once it is older than the freshness window", () => {
    const older = (days: number) =>
      new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const at = (days: number) =>
      paperMentorReviewState(
        { project: { lab: true, host: LAB }, latest: run({ reviewed_at: older(days) }) },
        NOW,
      );

    expect(at(adminBotPaperMentorFreshnessDays - 1).kind).toBe("fresh");
    expect(at(adminBotPaperMentorFreshnessDays).kind).toBe("stale");
    expect(isPaperMentorReviewStale(at(adminBotPaperMentorFreshnessDays + 10))).toBe(true);
    expect(isPaperMentorReviewStale(at(1))).toBe(false);
  });
});

describe("paperMentorReviewDetail", () => {
  it("tells an author on the wrong Overleaf what has to happen first", () => {
    const detail = paperMentorReviewDetail({ kind: "unreachable", host: "www.overleaf.com" }, LAB);
    expect(detail).toContain("www.overleaf.com");
    expect(detail).toContain(`move the project to ${LAB}`);
  });

  it("says where to run it when it has never been run", () => {
    expect(paperMentorReviewDetail({ kind: "never" }, LAB)).toContain("AI Tutor panel");
  });

  it("says how old the last one was when it has gone stale", () => {
    expect(
      paperMentorReviewDetail(
        { kind: "stale", reviewed_at: "2026-08-01T09:00:00Z", days_ago: 43 },
        LAB,
      ),
    ).toContain("43 days ago");
  });

  it("says nothing when the review is current", () => {
    expect(
      paperMentorReviewDetail(
        { kind: "fresh", reviewed_at: "2026-09-12T11:04:09.221Z", days_ago: 1 },
        LAB,
      ),
    ).toBeUndefined();
    expect(paperMentorReviewDetail({ kind: "no_project" }, LAB)).toBeUndefined();
  });
});

describe("paperMentorFixesDetail", () => {
  it("quotes what the reviewer found, by severity", () => {
    const detail = paperMentorFixesDetail(run(), NOW);
    expect(detail).toContain("14 comments");
    // "3 critical", never "3 criticals": the lab's reminders should not read as machine output.
    expect(detail).toContain("3 critical, 5 warnings, 6 suggestions");
    expect(detail).toContain("yesterday");
  });

  it("reads as an ask, not a bug, when the review was clean", () => {
    const detail = paperMentorFixesDetail(run({ comments_total: 0, by_severity: {} }), NOW);
    expect(detail).toContain("nothing to fix");
    expect(detail).not.toContain("0 comments");
  });

  it("says nothing when no review is on file -- the review slot is the thing to ask about", () => {
    expect(paperMentorFixesDetail(undefined, NOW)).toBeUndefined();
  });

  // Counts only. The comments live in the author's own project, which is the whole arrangement.
  it("carries no reviewer prose", () => {
    const detail = paperMentorFixesDetail(run(), NOW) ?? "";
    expect(detail).not.toContain("main.tex");
    expect(detail).toMatch(/^PaperMentor left \d+ comments/u);
  });
});

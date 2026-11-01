// Which papers the lab reviews on its authors' behalf, and how it names them to the Overleaf.
import { describe, expect, it } from "vitest";
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import { ADMINBOT_LAB_OVERLEAF_HOST } from "../../contracts/overleaf.js";
import type { AdminBotPaperSlotRecord } from "../../contracts/paper-slots.js";
import type { AdminBotPaperMentorRun } from "../../contracts/papermentor.js";
import {
  paperMentorAutoReviewCandidate,
  paperMentorAutoReviewQueue,
  paperMentorVenueKey,
  type PaperMentorAutoReviewCandidate,
} from "./papermentor-auto-review.js";

const NOW = new Date("2026-11-01T09:00:00Z");
const SHARE = `https://${ADMINBOT_LAB_OVERLEAF_HOST}/1234567890abcdefghijkl`;

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "Causal Garden Planning",
    authors: ["Ada Lovelace"],
    current_step: "overleaf_writing",
    created_at: "2026-09-01T00:00:00Z",
    venue: "ICLR 2026",
    ...overrides,
  } as AdminBotPaperRecord;
}

function slot(
  name: string,
  overrides: Partial<AdminBotPaperSlotRecord> = {},
): AdminBotPaperSlotRecord {
  return {
    paper_id: "p1",
    slot: name,
    status: "provided",
    ...overrides,
  } as AdminBotPaperSlotRecord;
}

function review(reviewedAt: string): AdminBotPaperMentorRun {
  return {
    id: `x:${reviewedAt}`,
    paper_id: "p1",
    project_id: "65f2a1c9d4e3b7a801f6abcd",
    reviewed_at: reviewedAt,
    ingested_at: reviewedAt,
    comments_total: 4,
    by_severity: { warning: 4 },
    by_category: {},
    by_document: [],
    failed_agents: [],
  };
}

const atReviewStep = [slot("overleaf_share", { url: SHARE })];

function candidate(
  overrides: {
    paper?: Partial<AdminBotPaperRecord>;
    slots?: AdminBotPaperSlotRecord[];
    latest?: AdminBotPaperMentorRun;
  } = {},
) {
  return paperMentorAutoReviewCandidate({
    paper: paper(overrides.paper),
    slots: overrides.slots ?? atReviewStep,
    ...(overrides.latest ? { latest: overrides.latest } : {}),
    now: NOW,
    env: {},
  });
}

describe("paperMentorAutoReviewCandidate", () => {
  it("asks for a never-reviewed paper by the edit share link its author gave", () => {
    expect(candidate()).toEqual({
      paper_id: "p1",
      title: "Causal Garden Planning",
      reason: "never",
      target: { share_link: SHARE },
      venue: "iclr_2026",
    });
  });

  it("does not ask about a share link on overleaf.com, which PaperMentor cannot resolve", () => {
    expect(
      candidate({
        slots: [slot("overleaf_share", { url: "https://www.overleaf.com/1234567890abcdefghijkl" })],
      }),
    ).toBeUndefined();
  });

  it("falls back to a project link on the lab's Overleaf when there is no share link", () => {
    const projectUrl = `https://${ADMINBOT_LAB_OVERLEAF_HOST}/project/65f2a1c9d4e3b7a801f6abcd`;
    expect(
      candidate({ slots: [], paper: { artifacts: { overleaf_edit_url: projectUrl } } })?.target,
    ).toEqual({ project_id: "65f2a1c9d4e3b7a801f6abcd" });
    expect(candidate({ slots: [] })).toBeUndefined();
  });

  it("asks again once the last review is stale, and not before", () => {
    const reviewed = [...atReviewStep, slot("papermentor_review")];
    expect(candidate({ slots: reviewed, latest: review("2026-10-25T10:00:00Z") })).toBeUndefined();
    expect(candidate({ slots: reviewed, latest: review("2026-09-20T10:00:00Z") })).toMatchObject({
      reason: "stale",
      reviewed_at: "2026-09-20T10:00:00Z",
    });
  });

  it("takes an author's own tick at their word, and leaves a waived review waived", () => {
    expect(candidate({ slots: [...atReviewStep, slot("papermentor_review")] })).toBeUndefined();
    expect(
      candidate({ slots: [...atReviewStep, slot("papermentor_review", { status: "waived" })] }),
    ).toBeUndefined();
  });

  it("leaves submitted, closed and dormant papers alone", () => {
    expect(
      candidate({
        slots: [...atReviewStep, slot("submission", { url: "https://openreview.net/forum?id=a" })],
      }),
    ).toBeUndefined();
    expect(candidate({ paper: { venue_decision: "reject" } })).toBeUndefined();
    expect(candidate({ paper: { created_at: "2023-01-01T00:00:00Z" } })).toBeUndefined();
  });
});

describe("paperMentorVenueKey", () => {
  it("names the venue the way the panel does", () => {
    expect(paperMentorVenueKey("ICLR 2026")).toBe("iclr_2026");
    expect(paperMentorVenueKey("NeurIPS 2025 Workshop")).toBe("neurips_2025");
    expect(paperMentorVenueKey("arXiv")).toBeUndefined();
    expect(paperMentorVenueKey(undefined)).toBeUndefined();
  });
});

describe("paperMentorAutoReviewQueue", () => {
  it("puts never-reviewed papers first, then the stalest reviews", () => {
    const entry = (
      paperId: string,
      reason: PaperMentorAutoReviewCandidate["reason"],
      reviewedAt?: string,
    ): PaperMentorAutoReviewCandidate => ({
      paper_id: paperId,
      title: paperId,
      reason,
      target: { share_link: SHARE },
      ...(reviewedAt ? { reviewed_at: reviewedAt } : {}),
    });
    const queue = paperMentorAutoReviewQueue([
      entry("recent", "stale", "2026-10-01T00:00:00Z"),
      entry("b", "never"),
      entry("oldest", "stale", "2026-08-01T00:00:00Z"),
      entry("a", "never"),
    ]);
    expect(queue.map((row) => row.paper_id)).toEqual(["a", "b", "oldest", "recent"]);
  });
});

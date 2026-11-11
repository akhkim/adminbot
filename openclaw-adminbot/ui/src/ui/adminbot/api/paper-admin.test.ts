import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPiReviewQueue,
  fetchPiReviewQueueAndHistory,
  readConferenceRosters,
} from "./paper-admin.ts";

const base = {
  key: "emnlp:2026",
  venue: "EMNLP",
  year: 2026,
  label: "EMNLP 2026",
  paper_count: 1,
  going_count: 1,
  unanswered_count: 0,
};

const hydrated = [
  {
    ...base,
    people: [
      {
        attendee_key: "member:ada",
        name: "Ada",
        attending: "yes",
        papers: [{ paper_id: "p1", title: "Causal abstraction", attending: "yes" }],
      },
    ],
    papers_awaiting: [{ paper_id: "p1", title: "Causal abstraction", unanswered: 1 }],
  },
];

describe("readConferenceRosters", () => {
  it("puts the titles back from the per-conference table", () => {
    const body = {
      conferences: [
        {
          ...base,
          paper_titles: { p1: "Causal abstraction" },
          people: [
            {
              attendee_key: "member:ada",
              name: "Ada",
              attending: "yes",
              papers: [{ paper_id: "p1", attending: "yes" }],
            },
          ],
          papers_awaiting: [{ paper_id: "p1", unanswered: 1 }],
        },
      ],
    };
    expect(readConferenceRosters(body)).toEqual(hydrated);
  });

  it("reads an older service's inline titles unchanged", () => {
    expect(readConferenceRosters({ conferences: hydrated })).toEqual(hydrated);
  });

  it("reads a missing or malformed body as no rosters", () => {
    expect(readConferenceRosters(null)).toEqual([]);
    expect(readConferenceRosters({ conferences: "nope" })).toEqual([]);
  });
});

describe("fetchPiReviewQueueAndHistory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const respond = (body: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
  const row = { paper_id: "p1", title: "Open one", authors: [], package_complete: true };

  it("reads the history beside the queue, with why each row left", async () => {
    respond({
      papers: [row],
      history: [
        {
          ...row,
          paper_id: "emnlp",
          title: "Held at EMNLP",
          category: "camera_ready",
          hard_deadline: "2026-08-31T11:59:59.000Z",
          days_left: -73,
          history_reason: "conference_held",
        },
        // A row with no reason is not history, and a malformed one does not fail the queue.
        { ...row, paper_id: "x", title: "No reason" },
        { title: "No id" },
      ],
    });
    const result = await fetchPiReviewQueueAndHistory("token", "http://service.test");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.papers.map((paper) => paper.paperId)).toEqual(["p1"]);
    expect(result.value.history).toEqual([
      expect.objectContaining({
        paperId: "emnlp",
        historyReason: "conference_held",
        daysLeft: -73,
      }),
    ]);
  });

  it("has an empty history from a service that predates it", async () => {
    respond({ papers: [row] });
    const result = await fetchPiReviewQueueAndHistory("token", "http://service.test");
    expect(result.ok && result.value.history).toEqual([]);
    respond({ papers: [row] });
    const queue = await fetchPiReviewQueue("token", "http://service.test");
    expect(queue.ok && queue.value.map((paper) => paper.paperId)).toEqual(["p1"]);
  });
});

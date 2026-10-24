import { describe, expect, it } from "vitest";
import { readConferenceRosters } from "./paper-admin.ts";

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

import { describe, expect, it } from "vitest";
import type { ConferenceAttendanceView } from "../workflows/papers/conference-attendance.js";
import { conferenceRosterWire } from "./server.paper-lists.wire.js";

function roster(): ConferenceAttendanceView {
  return {
    key: "emnlp:2026",
    venue: "EMNLP",
    year: 2026,
    label: "EMNLP 2026",
    paper_count: 2,
    going_count: 1,
    unanswered_count: 1,
    people: [
      {
        attendee_key: "member:ada",
        member_id: "ada",
        name: "Ada Lovelace",
        avatar_url: "https://example.com/ada.png",
        attending: "yes",
        papers: [
          { paper_id: "p1", title: "Causal abstraction", attending: "yes" },
          { paper_id: "p2", title: "Meta agents", attending: "unknown" },
        ],
      },
      {
        attendee_key: "member:bob",
        member_id: "bob",
        name: "Bob",
        avatar_url: "https://example.com/bob.png",
        attending: "unknown",
        papers: [{ paper_id: "p2", title: "Meta agents", attending: "unknown" }],
      },
    ],
    papers_awaiting: [{ paper_id: "p2", title: "Meta agents", unanswered: 2 }],
  };
}

describe("conferenceRosterWire", () => {
  it("names each paper once and points at it by id", () => {
    const wire = conferenceRosterWire(roster());
    expect(wire.paper_titles).toEqual({ p1: "Causal abstraction", p2: "Meta agents" });
    expect(wire.people[0]?.papers).toEqual([
      { paper_id: "p1", attending: "yes" },
      { paper_id: "p2", attending: "unknown" },
    ]);
    expect(wire.papers_awaiting).toEqual([{ paper_id: "p2", unanswered: 2 }]);
    expect(JSON.stringify(wire).split("Meta agents")).toHaveLength(2);
  });

  it("keeps a face only for the people going", () => {
    const [ada, bob] = conferenceRosterWire(roster()).people;
    expect(ada?.avatar_url).toBe("https://example.com/ada.png");
    expect(bob).not.toHaveProperty("avatar_url");
    expect(bob).toMatchObject({ attendee_key: "member:bob", member_id: "bob", name: "Bob" });
  });
});

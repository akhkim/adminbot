import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { ConferenceRoster } from "../api/paper-admin.ts";
import type { DeadlineVenue } from "../data/deadlines.ts";
import { conferenceRosterFor, renderConferenceAttendance } from "./deadlines.conference.ts";

describe("conference deadline attendance", () => {
  it("matches exact aliases and year and shows only going authors without a manual Slack button", () => {
    const roster = {
      key: "iclr:2027",
      venue: "ICLR 2027",
      year: 2027,
      label: "ICLR 2027",
      paper_count: 2,
      going_count: 1,
      unanswered_count: 1,
      papers_awaiting: [],
      people: [
        { attendee_key: "ada", name: "Ada", attending: "yes", papers: [] },
        { attendee_key: "bob", name: "Bob", attending: "no", papers: [] },
        { attendee_key: "c", name: "Cora", attending: "unknown", papers: [] },
      ],
    } satisfies ConferenceRoster;
    const venue = {
      name: "ICLR 2027",
      venue_family: "ICLR",
      venue_aliases: [],
      schedule: [],
    } as unknown as DeadlineVenue;
    expect(conferenceRosterFor([venue], [{ ...roster, year: 2026 }, roster])).toBe(roster);
    expect(conferenceRosterFor([{ ...venue, name: "ICLR 2028" }], [roster])).toBeUndefined();
    expect(
      conferenceRosterFor([{ ...venue, venue_family: "ACL", name: "ACL 2027" }], [roster]),
    ).toBeUndefined();
    const container = document.createElement("div");
    render(renderConferenceAttendance(roster), container);
    expect(container.textContent).toContain("Ada");
    expect(container.textContent).not.toContain("Bob");
    expect(container.textContent).not.toContain("Cora");
    expect(container.textContent).not.toContain("Not confirmed");
    expect(container.textContent).not.toContain("Not going");
    expect(container.querySelector("button")).toBeNull();
  });
});

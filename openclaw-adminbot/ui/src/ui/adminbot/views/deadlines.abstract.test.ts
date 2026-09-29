/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { DEADLINE_VENUES, type DeadlineVenue } from "../data/deadlines.ts";
import {
  abstractPrerequisite,
  abstractRequirementStatus,
  renderAbstractRequirement,
  renderAbstractMilestoneDate,
} from "./deadlines.abstract.ts";
import { venueSchedule, conferenceTimeline, buildDeadlineBoardEntries } from "./deadlines.ts";
const paper: DeadlineVenue = {
  ...DEADLINE_VENUES[0],
  id: "paper",
  deadline_id: "paper",
  venue_id: "example",
  venue_group: "Example 2035",
  entry_type: "main_conference",
  track: "main",
  submission_type: "",
  milestone: "full_paper",
  deadline_label: "full paper",
  deadline_aoe: "2035-09-25 23:59:00",
  deadline_at: "2035-09-26T11:59:00Z",
  abstract_requirement: "required",
  abstract_deadline_id: "abstract",
};
const abstract: DeadlineVenue = {
  ...paper,
  id: "abstract",
  deadline_id: "abstract",
  milestone: "abstract",
  deadline_label: "abstract registration",
  deadline_aoe: "2035-09-20 23:59:00",
  deadline_at: "2035-09-21T11:59:00Z",
  deadline_timezone: "AoE",
  stale: false,
};
function text(venue: DeadlineVenue, rows: DeadlineVenue[] = [], details = true) {
  const container = document.createElement("div");
  render(
    renderAbstractRequirement(
      venue,
      rows,
      "Europe/Zurich",
      Date.parse("2035-09-23T12:00:00Z"),
      details,
    ),
    container,
  );
  return container.textContent || "";
}
describe("abstract prerequisite", () => {
  it("uses short milestone statuses while preserving distinct uncertainty", () => {
    expect(abstractRequirementStatus(paper)).toBe("Date unknown");
    expect(abstractRequirementStatus({ ...paper, abstract_requirement: undefined })).toBe(
      "Requirement unknown",
    );
    expect(abstractRequirementStatus({ ...paper, abstract_requirement: "not_required" })).toBe(
      "Not required",
    );
    expect(abstractRequirementStatus({ ...paper, abstract_requirement_conflict: true })).toBe(
      "Sources disagree",
    );
  });
  it("distinguishes unknown, required with no date, and explicitly absent", () => {
    expect(text({ ...paper, abstract_requirement: undefined })).toContain(
      "Abstract registration: unknown",
    );
    expect(text(paper)).toContain("required · deadline unknown");
    expect(text({ ...paper, abstract_requirement: "not_required" })).toContain(
      "No separate abstract registration required",
    );
    expect(text({ ...paper, abstract_requirement_conflict: true })).toContain("sources disagree");
  });
  it("uses the existing schedule without a duplicate abstract sentence", () => {
    expect(text(paper, [abstract], false)).toBe("");
    const schedule = venueSchedule(paper, { includeSubmission: true, venues: [abstract] });
    expect(schedule.filter((entry) => entry.abstractVenue)).toHaveLength(1);
    const container = document.createElement("div");
    render(
      renderAbstractMilestoneDate(abstract, "Europe/Zurich", Date.parse("2035-09-23T12:00:00Z")),
      container,
    );
    expect(container.textContent).toContain("Sep 21, 2035 · 13:59 UTC+2");
    expect(container.textContent).not.toContain("Passed");
    expect(container.textContent).not.toContain("eligibility");
  });
  it("keeps a filtered abstract in the conference timeline without duplicating a visible abstract", () => {
    const hidden = conferenceTimeline(buildDeadlineBoardEntries([paper]), [abstract, paper]);
    expect(
      hidden.filter((entry) => entry.kind === "milestone" && entry.milestone.abstractVenue),
    ).toHaveLength(1);
    const visible = conferenceTimeline(buildDeadlineBoardEntries([paper, abstract]), [
      abstract,
      paper,
    ]);
    expect(
      visible.filter((entry) => entry.kind === "milestone" && entry.milestone.abstractVenue),
    ).toHaveLength(0);
  });
  it("never mistakes another track, edition, stale row, or later date for a prerequisite", () => {
    for (const change of [
      { track: "demo" },
      { venue_group: "Example 2036" },
      { stale: true },
      { deadline_at: "2035-09-27T12:00:00Z" },
    ]) {
      expect(abstractPrerequisite(paper, [{ ...abstract, ...change }])).toBeUndefined();
    }
  });
  it("does not duplicate the prerequisite warning on its own abstract or commitment row", () => {
    expect(text(abstract)).toBe("");
    expect(text({ ...paper, submission_type: "commitment" })).toBe("");
  });
  it("keeps date-only registration uncertainty visible", () => {
    const container = document.createElement("div");
    render(
      renderAbstractMilestoneDate(
        {
          ...abstract,
          deadline_at: "",
          deadline_time_precision: "date_only",
          deadline_date: "2035-09-20",
        },
        "Europe/Zurich",
        Date.parse("2035-09-23T12:00:00Z"),
      ),
      container,
    );
    expect(container.textContent).toContain("Sep 20, 2035");
    expect(container.textContent).not.toContain("passed");
  });
});

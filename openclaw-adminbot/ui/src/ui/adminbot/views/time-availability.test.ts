import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AdminBotLabMember } from "../controllers/admin.ts";
import {
  allocationSegments,
  draftError,
  draftToPatch,
  EMPTY_MILESTONE_DRAFT,
  EMPTY_TIME_AVAILABILITY_DRAFT,
  milestoneDraftError,
  renderAdminBotTimeAvailability,
  type AdminBotTimeAvailabilityProps,
} from "./time-availability.ts";

// 40h capacity is the reference line the chart draws; commitments are shown in raw hours/week.
function member(overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id: "m1",
    name: "Ada",
    hours_per_week: 40,
    availability: [
      { start: "2026-03-02", end: "2026-03-15", project: "Alignment", hours_per_week: 20 },
    ],
    ...overrides,
  } as AdminBotLabMember;
}

function tasks(
  entries: Array<{ key: string; name: string; start: string; end: string; hours: number }>,
) {
  return entries;
}

function props(overrides: Partial<AdminBotTimeAvailabilityProps> = {}) {
  return {
    members: [member()],
    loading: false,
    error: null,
    selectedMemberId: "m1",
    onMemberChange: () => {},
    hoursUnit: "week" as const,
    onHoursUnitChange: () => {},
    viewerMemberId: "m1",
    draft: { ...EMPTY_TIME_AVAILABILITY_DRAFT },
    onDraftChange: () => {},
    awayDraft: { ...EMPTY_TIME_AVAILABILITY_DRAFT, category: "vacation" as const },
    onAwayDraftChange: () => {},
    milestoneDraft: { ...EMPTY_MILESTONE_DRAFT },
    onMilestoneDraftChange: () => {},
    onSaveSchedule: () => {},
    saving: false,
    ...overrides,
  } satisfies AdminBotTimeAvailabilityProps;
}

function renderView(overrides: Partial<AdminBotTimeAvailabilityProps> = {}): HTMLElement {
  const container = document.createElement("div");
  render(renderAdminBotTimeAvailability(props(overrides)), container);
  return container;
}

describe("allocationSegments", () => {
  const twoWeeks = tasks([
    { key: "a", name: "Alignment", start: "2026-03-02", end: "2026-03-15", hours: 20 },
  ]);

  // One commitment is one stretch, however long it runs: nothing changes inside it, so there is
  // nothing to cut on. This is the whole difference from calendar bucketing, which would have made
  // two bars of this because it happens to span two weeks.
  it("makes one bar of a commitment that never changes", () => {
    const { segments } = allocationSegments(twoWeeks);
    expect(segments).toHaveLength(1);
    expect(segments[0].start).toBe("2026-03-02");
    // The boundary is exclusive: the segment ends the day after the last day it covers.
    expect(segments[0].end).toBe("2026-03-16");
    expect(segments[0].total).toBe(20);
  });

  // Every start and end is a breakpoint, so an overlap splits the timeline into before / during /
  // after, and only the middle bar carries both.
  it("cuts at every date the active set changes", () => {
    const { segments } = allocationSegments(
      tasks([
        { key: "a", name: "A", start: "2026-03-02", end: "2026-03-15", hours: 20 },
        { key: "b", name: "B", start: "2026-03-09", end: "2026-03-22", hours: 10 },
      ]),
    );
    expect(segments.map((segment) => segment.start)).toEqual([
      "2026-03-02",
      "2026-03-09",
      "2026-03-16",
    ]);
    expect(segments.map((segment) => segment.total)).toEqual([20, 30, 10]);
    expect(segments[1].allocations.map((allocation) => allocation.key)).toEqual(["a", "b"]);
  });

  it("stacks commitments that run over exactly the same dates into one bar", () => {
    const { segments } = allocationSegments(
      tasks([
        { key: "a", name: "A", start: "2026-03-02", end: "2026-03-08", hours: 20 },
        { key: "b", name: "B", start: "2026-03-02", end: "2026-03-08", hours: 10 },
      ]),
    );
    expect(segments).toHaveLength(1);
    expect(segments[0].total).toBe(30);
    expect(segments[0].allocations.map((allocation) => allocation.key)).toEqual(["a", "b"]);
  });

  // The gap between two commitments is a breakpoint pair with nothing active in it. Luke dropped
  // those rather than drawing an empty bar, and so does this: the axis is the sequence of
  // commitments, not elapsed time.
  it("drops the empty stretch between two distant commitments", () => {
    const { segments } = allocationSegments(
      tasks([
        { key: "a", name: "A", start: "2026-03-01", end: "2026-03-31", hours: 20 },
        { key: "b", name: "B", start: "2026-06-01", end: "2026-06-30", hours: 20 },
      ]),
    );
    expect(segments.map((segment) => segment.start)).toEqual(["2026-03-01", "2026-06-01"]);
    expect(segments.every((segment) => segment.allocations.length > 0)).toBe(true);
  });

  it("labels a bar with the stretch it covers, ending on its last inclusive day", () => {
    const { segments } = allocationSegments(twoWeeks);
    expect(segments[0].label).toContain("Mar 2");
    expect(segments[0].label).toContain("Mar 15");
  });

  // A long history of short overlapping rows can still outrun the axis.
  it("caps the segment count and reports the truncation", () => {
    const { segments, truncated } = allocationSegments(
      tasks(
        Array.from({ length: 60 }, (_, index) => ({
          key: `k${index}`,
          name: `T${index}`,
          start: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
          end: `2026-12-${String((index % 28) + 1).padStart(2, "0")}`,
          hours: 1,
        })),
      ),
    );
    expect(segments).toHaveLength(40);
    expect(truncated).toBe(true);
  });

  it("reports no truncation when everything fits", () => {
    expect(allocationSegments(twoWeeks).truncated).toBe(false);
  });

  it("returns nothing for no tasks", () => {
    expect(allocationSegments([])).toEqual({ segments: [], truncated: false });
  });
});

describe("draftError", () => {
  const valid = {
    ...EMPTY_TIME_AVAILABILITY_DRAFT,
    category: "jinesis" as const,
    project: "Alignment",
    start: "2026-03-02",
    end: "2026-03-15",
    hoursPerWeek: "20",
  };

  it("accepts a complete row", () => {
    expect(draftError(valid)).toBeNull();
  });

  it("requires both dates", () => {
    expect(draftError({ ...valid, start: "" })).not.toBeNull();
    expect(draftError({ ...valid, end: "" })).not.toBeNull();
  });

  it("rejects an end before the start", () => {
    expect(draftError({ ...valid, start: "2026-03-15", end: "2026-03-02" })).not.toBeNull();
  });

  // Mirrors the service's own bound (validateMember in the kernel), so the common mistakes never
  // cost a round trip.
  it("rejects hours outside 0-168", () => {
    expect(draftError({ ...valid, hoursPerWeek: "0" })).not.toBeNull();
    expect(draftError({ ...valid, hoursPerWeek: "200" })).not.toBeNull();
    expect(draftError({ ...valid, hoursPerWeek: "abc" })).not.toBeNull();
  });
});

describe("renderAdminBotTimeAvailability", () => {
  // Editing is self-only: the service routes a member session to its own record, so showing the
  // form on someone else's schedule would only ever produce a 403.
  it("shows the editor on your own schedule and hides it on someone else's", () => {
    expect(renderView().querySelector('[data-testid="time-availability-editor"]')).not.toBeNull();
    expect(
      renderView({ viewerMemberId: "someone-else" }).querySelector(
        '[data-testid="time-availability-editor"]',
      ),
    ).toBeNull();
  });

  it("appends the drafted commitment to the existing rows on submit", () => {
    const onSaveSchedule = vi.fn();
    const container = renderView({
      onSaveSchedule,
      draft: {
        ...EMPTY_TIME_AVAILABILITY_DRAFT,
        project: "Writing",
        start: "2026-04-01",
        end: "2026-04-30",
        hoursPerWeek: "10",
        note: "thesis",
      },
    });
    container.querySelector<HTMLFormElement>(".adminbot-time-availability__form")?.requestSubmit();

    expect(onSaveSchedule).toHaveBeenCalledTimes(1);
    const [memberId, patch] = onSaveSchedule.mock.calls[0];
    expect(memberId).toBe("m1");
    // The stored row survives alongside the new one -- the whole list is what gets written.
    expect(patch.availability).toHaveLength(2);
    expect(patch.availability[1]).toEqual({
      start: "2026-04-01",
      end: "2026-04-30",
      hours_per_week: 10,
      project: "Writing",
      note: "thesis",
    });
  });

  it("does not submit an invalid draft", () => {
    const onSaveSchedule = vi.fn();
    const container = renderView({
      onSaveSchedule,
      draft: { ...EMPTY_TIME_AVAILABILITY_DRAFT, start: "2026-04-30", end: "2026-04-01" },
    });
    container.querySelector<HTMLFormElement>(".adminbot-time-availability__form")?.requestSubmit();
    expect(onSaveSchedule).not.toHaveBeenCalled();
  });

  // Hours need no denominator, so an unset capacity costs the reference line and nothing else --
  // the percentage view could not chart at all without one.
  it("still charts when no weekly capacity is set", () => {
    const container = renderView({ members: [member({ hours_per_week: undefined })] });
    expect(container.querySelector(".adminbot-time-chart")).not.toBeNull();
    expect(container.textContent).toContain("No weekly capacity set");
  });
});

describe("the holiday override", () => {
  const work = [{ key: "a", name: "Atlas", start: "2026-03-02", end: "2026-03-15", hours: 20 }];

  // A whole-day time-off row wins over whatever Jinesis work was scheduled underneath it: the
  // member is away, so the hours are not happening. The holiday's own dates become breakpoints,
  // which is what lets it cut a commitment that would otherwise be one unbroken bar.
  it("splits a commitment at the holiday and zeroes the covered part", () => {
    const { segments } = allocationSegments(work, [
      { start: "2026-03-09", end: "2026-03-15", kind: "vacation", availability: "none" },
    ]);
    expect(segments.map((segment) => segment.start)).toEqual(["2026-03-02", "2026-03-09"]);
    expect(segments[0].total).toBe(20);
    expect(segments[0].suppressed).toBe(false);
    expect(segments[1].total).toBe(0);
    expect(segments[1].suppressed).toBe(true);
    expect(segments[1].allocations).toEqual([]);
  });

  // Half a week off does not zero anything, and there is no stored figure saying what it does.
  it("leaves a partial row alone", () => {
    const { segments } = allocationSegments(work, [
      { start: "2026-03-09", end: "2026-03-15", kind: "course_load", availability: "partial" },
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0].total).toBe(20);
    expect(segments[0].suppressed).toBe(false);
  });

  // A holiday in the middle leaves work on both sides of it.
  it("suppresses exactly the days the row covers", () => {
    const { segments } = allocationSegments(work, [
      { start: "2026-03-09", end: "2026-03-10", kind: "vacation", availability: "none" },
    ]);
    expect(
      segments.map((segment) => ({ start: segment.start, off: segment.suppressed })),
    ).toEqual([
      { start: "2026-03-02", off: false },
      { start: "2026-03-09", off: true },
      { start: "2026-03-11", off: false },
    ]);
  });

  it("keeps a suppressed segment at the start of the range", () => {
    const { segments } = allocationSegments(work, [
      { start: "2026-03-02", end: "2026-03-08", kind: "vacation", availability: "none" },
    ]);
    expect(segments[0].suppressed).toBe(true);
    expect(segments[0].start).toBe("2026-03-02");
  });

  // A holiday nowhere near the commitments must not stretch the axis over the empty months
  // between them.
  it("ignores time off outside the span the commitments cover", () => {
    const { segments } = allocationSegments(work, [
      { start: "2026-09-01", end: "2026-09-07", kind: "vacation", availability: "none" },
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0].suppressed).toBe(false);
  });
});

describe("the hours unit", () => {
  const scaled = [
    { start: "2026-03-02", end: "2026-03-15", project: "Atlas", hours_per_week: 21 },
  ];

  // The unit changes the number, never the bars: the segmentation is the same object in all three.
  it("keeps the identical segments whatever the unit", () => {
    const week = renderView({ hoursUnit: "week", members: [member({ availability: scaled })] });
    const month = renderView({ hoursUnit: "month", members: [member({ availability: scaled })] });
    const bars = (root: HTMLElement) => root.querySelectorAll(".adminbot-time-chart__segment");
    expect(bars(week)).toHaveLength(bars(month).length);
    expect(bars(week).length).toBeGreaterThan(0);
  });

  it("quotes stored hours as-is for the week unit", () => {
    const container = renderView({ hoursUnit: "week", members: [member({ availability: scaled })] });
    expect(container.textContent).toContain("21 h/wk");
  });

  // 21 h/wk is 3 h/day and 91 h/mo (52/12 weeks). Storage never changes; only the reading does.
  it("rescales to hours per day", () => {
    const container = renderView({ hoursUnit: "day", members: [member({ availability: scaled })] });
    expect(container.textContent).toContain("3 h/day");
  });

  it("rescales to hours per month", () => {
    const container = renderView({
      hoursUnit: "month",
      members: [member({ availability: scaled })],
    });
    expect(container.textContent).toContain("91 h/mo");
  });

  it("marks the active unit and switches on click", () => {
    const onHoursUnitChange = vi.fn();
    const container = renderView({ hoursUnit: "month", onHoursUnitChange });
    expect(
      container
        .querySelector('[data-testid="time-availability-unit-month"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    container
      .querySelector<HTMLButtonElement>('[data-testid="time-availability-unit-day"]')
      ?.click();
    expect(onHoursUnitChange).toHaveBeenCalledWith("day");
  });
});

describe("the whole-day toggle", () => {
  it("offers it for a time-away category, ticked by default", () => {
    const container = renderView({
      awayDraft: { ...EMPTY_TIME_AVAILABILITY_DRAFT, category: "vacation" },
    });
    const box = container.querySelector<HTMLInputElement>(
      '[data-testid="time-availability-whole-day"]',
    );
    expect(box).not.toBeNull();
    expect(box?.checked).toBe(true);
  });

  // Jinesis work is measured in hours, so "away the whole day" is not a question it answers.
  // The toggle lives in the time-away form only. The Jinesis form asks for hours instead, and
  // now that they are two forms neither ever shows the other's field.
  it("keeps the toggle out of the Jinesis form, which asks for hours instead", () => {
    const container = renderView();
    const jinesis = container.querySelector('[data-testid="time-availability-editor"]')!;
    const away = container.querySelector('[data-testid="time-away-editor"]')!;
    expect(jinesis.querySelector('[data-testid="time-availability-whole-day"]')).toBeNull();
    expect(jinesis.querySelector('[data-testid="time-availability-hours"]')).not.toBeNull();
    expect(away.querySelector('[data-testid="time-availability-whole-day"]')).not.toBeNull();
    expect(away.querySelector('[data-testid="time-availability-hours"]')).toBeNull();
  });
});

describe("draftToPatch", () => {
  const empty = { availability: [], timeOff: [] };

  it("writes a Jinesis commitment to the availability list with its hours", () => {
    const patch = draftToPatch(
      {
        ...EMPTY_TIME_AVAILABILITY_DRAFT,
        category: "jinesis",
        project: "Atlas",
        start: "2026-03-02",
        end: "2026-03-15",
        hoursPerWeek: "20",
        link: "https://example.com/board",
      },
      empty,
    );
    expect(patch.time_off).toBeUndefined();
    expect(patch.availability).toEqual([
      {
        start: "2026-03-02",
        end: "2026-03-15",
        hours_per_week: 20,
        project: "Atlas",
        link: "https://example.com/board",
      },
    ]);
  });

  // Everything that is not Jinesis work is time away, and defaults to a whole day off.
  it("writes any other category to time off as a whole day off", () => {
    const patch = draftToPatch(
      {
        ...EMPTY_TIME_AVAILABILITY_DRAFT,
        category: "vacation",
        start: "2026-12-24",
        end: "2027-01-02",
      },
      empty,
    );
    expect(patch.availability).toBeUndefined();
    expect(patch.time_off).toEqual([
      { start: "2026-12-24", end: "2027-01-02", kind: "vacation", availability: "none" },
    ]);
  });

  // "Whole day" is the default, not the only option: the table already renders imported "Partial"
  // rows, so a member needs some way to record and correct one.
  it("records reduced availability when the whole-day box is unticked", () => {
    const patch = draftToPatch(
      {
        ...EMPTY_TIME_AVAILABILITY_DRAFT,
        category: "course_load",
        wholeDay: false,
        start: "2026-09-01",
        end: "2026-12-15",
      },
      empty,
    );
    expect(patch.time_off?.[0]).toMatchObject({ availability: "partial" });
  });

  it("carries the member's own name through for the 'other' category", () => {
    const patch = draftToPatch(
      {
        ...EMPTY_TIME_AVAILABILITY_DRAFT,
        category: "other",
        customLabel: "Reading week",
        start: "2026-10-13",
        end: "2026-10-17",
      },
      empty,
    );
    expect(patch.time_off?.[0]).toMatchObject({ kind: "other", label: "Reading week" });
  });

  it("appends rather than replacing", () => {
    const patch = draftToPatch(
      {
        ...EMPTY_TIME_AVAILABILITY_DRAFT,
        category: "personal",
        start: "2026-05-01",
        end: "2026-05-02",
      },
      {
        availability: [],
        timeOff: [
          { start: "2026-01-01", end: "2026-01-02", kind: "vacation", availability: "none" },
        ],
      },
    );
    expect(patch.time_off).toHaveLength(2);
  });
});

describe("draft validation for the new fields", () => {
  const base = {
    ...EMPTY_TIME_AVAILABILITY_DRAFT,
    start: "2026-03-02",
    end: "2026-03-15",
  };

  // Only Jinesis work costs weekly hours, so the rest must not demand a number.
  it("does not require hours for a non-Jinesis category", () => {
    expect(draftError({ ...base, category: "vacation" })).toBeNull();
    expect(draftError({ ...base, category: "jinesis" })).not.toBeNull();
  });

  it("requires a name when the category is 'other'", () => {
    expect(draftError({ ...base, category: "other" })).not.toBeNull();
    expect(draftError({ ...base, category: "other", customLabel: "Reading week" })).toBeNull();
  });

  // Matches validateExternalLink server-side: these render as anchors.
  it("rejects a link that is not https", () => {
    expect(
      draftError({ ...base, category: "vacation", link: "http://example.com" }),
    ).not.toBeNull();
    expect(draftError({ ...base, category: "vacation", link: "example.com" })).not.toBeNull();
    expect(draftError({ ...base, category: "vacation", link: "https://example.com" })).toBeNull();
  });
});

describe("milestoneDraftError", () => {
  it("requires a date and a name", () => {
    expect(milestoneDraftError({ ...EMPTY_MILESTONE_DRAFT })).not.toBeNull();
    expect(milestoneDraftError({ date: "2027-06-12", label: "", link: "" })).not.toBeNull();
    expect(milestoneDraftError({ date: "2027-06-12", label: "Graduation", link: "" })).toBeNull();
  });

  it("rejects a non-https link", () => {
    expect(
      milestoneDraftError({ date: "2027-06-12", label: "Graduation", link: "http://x.com" }),
    ).not.toBeNull();
  });
});

describe("the split tables and the deadline panel", () => {
  const scheduled = () =>
    member({
      time_off: [
        { start: "2026-12-24", end: "2027-01-02", kind: "vacation", availability: "none" },
      ],
      milestones: [{ date: "2027-06-12", label: "Graduation" }],
    });

  it("separates Jinesis commitments from everything else", () => {
    const container = renderView({ members: [scheduled()] });
    const jinesis = container.querySelector('[data-testid="time-availability-jinesis-table"]');
    const other = container.querySelector('[data-testid="time-availability-other-table"]');
    expect(jinesis?.textContent).toContain("Alignment");
    expect(other?.textContent).toContain("Holiday");
    expect(other?.textContent).toContain("Whole day off");
    // The holiday is not a Jinesis commitment, so it must not appear in that table.
    expect(jinesis?.textContent).not.toContain("Holiday");
  });

  it("shows hours per week rather than a percentage", () => {
    const container = renderView();
    expect(
      container.querySelector('[data-testid="time-availability-jinesis-table"]')?.textContent,
    ).toContain("20 h/wk");
  });

  // Conference dates come from the bundled snapshot the Deadlines tab already ships, so the lab
  // tracks them once instead of every member retyping them.
  // Per user, not shared. The panel used to merge in the bundled conference snapshot, which put the
  // same five dates on all 159 schedules and buried the two or three that are personal to whoever's
  // page you are on. The Deadlines tab already lists conferences for everyone.
  it("shows only this member's own milestones, not the lab's conference dates", () => {
    const panel = renderView({ members: [scheduled()] }).querySelector(
      '[data-testid="time-availability-deadlines"]',
    );
    expect(panel?.textContent).toContain("Graduation");
    expect(panel?.textContent).not.toContain("ICLR");
    expect(panel?.textContent).not.toContain("NeurIPS");
  });

  it("reminds the member that thesis deadlines belong here too", () => {
    const panel = renderView({ members: [scheduled()] }).querySelector(
      '[data-testid="time-availability-deadlines"]',
    );
    const hint = panel?.querySelector(".adminbot-time-availability__deadline-hint")?.textContent;
    expect(hint).toContain("thesis");
    // And that the list is theirs alone, which is the other half of the change.
    expect(hint?.toLowerCase()).toContain("yours only");
  });

  it("offers the milestone form only on your own schedule", () => {
    expect(
      renderView({ members: [scheduled()] }).querySelector(
        '[data-testid="time-availability-milestone-form"]',
      ),
    ).not.toBeNull();
    expect(
      renderView({ members: [scheduled()], viewerMemberId: "someone-else" }).querySelector(
        '[data-testid="time-availability-milestone-form"]',
      ),
    ).toBeNull();
  });

  it("adds a milestone through the schedule patch", () => {
    const onSaveSchedule = vi.fn();
    const container = renderView({
      members: [scheduled()],
      onSaveSchedule,
      milestoneDraft: { date: "2026-11-03", label: "Thesis draft", link: "" },
    });
    container
      .querySelector<HTMLFormElement>('[data-testid="time-availability-milestone-form"]')
      ?.requestSubmit();
    expect(onSaveSchedule).toHaveBeenCalledTimes(1);
    const [, patch] = onSaveSchedule.mock.calls[0];
    expect(patch.milestones).toHaveLength(2);
    expect(patch.milestones[1]).toEqual({ date: "2026-11-03", label: "Thesis draft" });
  });

  // The hours field is meaningless for time away and must not be asked for.
  // Two chunks of adding, not one form with a mode switch: a Jinesis commitment costs weekly
  // hours and lands on `availability`, time away carries none and lands on `time_off`.
  it("offers both add forms, each with only the fields it stores", () => {
    const container = renderView();
    const jinesis = container.querySelector('[data-testid="time-availability-editor"]')!;
    const away = container.querySelector('[data-testid="time-away-editor"]')!;
    expect(jinesis).not.toBeNull();
    expect(away).not.toBeNull();
    // The Jinesis form has no category picker at all -- its category is pinned.
    expect(jinesis.querySelector('[data-testid="time-away-category"]')).toBeNull();
    expect(away.querySelector('[data-testid="time-away-category"]')).not.toBeNull();
    // Each keeps its own submit, so neither can clear the other's half-typed input.
    expect(jinesis.querySelector('[data-testid="time-availability-editor-submit"]')).not.toBeNull();
    expect(away.querySelector('[data-testid="time-away-editor-submit"]')).not.toBeNull();
  });

  it("never offers Jinesis as a time-away category", () => {
    const options = [
      ...renderView()
        .querySelector('[data-testid="time-away-category"]')!
        .querySelectorAll("option"),
    ].map((option) => option.getAttribute("value"));
    expect(options).not.toContain("jinesis");
    expect(options).toContain("vacation");
  });

  it("asks for a custom name only for the 'other' category", () => {
    expect(renderView().querySelector('[data-testid="time-availability-custom-label"]')).toBeNull();
    expect(
      renderView({
        awayDraft: { ...EMPTY_TIME_AVAILABILITY_DRAFT, category: "other" },
      }).querySelector('[data-testid="time-availability-custom-label"]'),
    ).not.toBeNull();
  });
});

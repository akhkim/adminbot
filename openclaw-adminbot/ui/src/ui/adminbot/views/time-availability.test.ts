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
    granularity: "week" as const,
    onGranularityChange: () => {},
    viewerMemberId: "m1",
    draft: { ...EMPTY_TIME_AVAILABILITY_DRAFT },
    onDraftChange: () => {},
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

  it("buckets by calendar week, Monday-aligned", () => {
    const { segments } = allocationSegments(twoWeeks, "week");
    // 2026-03-02 is a Monday, so the two weeks land exactly on two buckets.
    expect(segments).toHaveLength(2);
    expect(segments[0].start).toBe("2026-03-02");
    expect(segments[1].start).toBe("2026-03-09");
    expect(segments[0].total).toBe(20);
  });

  it("buckets by day", () => {
    const { segments } = allocationSegments(twoWeeks, "day");
    expect(segments).toHaveLength(14);
    expect(segments[0].start).toBe("2026-03-02");
    expect(segments.at(-1)?.start).toBe("2026-03-15");
  });

  it("buckets by calendar month, anchored to the first", () => {
    const { segments } = allocationSegments(
      tasks([{ key: "a", name: "A", start: "2026-03-20", end: "2026-05-04", hours: 10 }]),
      "month",
    );
    expect(segments.map((segment) => segment.start)).toEqual([
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
    ]);
  });

  it("stacks overlapping commitments inside one bucket", () => {
    const { segments } = allocationSegments(
      tasks([
        { key: "a", name: "A", start: "2026-03-02", end: "2026-03-08", hours: 20 },
        { key: "b", name: "B", start: "2026-03-02", end: "2026-03-08", hours: 10 },
      ]),
      "week",
    );
    expect(segments).toHaveLength(1);
    expect(segments[0].total).toBe(30);
    expect(segments[0].allocations.map((allocation) => allocation.key)).toEqual(["a", "b"]);
  });

  // A gap is information: "nothing booked in April" should not silently close up, or the timeline
  // would misrepresent two distant commitments as adjacent.
  it("keeps interior gaps but trims empty edges", () => {
    const { segments } = allocationSegments(
      tasks([
        { key: "a", name: "A", start: "2026-03-01", end: "2026-03-31", hours: 20 },
        { key: "b", name: "B", start: "2026-06-01", end: "2026-06-30", hours: 20 },
      ]),
      "month",
    );
    expect(segments.map((segment) => segment.start)).toEqual([
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
    ]);
    expect(segments[1].allocations).toEqual([]);
    expect(segments[0].allocations).not.toEqual([]);
    expect(segments.at(-1)?.allocations).not.toEqual([]);
  });

  // A day view over a multi-year range is thousands of unreadable bars and a giant SVG.
  it("caps the bucket count and reports the truncation", () => {
    const { segments, truncated } = allocationSegments(
      tasks([{ key: "a", name: "A", start: "2026-01-01", end: "2029-01-01", hours: 5 }]),
      "day",
    );
    expect(segments).toHaveLength(60);
    expect(truncated).toBe(true);
  });

  it("reports no truncation when everything fits", () => {
    expect(allocationSegments(twoWeeks, "week").truncated).toBe(false);
  });

  it("returns nothing for no tasks", () => {
    expect(allocationSegments([], "week")).toEqual({ segments: [], truncated: false });
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
  it("offers the three granularities and marks the active one", () => {
    const container = renderView({ granularity: "month" });
    const active = container.querySelector<HTMLButtonElement>(
      '[data-testid="time-availability-granularity-month"]',
    );
    expect(active?.getAttribute("aria-pressed")).toBe("true");
    expect(
      container
        .querySelector('[data-testid="time-availability-granularity-day"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("switches granularity on click", () => {
    const onGranularityChange = vi.fn();
    const container = renderView({ onGranularityChange });
    container
      .querySelector<HTMLButtonElement>('[data-testid="time-availability-granularity-day"]')
      ?.click();
    expect(onGranularityChange).toHaveBeenCalledWith("day");
  });

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
  // member is away, so the hours are not happening.
  it("zeroes a bucket a whole-day row covers entirely", () => {
    const { segments } = allocationSegments(work, "week", [
      { start: "2026-03-09", end: "2026-03-15", kind: "vacation", availability: "none" },
    ]);
    expect(segments[0].total).toBe(20);
    expect(segments[0].suppressed).toBe(false);
    expect(segments[1].total).toBe(0);
    expect(segments[1].suppressed).toBe(true);
    expect(segments[1].allocations).toEqual([]);
  });

  // Half a week off does not zero the week, and there is no stored figure saying what it does.
  it("leaves a partial row alone", () => {
    const { segments } = allocationSegments(work, "week", [
      { start: "2026-03-09", end: "2026-03-15", kind: "course_load", availability: "partial" },
    ]);
    expect(segments[1].total).toBe(20);
    expect(segments[1].suppressed).toBe(false);
  });

  // Covering three days of a week is not covering the week.
  it("does not suppress a bucket the row only partly covers", () => {
    const { segments } = allocationSegments(work, "week", [
      { start: "2026-03-09", end: "2026-03-11", kind: "vacation", availability: "none" },
    ]);
    expect(segments[1].suppressed).toBe(false);
    expect(segments[1].total).toBe(20);
  });

  // At day granularity the same row suppresses exactly its own days.
  it("suppresses exactly the covered days at day granularity", () => {
    const { segments } = allocationSegments(work, "day", [
      { start: "2026-03-09", end: "2026-03-10", kind: "vacation", availability: "none" },
    ]);
    const suppressed = segments.filter((segment) => segment.suppressed).map((s) => s.start);
    expect(suppressed).toEqual(["2026-03-09", "2026-03-10"]);
  });

  // A suppressed bucket is a holiday, not an absence of data, so the edge trim keeps it.
  it("keeps a suppressed bucket at the edge of the range", () => {
    const { segments } = allocationSegments(work, "week", [
      { start: "2026-03-02", end: "2026-03-08", kind: "vacation", availability: "none" },
    ]);
    expect(segments[0].suppressed).toBe(true);
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
  it("merges own milestones with the lab's conference deadlines", () => {
    const panel = renderView({ members: [scheduled()] }).querySelector(
      '[data-testid="time-availability-deadlines"]',
    );
    expect(panel?.textContent).toContain("Graduation");
    expect(panel?.textContent).toContain("ICLR 2027");
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
  it("hides the hours field for a non-Jinesis category", () => {
    const container = renderView({
      draft: { ...EMPTY_TIME_AVAILABILITY_DRAFT, category: "vacation" },
    });
    expect(container.querySelector('[data-testid="time-availability-hours"]')).toBeNull();
    expect(container.querySelector('[data-testid="time-availability-link"]')).not.toBeNull();
  });

  it("asks for a custom name only for the 'other' category", () => {
    expect(renderView().querySelector('[data-testid="time-availability-custom-label"]')).toBeNull();
    expect(
      renderView({
        draft: { ...EMPTY_TIME_AVAILABILITY_DRAFT, category: "other" },
      }).querySelector('[data-testid="time-availability-custom-label"]'),
    ).not.toBeNull();
  });
});

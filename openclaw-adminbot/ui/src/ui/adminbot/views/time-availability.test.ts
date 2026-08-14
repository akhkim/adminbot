import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AdminBotLabMember } from "../controllers/admin.ts";
import {
  allocationBins,
  rangeBins,
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
    range: "month" as const,
    onRangeChange: () => {},
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

const NOW = Date.UTC(2026, 2, 2); // Monday 2 March 2026

describe("rangeBins", () => {
  it("gives a week seven day-long bins from today", () => {
    const bins = rangeBins("week", NOW);
    expect(bins).toHaveLength(7);
    expect(bins[0].startMs).toBe(NOW);
    expect((bins[0].endMs - bins[0].startMs) / 86_400_000).toBe(1);
    expect(bins.at(-1)?.endMs).toBe(NOW + 7 * 86_400_000);
  });

  it("gives a month four week-long bins from today", () => {
    const bins = rangeBins("month", NOW);
    expect(bins).toHaveLength(4);
    for (const bin of bins) {
      expect((bin.endMs - bin.startMs) / 86_400_000).toBe(7);
    }
  });

  // Months are not equal lengths, so these step by the calendar rather than by a day count.
  it("gives a year twelve calendar-month bins", () => {
    const bins = rangeBins("year", NOW);
    expect(bins).toHaveLength(12);
    expect(new Date(bins[0].startMs).getUTCDate()).toBe(1);
    expect(new Set(bins.map((bin) => (bin.endMs - bin.startMs) / 86_400_000)).size).toBeGreaterThan(
      1,
    );
    expect(bins.map((bin) => bin.label)).toContain("Dec");
  });
});

describe("allocationBins", () => {
  const march = tasks([
    { key: "a", name: "Alignment", start: "2026-03-01", end: "2026-03-31", hours: 21 },
  ]);

  // Everything is stored as hours per week, so a bar is that rate prorated over the days its bin
  // covers. That is what makes the three ranges comparable.
  it("prorates a weekly rate over the days a bin covers", () => {
    expect(allocationBins(march, [], "week", NOW)[0].total).toBeCloseTo(3, 5);
    expect(allocationBins(march, [], "month", NOW)[0].total).toBeCloseTo(21, 5);
  });

  it("counts only the days a commitment actually covers in the bin", () => {
    const late = tasks([{ key: "a", name: "A", start: "2026-03-05", end: "2026-03-31", hours: 21 }]);
    expect(allocationBins(late, [], "month", NOW)[0].total).toBeCloseTo((21 * 4) / 7, 5);
  });

  it("stacks overlapping commitments in the same bin", () => {
    const both = allocationBins(
      tasks([
        { key: "a", name: "A", start: "2026-03-01", end: "2026-03-31", hours: 14 },
        { key: "b", name: "B", start: "2026-03-01", end: "2026-03-31", hours: 7 },
      ]),
      [],
      "month",
      NOW,
    )[0];
    expect(both.allocations.map((allocation) => allocation.key)).toEqual(["a", "b"]);
    expect(both.total).toBeCloseTo(21, 5);
  });

  it("keeps empty bins so a gap in the schedule reads as a gap", () => {
    const bins = allocationBins(
      tasks([{ key: "a", name: "A", start: "2026-03-01", end: "2026-03-07", hours: 21 }]),
      [],
      "month",
      NOW,
    );
    expect(bins).toHaveLength(4);
    expect(bins[0].total).toBeGreaterThan(0);
    expect(bins.at(-1)?.total).toBe(0);
  });

  it("returns the range's bins even with no commitments at all", () => {
    expect(allocationBins([], [], "week", NOW)).toHaveLength(7);
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
    expect(container.querySelector(".time-chart__svg")).not.toBeNull();
    expect(container.textContent).toContain("No weekly capacity set");
  });
});

describe("the holiday override", () => {
  const work = [{ key: "a", name: "Atlas", start: "2026-03-01", end: "2026-03-31", hours: 21 }];

  // Whole-day time off removes days from the bin before anything is booked against it, so a week
  // with two days off books five-sevenths of its commitments.
  it("scales a bin down by the days the member is away", () => {
    const bins = allocationBins(
      work,
      [{ start: "2026-03-02", end: "2026-03-03", kind: "vacation", availability: "none" }],
      "month",
      NOW,
    );
    expect(bins[0].total).toBeCloseTo((21 * 5) / 7, 5);
  });

  // Away for the entire bin: nothing is bookable, which the chart draws as absence, not a zero.
  it("marks a bin the member is away for the whole of", () => {
    const bins = allocationBins(
      work,
      [{ start: "2026-03-02", end: "2026-03-08", kind: "vacation", availability: "none" }],
      "month",
      NOW,
    );
    expect(bins[0].suppressed).toBe(true);
    expect(bins[0].total).toBe(0);
    expect(bins[1].suppressed).toBe(false);
    expect(bins[1].total).toBeGreaterThan(0);
  });

  it("leaves a partial row alone", () => {
    const bins = allocationBins(
      work,
      [{ start: "2026-03-02", end: "2026-03-08", kind: "course_load", availability: "partial" }],
      "month",
      NOW,
    );
    expect(bins[0].suppressed).toBe(false);
    expect(bins[0].total).toBeCloseTo(21, 5);
  });

  // Two holidays over the same days must not cancel more work than the member is away for.
  it("counts an overlapping pair of holidays once", () => {
    const bins = allocationBins(
      work,
      [
        { start: "2026-03-02", end: "2026-03-04", kind: "vacation", availability: "none" },
        { start: "2026-03-03", end: "2026-03-05", kind: "personal", availability: "none" },
      ],
      "month",
      NOW,
    );
    expect(bins[0].total).toBeCloseTo((21 * 3) / 7, 5);
  });
});

describe("the chart", () => {
  it("draws one bar slot per bin for the chosen range", () => {
    const bins = (range: "week" | "month" | "year") =>
      renderView({ range }).querySelectorAll(".time-chart__bin").length;
    expect(bins("week")).toBe(7);
    expect(bins("month")).toBe(4);
    expect(bins("year")).toBe(12);
  });

  it("offers the three ranges and marks the active one", () => {
    const onRangeChange = vi.fn();
    const container = renderView({ range: "year", onRangeChange });
    expect(
      container
        .querySelector('[data-testid="time-availability-range-year"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    container
      .querySelector<HTMLButtonElement>('[data-testid="time-availability-range-week"]')
      ?.click();
    expect(onRangeChange).toHaveBeenCalledWith("week");
  });

  // Capacity is the headroom reading: without it a chart scaled to its own tallest bar makes every
  // member look equally busy.
  it("draws the capacity line only when the member declared one", () => {
    expect(renderView().querySelector(".time-chart__capacity")).not.toBeNull();
    expect(renderView().querySelector(".time-chart__capacity-key")).not.toBeNull();

    const without = renderView({
      members: [member({ hours_per_week: undefined } as Partial<AdminBotLabMember>)],
    });
    expect(without.querySelector(".time-chart__capacity")).toBeNull();
    // And says why the comparison is missing rather than leaving a bare chart.
    expect(without.querySelector(".time-chart__note")).not.toBeNull();
  });

  it("names the unit each bar is measured in", () => {
    expect(renderView({ range: "week" }).querySelector(".time-chart__unit")?.textContent).toContain(
      "day",
    );
    expect(renderView({ range: "year" }).querySelector(".time-chart__unit")?.textContent).toContain(
      "month",
    );
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
    ).toContain("20 h");
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

  // A note is the half of a commitment that the dates and hours cannot carry, and until now it was
  // write-only: the form stored it and nothing ever showed it back.
  it("shows the note on a commitment as a closed disclosure under its row", () => {
    const container = renderView({
      members: [
        member({
          availability: [
            {
              start: "2026-03-02",
              end: "2026-03-15",
              project: "Alignment",
              hours_per_week: 20,
              note: "Only until the submission",
            },
          ],
        }),
      ],
    });
    const details = container.querySelector<HTMLDetailsElement>(
      '[data-testid="time-availability-jinesis-table"] .adminbot-time-allocation-table__note',
    );
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Only until the submission");
  });

  it("shows the note on time away too", () => {
    const container = renderView({
      members: [
        member({
          time_off: [
            {
              start: "2026-12-24",
              end: "2027-01-02",
              kind: "vacation",
              availability: "none",
              note: "Family, phone off",
            },
          ],
        }),
      ],
    });
    expect(
      container.querySelector('[data-testid="time-availability-other-table"]')?.textContent,
    ).toContain("Family, phone off");
  });

  // No note, no row: an empty disclosure on every commitment would be pure furniture.
  it("adds no note row to a commitment without one", () => {
    expect(renderView().querySelector(".adminbot-time-allocation-table__note-row")).toBeNull();
  });

  it("carries the note into the bar's hover text as well", () => {
    const container = renderView({
      range: "month",
      members: [
        member({
          availability: [
            {
              start: "2026-03-02",
              end: "2027-03-15",
              project: "Alignment",
              hours_per_week: 20,
              note: "Shared with Mei",
            },
          ],
        }),
      ],
    });
    const titles = [...container.querySelectorAll(".time-chart__bar title")].map(
      (title) => title.textContent ?? "",
    );
    expect(titles.some((title) => title.includes("Shared with Mei"))).toBe(true);
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

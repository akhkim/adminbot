import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotLabMember } from "../controllers/admin.ts";
import { allUpcomingVenues, aoeInstantMs, upcomingMajorDeadlines } from "../data/deadline-time.ts";
import { EMPTY_TRIP_DRAFT } from "./time-availability.trips.ts";
import {
  allocationBins,
  rangeBins,
  draftError,
  draftToPatch,
  EMPTY_MILESTONE_DRAFT,
  EMPTY_TIME_AVAILABILITY_DRAFT,
  milestoneDraftError,
  milestoneToRow,
  renderAdminBotTimeAvailability,
  withinWindow,
  type AdminBotTimeAvailabilityProps,
  type MilestoneDraft,
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
  return entries.map((entry) => ({ ...entry, source: "jinesis" as const }));
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
    tripDraft: { ...EMPTY_TRIP_DRAFT },
    onTripDraftChange: () => {},
    // The default fixture is a plain member reading their own schedule, which is the only page a
    // non-admin can reach at all.
    viewerIsAdmin: false,
    notesDraft: null,
    onNotesDraftChange: () => {},
    activeCommitmentType: null,
    onActiveCommitmentChange: () => {},
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    const late = tasks([
      { key: "a", name: "A", start: "2026-03-05", end: "2026-03-31", hours: 21 },
    ]);
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
  it("shows the add-commitment button on your own schedule and hides it on someone else's", () => {
    expect(
      renderView().querySelector(".adminbot-time-availability__add-commitment"),
    ).not.toBeNull();
    expect(
      renderView({ viewerMemberId: "someone-else" }).querySelector(
        ".adminbot-time-availability__add-commitment",
      ),
    ).toBeNull();
  });

  it.each([
    { reducedMotion: true, behavior: "auto" },
    { reducedMotion: false, behavior: "smooth" },
  ] as const)(
    "scrolls to the editor with $behavior behavior when reduced motion is $reducedMotion",
    ({ reducedMotion, behavior }) => {
      const scrollIntoView = vi.fn();
      const picker = document.createElement("div");
      picker.className = "adminbot-time-availability__commitment-picker";
      picker.scrollIntoView = scrollIntoView;
      document.body.append(picker);
      vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));
      vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
        callback(0);
        return 1;
      });

      try {
        renderView()
          .querySelector<HTMLButtonElement>('[data-testid^="time-availability-commitment-edit-"]')
          ?.click();
        expect(scrollIntoView).toHaveBeenCalledWith({ behavior, block: "start" });
      } finally {
        picker.remove();
      }
    },
  );

  it("appends the drafted commitment to the existing rows on submit", () => {
    const onSaveSchedule = vi.fn();
    const container = renderView({
      onSaveSchedule,
      activeCommitmentType: "jinesis",
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

  it("opens the editor when a stored commitment is edited", () => {
    // The regression: the tables render above the editor stack, and the stack is collapsed until
    // `activeCommitmentType` is set -- which is its state on load. An Edit button that only loaded
    // the draft filled in a form that was not on the page, so the press looked like it did nothing.
    const onDraftChange = vi.fn();
    const onActiveCommitmentChange = vi.fn();
    const container = renderView({
      activeCommitmentType: null,
      onDraftChange,
      onActiveCommitmentChange,
    });
    const edit = container.querySelector<HTMLButtonElement>(
      '[data-testid^="time-availability-commitment-edit-"]',
    );
    expect(edit).not.toBeNull();
    edit?.click();

    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange.mock.calls[0][0]).toMatchObject({
      category: "jinesis",
      project: "Alignment",
      start: "2026-03-02",
      end: "2026-03-15",
      hoursPerWeek: "20",
      // The index is what makes this replace the stored row instead of appending a copy.
      editingIndex: 0,
    });
    expect(onActiveCommitmentChange).toHaveBeenCalledWith("jinesis");
  });

  it("re-opens the Jinesis tab when the editor was left on another one", () => {
    // Loading a Jinesis draft while the away form is on screen is the same failure wearing a
    // different hat: the draft lands somewhere the member cannot see it.
    const onActiveCommitmentChange = vi.fn();
    const container = renderView({
      activeCommitmentType: "away",
      onActiveCommitmentChange,
    });
    container
      .querySelector<HTMLButtonElement>('[data-testid^="time-availability-commitment-edit-"]')
      ?.click();
    expect(onActiveCommitmentChange).toHaveBeenCalledWith("jinesis");
  });

  it("does not submit an invalid draft", () => {
    const onSaveSchedule = vi.fn();
    const container = renderView({
      onSaveSchedule,
      activeCommitmentType: "jinesis",
      draft: { ...EMPTY_TIME_AVAILABILITY_DRAFT, start: "2026-04-30", end: "2026-04-01" },
    });
    container.querySelector<HTMLFormElement>(".adminbot-time-availability__form")?.requestSubmit();
    expect(onSaveSchedule).not.toHaveBeenCalled();
  });

  // The chart measures effort against a weekly capacity, so an unset one is charted against a
  // nominal full week and said out loud rather than left as a silently wrong scale.
  it("still charts when no weekly capacity is set, and says the scale is assumed", () => {
    const container = renderView({ members: [member({ hours_per_week: undefined })] });
    expect(container.querySelector("adminbot-effort-stack-chart")).not.toBeNull();
    expect(container.querySelector('[data-testid="time-availability-no-capacity"]')).not.toBeNull();
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
  // The chart itself is recharts inside a custom element, so what this page owns is the element
  // and the properties handed to it: the bin width the range asks for, and the tasks to stack.
  it("bins by day, week or month to match the chosen range", () => {
    const interval = (range: "week" | "month" | "year") =>
      (
        renderView({ range }).querySelector("adminbot-effort-stack-chart") as unknown as {
          interval: string;
        }
      ).interval;
    expect(interval("week")).toBe("day");
    expect(interval("month")).toBe("week");
    expect(interval("year")).toBe("month");
  });

  // ~200 people on the roster: a <select> could only be searched by native type-ahead, which
  // matches from the start of the option text, so anyone who typed the part of a name they
  // remembered got nothing.
  it("filters the member list by what you type", async () => {
    const container = renderView({
      viewerIsAdmin: true,
      members: [
        member({ id: "one", name: "Yahang Qi" } as Partial<AdminBotLabMember>),
        member({ id: "two", name: "Xuanqiang Angelo Huang" } as Partial<AdminBotLabMember>),
      ],
    });
    document.body.append(container);
    const picker = container.querySelector("adminbot-member-select") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    await picker.updateComplete;
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="time-availability-member-search"]',
    )!;
    input.dispatchEvent(new Event("focus"));
    input.value = "angelo";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await picker.updateComplete;

    const shown = [...container.querySelectorAll(".country-select__option")].map(
      (option) => option.textContent?.trim() ?? "",
    );
    expect(shown.length).toBe(1);
    expect(shown[0]).toContain("Xuanqiang Angelo Huang");
    container.remove();
  });

  // A schedule is holidays, courses, other jobs and whatever the member wrote up about their
  // circumstances. Planning data for the people who plan, so a plain member gets their own page and
  // no way to ask for anyone else's -- the service strips the fields for them anyway.
  it("offers the member picker to an admin and not to a plain member", () => {
    const asAdmin = renderView({ viewerIsAdmin: true });
    expect(asAdmin.querySelector("adminbot-member-select")).not.toBeNull();
    expect(asAdmin.querySelector('[data-testid="time-availability-own-only"]')).toBeNull();

    const asMember = renderView();
    expect(asMember.querySelector("adminbot-member-select")).toBeNull();
    expect(asMember.querySelector('[data-testid="time-availability-own-only"]')).not.toBeNull();
  });

  it("shows a plain member only their own schedule, whoever else is on the roster", () => {
    const container = renderView({
      members: [
        member(),
        // Distinctive on purpose: this asserts on the page's whole text, and the deadline picker
        // lists every venue in the snapshot -- a two-letter name would collide with a venue title.
        member({ id: "other", name: "Zephyrine Quall" } as Partial<AdminBotLabMember>),
      ],
    });
    // Their own record renders; the other one is not reachable from this page.
    expect(container.textContent).toContain("Ada");
    expect(container.textContent).not.toContain("Zephyrine");
  });

  it("selects nothing when a non-admin's selection is not their own record", () => {
    const container = renderView({
      selectedMemberId: "other",
      members: [member(), member({ id: "other", name: "Bo" } as Partial<AdminBotLabMember>)],
    });
    expect(container.querySelector('[data-testid="time-availability-jinesis-table"]')).toBeNull();
  });

  // The rows say when and how much; this is the sentence that explains the ones that need one.
  it("saves the overall note on its own, without touching any list", () => {
    const onSaveSchedule = vi.fn();
    const container = renderView({
      onSaveSchedule,
      notesDraft: "Carer on alternating weeks, so these hours are an average.",
    });
    container
      .querySelector<HTMLFormElement>(".adminbot-time-availability__notes-form")
      ?.requestSubmit();
    expect(onSaveSchedule).toHaveBeenCalledWith("m1", {
      availability_notes: "Carer on alternating weeks, so these hours are an average.",
    });
  });

  it("leaves the note save disabled until the text actually changes", () => {
    const stored = "Away most Fridays.";
    const unchanged = renderView({
      members: [member({ availability_notes: stored } as Partial<AdminBotLabMember>)],
      notesDraft: stored,
    });
    expect(
      unchanged.querySelector<HTMLButtonElement>('[data-testid="time-availability-notes-save"]')
        ?.disabled,
    ).toBe(true);
  });

  // An admin reading someone else's page gets the note as prose: it is context for the rows, and
  // they have no business editing what the member wrote.
  it("shows an admin the note read-only, and nothing at all when there is none", () => {
    const withNote = renderView({
      viewerIsAdmin: true,
      viewerMemberId: "admin",
      members: [
        member({
          availability_notes: "Visa interview may move.",
        } as Partial<AdminBotLabMember>),
      ],
    });
    expect(
      withNote.querySelector('[data-testid="time-availability-notes-text"]')?.textContent,
    ).toContain("Visa interview may move.");
    expect(withNote.querySelector('[data-testid="time-availability-notes-input"]')).toBeNull();

    const withoutNote = renderView({
      viewerIsAdmin: true,
      viewerMemberId: "admin",
    });
    expect(withoutNote.querySelector('[data-testid="time-availability-notes"]')).toBeNull();
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

  // Capacity is the headroom reading. Declared, it is stated on the card and becomes the chart's
  // 100% line; undeclared, the tab says so instead of quietly scaling to the tallest bar.
  it("states the capacity when the member declared one, and flags it when they did not", () => {
    expect(renderView().querySelector(".pill")?.textContent).toContain("40");
    expect(renderView().querySelector('[data-testid="time-availability-no-capacity"]')).toBeNull();

    const without = renderView({
      members: [member({ hours_per_week: undefined } as Partial<AdminBotLabMember>)],
    });
    expect(without.querySelector('[data-testid="time-availability-no-capacity"]')).not.toBeNull();
  });
});

describe("the whole-day toggle", () => {
  it("offers it for a time-away category, ticked by default", () => {
    const container = renderView({
      activeCommitmentType: "away",
      awayDraft: { ...EMPTY_TIME_AVAILABILITY_DRAFT, category: "vacation" },
    });
    const box = container.querySelector<HTMLInputElement>(
      '[data-testid="time-availability-whole-day"]',
    );
    expect(box).not.toBeNull();
    expect(box?.checked).toBe(true);
  });

  // A partial row used to be the claim "around, but less", with no number attached: no chart
  // could draw it and no admin could plan against it. The hours field appears exactly when the
  // whole-day answer stops being enough.
  it("asks for hours as soon as the away row stops being a whole day", () => {
    const whole = renderView({
      activeCommitmentType: "away",
      awayDraft: { ...EMPTY_TIME_AVAILABILITY_DRAFT, category: "vacation" },
    });
    expect(whole.querySelector('[data-testid="time-away-hours"]')).toBeNull();

    const partial = renderView({
      activeCommitmentType: "away",
      awayDraft: { ...EMPTY_TIME_AVAILABILITY_DRAFT, category: "course_load", wholeDay: false },
    });
    expect(partial.querySelector('[data-testid="time-away-hours"]')).not.toBeNull();
  });

  it("refuses a partial row with no hours, and stores them when it has them", () => {
    const base = {
      ...EMPTY_TIME_AVAILABILITY_DRAFT,
      category: "course_load" as const,
      start: "2026-03-02",
      end: "2026-03-15",
      wholeDay: false,
    };
    expect(draftError(base)).not.toBeNull();
    expect(draftError({ ...base, hoursPerWeek: "0" })).not.toBeNull();
    expect(draftError({ ...base, hoursPerWeek: "200" })).not.toBeNull();
    expect(draftError({ ...base, hoursPerWeek: "12" })).toBeNull();

    const patch = draftToPatch({ ...base, hoursPerWeek: "12" }, { availability: [], timeOff: [] });
    expect(patch.time_off?.[0]).toMatchObject({ availability: "partial", hours_per_week: 12 });

    // A whole-day row zeroes the week by definition, so hours on it would be a second answer to
    // a question already settled.
    const wholeDay = draftToPatch(
      { ...base, wholeDay: true, hoursPerWeek: "12" },
      { availability: [], timeOff: [] },
    );
    expect(wholeDay.time_off?.[0]).not.toHaveProperty("hours_per_week");
  });

  // Jinesis work is measured in hours, so "away the whole day" is not a question it answers.
  // The toggle lives in the time-away form only. The Jinesis form asks for hours instead, and
  // now that they are two forms neither ever shows the other's field.
  it("keeps the toggle out of the Jinesis form, which asks for hours instead", () => {
    const container = renderView({ activeCommitmentType: "jinesis" });
    const jinesis = container.querySelector('[data-testid="time-availability-editor"]')!;
    expect(jinesis.querySelector('[data-testid="time-availability-whole-day"]')).toBeNull();
    expect(jinesis.querySelector('[data-testid="time-availability-hours"]')).not.toBeNull();

    const awayContainer = renderView({ activeCommitmentType: "away" });
    const away = awayContainer.querySelector('[data-testid="time-away-editor"]')!;
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

  // Angelo's report: changing a project's dates meant removing the row and typing the whole thing
  // in again. An editing draft rewrites the row it came from instead of appending a second one.
  it("rewrites the row an editing draft came from, in place", () => {
    const existing = {
      availability: [
        { start: "2026-01-01", end: "2026-02-01", hours_per_week: 10, project: "Atlas" },
        { start: "2026-03-02", end: "2026-03-15", hours_per_week: 20, project: "Borealis" },
      ],
      timeOff: [],
    };
    const patch = draftToPatch(
      {
        ...EMPTY_TIME_AVAILABILITY_DRAFT,
        category: "jinesis",
        project: "Atlas",
        // The dates are what moved; everything else is carried over from the row.
        start: "2026-01-08",
        end: "2026-02-14",
        hoursPerWeek: "10",
        editingIndex: 0,
      },
      existing,
    );
    expect(patch.availability).toEqual([
      { start: "2026-01-08", end: "2026-02-14", hours_per_week: 10, project: "Atlas" },
      // Untouched, and still second: an edited row keeps its place in the schedule.
      { start: "2026-03-02", end: "2026-03-15", hours_per_week: 20, project: "Borealis" },
    ]);
  });

  // An index that no longer addresses a row (the list changed underneath the form) appends rather
  // than throwing away the member's typing or overwriting whatever now sits at that position.
  it("appends when the editing index is out of range", () => {
    const patch = draftToPatch(
      {
        ...EMPTY_TIME_AVAILABILITY_DRAFT,
        category: "jinesis",
        project: "Atlas",
        start: "2026-03-02",
        end: "2026-03-15",
        hoursPerWeek: "20",
        editingIndex: 7,
      },
      empty,
    );
    expect(patch.availability).toHaveLength(1);
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

  it("replaces the selected commitment when editing dates", () => {
    const patch = draftToPatch(
      {
        ...EMPTY_TIME_AVAILABILITY_DRAFT,
        category: "jinesis",
        project: "Atlas",
        start: "2026-04-01",
        end: "2026-07-31",
        hoursPerWeek: "18",
        editingIndex: 0,
      },
      {
        availability: [
          { start: "2026-03-01", end: "2026-06-30", project: "Atlas", hours_per_week: 20 },
        ],
        timeOff: [],
      },
    );

    expect(patch.availability).toEqual([
      { start: "2026-04-01", end: "2026-07-31", project: "Atlas", hours_per_week: 18 },
    ]);
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
  const milestone = (fields: Partial<MilestoneDraft>): MilestoneDraft => ({
    ...EMPTY_MILESTONE_DRAFT,
    ...fields,
  });

  it("requires a date and a name", () => {
    expect(milestoneDraftError({ ...EMPTY_MILESTONE_DRAFT })).not.toBeNull();
    expect(milestoneDraftError(milestone({ date: "2027-06-12" }))).not.toBeNull();
    expect(milestoneDraftError(milestone({ date: "2027-06-12", label: "Graduation" }))).toBeNull();
  });

  it("rejects a non-https link", () => {
    expect(
      milestoneDraftError(
        milestone({ date: "2027-06-12", label: "Graduation", link: "http://x.com" }),
      ),
    ).not.toBeNull();
  });

  // A time with no zone is the ambiguity the pair exists to remove: the same digits mean
  // seventeen different things depending on which clock they were read on.
  it("refuses a time with no zone, and keeps the clock off the row unless both halves are there", () => {
    expect(
      milestoneDraftError(
        milestone({ date: "2027-06-12", label: "Submission", time: "23:59", timezone: "" }),
      ),
    ).not.toBeNull();
    expect(
      milestoneDraftError(
        milestone({
          date: "2027-06-12",
          label: "Submission",
          time: "23:59",
          timezone: "Etc/GMT+12",
        }),
      ),
    ).toBeNull();

    expect(
      milestoneToRow(
        milestone({
          date: "2027-06-12",
          label: "Submission",
          time: "23:59",
          timezone: "Etc/GMT+12",
        }),
      ),
    ).toEqual({ date: "2027-06-12", label: "Submission", time: "23:59", timezone: "Etc/GMT+12" });
    // A zone with no time is dropped rather than stored: the zone is prefilled, so keeping it
    // would put a value on every whole-day milestone that nothing ever reads.
    expect(milestoneToRow(milestone({ date: "2027-06-12", label: "Defence" }))).toEqual({
      date: "2027-06-12",
      label: "Defence",
    });
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

  it("loads a non-Jinesis commitment into the away editor and opens it", () => {
    const onAwayDraftChange = vi.fn();
    const onActiveCommitmentChange = vi.fn();
    const container = renderView({
      members: [scheduled()],
      activeCommitmentType: null,
      onAwayDraftChange,
      onActiveCommitmentChange,
    });
    const edit = container.querySelector<HTMLButtonElement>(
      '[data-testid="time-availability-away-edit-0"]',
    );
    expect(edit).not.toBeNull();
    edit?.click();

    expect(onAwayDraftChange).toHaveBeenCalledTimes(1);
    expect(onAwayDraftChange.mock.calls[0][0]).toMatchObject({
      category: "vacation",
      start: "2026-12-24",
      end: "2027-01-02",
      // "none" on the row is the whole-day answer, and it carries no hours to load back.
      wholeDay: true,
      hoursPerWeek: "",
      // Into `time_off`, so submitting replaces this row rather than appending a copy.
      editingIndex: 0,
    });
    expect(onActiveCommitmentChange).toHaveBeenCalledWith("away");
  });

  it("carries a partial row's hours back into the away editor", () => {
    const onAwayDraftChange = vi.fn();
    const container = renderView({
      members: [
        member({
          time_off: [
            {
              start: "2026-05-01",
              end: "2026-05-31",
              kind: "course_load",
              label: "Compilers",
              availability: "partial",
              hours_per_week: 12,
              note: "evenings",
            },
          ],
        }),
      ],
      onAwayDraftChange,
    });
    container
      .querySelector<HTMLButtonElement>('[data-testid="time-availability-away-edit-0"]')
      ?.click();
    expect(onAwayDraftChange.mock.calls[0][0]).toMatchObject({
      category: "course_load",
      customLabel: "Compilers",
      wholeDay: false,
      hoursPerWeek: "12",
      note: "evenings",
      editingIndex: 0,
    });
  });

  it("loads a kind the dropdown does not know as 'other' rather than dropping it", () => {
    // `kind` is free text on the record and the form's dropdown is a closed enum, so a stored row
    // can name something the form cannot select. Falling back to "other" -- the category the custom
    // label belongs to -- keeps the row editable; picking the first enum value would silently
    // retype somebody's internship as a holiday.
    const onAwayDraftChange = vi.fn();
    renderView({
      members: [
        member({
          time_off: [
            { start: "2026-07-01", end: "2026-07-10", kind: "sabbatical", availability: "none" },
          ],
        }),
      ],
      onAwayDraftChange,
    })
      .querySelector<HTMLButtonElement>('[data-testid="time-availability-away-edit-0"]')
      ?.click();
    expect(onAwayDraftChange.mock.calls[0][0]).toMatchObject({ category: "other" });
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

  it("opens an existing Jinesis row in the edit form", () => {
    const onDraftChange = vi.fn();
    const onActiveCommitmentChange = vi.fn();
    const container = renderView({ onDraftChange, onActiveCommitmentChange });

    container
      .querySelector<HTMLButtonElement>('[data-testid^="time-availability-commitment-edit-"]')
      ?.click();

    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "Alignment",
        start: "2026-03-02",
        end: "2026-03-15",
        hoursPerWeek: "20",
        editingIndex: 0,
      }),
    );
    expect(onActiveCommitmentChange).toHaveBeenCalledWith("jinesis");
  });

  // The member's own dates plus the four nearest archival conference deadlines. Archival because
  // that is the split a term is planned around -- those consume the paper -- and they come from
  // the bundled snapshot the Deadlines tab already ships, through the same helper, so the two
  // surfaces can never name a different "next" conference.
  it("shows the member's own milestones alongside the four nearest archival conferences", () => {
    const panel = renderView({ members: [scheduled()] }).querySelector(
      '[data-testid="time-availability-deadlines"]',
    );
    expect(panel?.textContent).toContain("Graduation");
    // Four is the cap, not a promise: the bundled snapshot holds as many archival conferences as
    // it holds, and asserting a fixed count here would break every time it is regenerated.
    const expected = upcomingMajorDeadlines(Date.now(), 4, { archivalOnly: true });
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThanOrEqual(4);
    for (const entry of expected) {
      expect(panel?.textContent).toContain(entry.venue.name);
      expect(entry.venue.archival).toBe(true);
    }
  });

  // A full personal list must not push the conference rows off the banner.
  it("keeps the conference rows even when the member has their own deadlines", () => {
    const own = Array.from({ length: 8 }, (_, index) => ({
      date: `2027-0${(index % 9) + 1}-15`,
      label: `Personal ${index}`,
    }));
    const panel = renderView({
      members: [scheduled({ milestones: own } as Partial<AdminBotLabMember>)],
    }).querySelector('[data-testid="time-availability-deadlines"]');
    for (const entry of upcomingMajorDeadlines(Date.now(), 4, { archivalOnly: true })) {
      expect(panel?.textContent).toContain(entry.venue.name);
    }
  });

  // Four archival conferences is the right default and a bad restriction: the venue somebody needs
  // on their timeline is often a workshop or the fifth conference down. The picker reaches every
  // entry, and copies the snapshot's own cutoff across so nobody retypes an AoE deadline wrong.
  it("adds a venue the panel does not already show, with its exact cutoff", () => {
    const onSaveSchedule = vi.fn();
    const container = renderView({ members: [scheduled()], onSaveSchedule });
    const picker = container.querySelector<HTMLSelectElement>(
      '[data-testid="time-availability-deadline-pick"]',
    )!;
    const shown = upcomingMajorDeadlines(Date.now(), 4, { archivalOnly: true }).map(
      (entry) => entry.venue.deadline_id,
    );
    const offered = [...picker.options].map((option) => option.value);
    expect(offered.length).toBeGreaterThan(0);
    for (const id of shown) {
      expect(offered).not.toContain(id);
    }

    picker.value = offered[0];
    container
      .querySelector<HTMLFormElement>('[data-testid="time-availability-add-deadline"]')
      ?.requestSubmit();
    expect(onSaveSchedule).toHaveBeenCalledTimes(1);
    const [, patch] = onSaveSchedule.mock.calls[0];
    const added = patch.milestones.at(-1);
    const venue = allUpcomingVenues(Date.now()).find(
      (entry) => entry.venue.deadline_id === offered[0],
    )!.venue;
    expect(added.deadline_id).toBe(venue.deadline_id);
    expect(added.label).toBe(venue.name);
    expect(added.date).toBe(venue.deadline_aoe.slice(0, 10));
    expect(added.time).toBe(venue.deadline_aoe.slice(11, 16));
    // AoE is UTC-12; stored as the IANA name so the number means the same to Intl as to a reader.
    expect(added.timezone).toBe("Etc/GMT+12");
  });

  it("shows no active deadline picker to a signed-out visitor", () => {
    expect(
      renderView({ members: [scheduled()], viewerMemberId: null }).querySelector(
        '[data-testid="time-availability-add-deadline"]',
      ),
    ).toBeNull();
  });

  // Reading someone else's schedule is an admin act; adding to it is not.
  it("keeps the deadline picker off a schedule the viewer cannot edit", () => {
    expect(
      renderView({
        members: [scheduled()],
        viewerIsAdmin: true,
        viewerMemberId: "someone-else",
      }).querySelector('[data-testid="time-availability-add-deadline"]'),
    ).toBeNull();
  });

  // A deadline stated to the minute has to say on whose clock, or the digits mean seventeen
  // different things.
  it("prints the exact cutoff and its zone on a milestone that carries one", () => {
    const panel = renderView({
      members: [
        member({
          milestones: [
            {
              date: "2027-06-12",
              label: "Camera ready",
              time: "17:00",
              timezone: "America/Toronto",
            },
          ],
        } as Partial<AdminBotLabMember>),
      ],
    }).querySelector('[data-testid="time-availability-deadlines"]')!;
    const row = [...panel.querySelectorAll("li")].find((entry) =>
      entry.textContent?.includes("Camera ready"),
    );
    expect(row?.textContent).toContain("17:00");
    expect(row?.textContent).toContain("America/Toronto");
  });

  // The banner says what the list holds; the reminder about what belongs in it sits on the form
  // that adds one, which is the moment it is useful.
  it("says on the banner that own deadlines stay private", () => {
    const panel = renderView({ members: [scheduled()] }).querySelector(
      '[data-testid="time-availability-deadlines"]',
    );
    const hint = panel?.querySelector(".adminbot-time-availability__deadline-hint")?.textContent;
    expect(hint?.toLowerCase()).toContain("private");
  });

  it("reminds the member on the add form that thesis deadlines belong here too", () => {
    const editor = renderView({
      members: [scheduled()],
      activeCommitmentType: "milestone",
    }).querySelector('[data-testid="time-availability-milestone-editor"]');
    expect(editor?.querySelector(".card-title")?.textContent).toContain("Add a big deadline");
    expect(editor?.textContent).toContain("thesis");
  });

  // Each deadline carries the urgency band the Deadlines board and the dashboard summary use, so
  // "how close is this" is answered the same way wherever a member reads it.
  it("bands each deadline by how close it is", () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const panel = renderView({
      members: [
        member({
          milestones: [{ date: soon, label: "Thesis proposal" }],
        } as Partial<AdminBotLabMember>),
      ],
    }).querySelector('[data-testid="time-availability-deadlines"]')!;
    const own = [...panel.querySelectorAll("li")].find((row) =>
      row.textContent?.includes("Thesis proposal"),
    );
    expect(own?.getAttribute("data-urgency")).toBe("critical");
    expect(own?.textContent).toContain("In 2 days");
  });

  // The banner reads; the form that writes lives with the other editors.
  it("keeps the add-a-deadline form out of the banner", () => {
    const container = renderView({ members: [scheduled()], activeCommitmentType: "milestone" });
    const panel = container.querySelector('[data-testid="time-availability-deadlines"]')!;
    const form = container.querySelector('[data-testid="time-availability-milestone-form"]')!;
    expect(form).not.toBeNull();
    expect(panel.contains(form)).toBe(false);
    expect(container.querySelector(".adminbot-time-availability__editors")?.contains(form)).toBe(
      true,
    );
  });

  // The page reads top-down: the deadlines first, because a fixed date is what a term is planned
  // around and it is the thing someone opens this page to check, then the chart and its two
  // commitment tables, then the editors as cards after them.
  it("puts the deadline panel before the chart and its tables", () => {
    const container = renderView({ members: [scheduled()] });
    const body = container.querySelector(".adminbot-time-availability__body")!;
    const report = body.querySelector(".adminbot-time-availability__report")!;
    const panel = body.querySelector('[data-testid="time-availability-deadlines"]')!;
    expect(report).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(panel.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers the milestone form only on your own schedule", () => {
    expect(
      renderView({ members: [scheduled()], activeCommitmentType: "milestone" }).querySelector(
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
      activeCommitmentType: "milestone",
      milestoneDraft: { ...EMPTY_MILESTONE_DRAFT, date: "2026-11-03", label: "Thesis draft" },
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
    const jinesisContainer = renderView({ activeCommitmentType: "jinesis" });
    const jinesis = jinesisContainer.querySelector('[data-testid="time-availability-editor"]')!;
    expect(jinesis).not.toBeNull();
    // The Jinesis form has no category picker at all -- its category is pinned.
    expect(jinesis.querySelector('[data-testid="time-away-category"]')).toBeNull();
    expect(jinesis.querySelector('[data-testid="time-availability-editor-submit"]')).not.toBeNull();

    const awayContainer = renderView({ activeCommitmentType: "away" });
    const away = awayContainer.querySelector('[data-testid="time-away-editor"]')!;
    expect(away).not.toBeNull();
    expect(away.querySelector('[data-testid="time-away-category"]')).not.toBeNull();
    expect(away.querySelector('[data-testid="time-away-editor-submit"]')).not.toBeNull();
  });

  // The away form's hint explains the action the submit button performs, so it sits in the same
  // actions row, left of the button, rather than under the fields.
  it("puts the time-away hint on the same row as its submit button", () => {
    const container = renderView({ activeCommitmentType: "away" });
    const away = container.querySelector('[data-testid="time-away-editor"]')!;
    const actions = away.querySelector(".adminbot-time-availability__form-actions")!;
    const hint = actions.querySelector(".adminbot-time-availability__form-hint");
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain("whole day off");
    expect(actions.querySelector('[data-testid="time-away-editor-submit"]')).not.toBeNull();
  });

  it("never offers Jinesis as a time-away category", () => {
    const options = [
      ...renderView({ activeCommitmentType: "away" })
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

  // The note follows the allocation into the chart, where the tooltip shows it under that task's
  // row. The tooltip itself is React inside the chart element, so what this asserts is that the
  // note is handed over rather than dropped at the boundary.
  it("carries the note through to the chart's tooltip as well", () => {
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
    const chart = container.querySelector("adminbot-effort-stack-chart") as unknown as {
      tasks: ReadonlyArray<{ name: string; note?: string }>;
    };
    expect(chart.tasks.some((task) => task.note === "Shared with Mei")).toBe(true);
  });

  it("hands whole-day time off to the chart even when there are no hour allocations", () => {
    const container = renderView({
      members: [
        member({
          availability: [],
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
    const chart = container.querySelector("adminbot-effort-stack-chart") as unknown as {
      tasks: readonly unknown[];
      awayRanges: ReadonlyArray<{ name: string; note?: string }>;
    };

    expect(chart).not.toBeNull();
    expect(chart.tasks).toEqual([]);
    expect(chart.awayRanges).toEqual([
      expect.objectContaining({ name: "Holiday", note: "Family, phone off" }),
    ]);
  });

  it("asks for a custom name only for the 'other' category", () => {
    expect(
      renderView({ activeCommitmentType: "away" }).querySelector(
        '[data-testid="time-availability-custom-label"]',
      ),
    ).toBeNull();
    expect(
      renderView({
        activeCommitmentType: "away",
        awayDraft: { ...EMPTY_TIME_AVAILABILITY_DRAFT, category: "other" },
      }).querySelector('[data-testid="time-availability-custom-label"]'),
    ).not.toBeNull();
  });
});

describe("the trips editor's place on the tab", () => {
  // Asked for by position, not just presence: "add a trip" is a sibling of "add a commitment" and
  // reads as one only if it sits in the same stack, after the deadline editor.
  it("shows the add-commitment button and the trips editor in the stack", () => {
    const view = renderView();
    // The add-commitment button should be visible when no type is selected
    expect(view.querySelector(".adminbot-time-availability__add-commitment")).not.toBeNull();
    // When a type is selected, the corresponding form should appear
    const jinesisView = renderView({ activeCommitmentType: "jinesis" });
    expect(jinesisView.querySelector('[data-testid="time-availability-editor"]')).not.toBeNull();
  });

  // Where somebody will be is the part of their schedule an admin opens this page for, so the
  // section stays; the form does not.
  it("shows an admin someone else's trips without a form to change them", () => {
    const view = renderView({
      viewerIsAdmin: true,
      viewerMemberId: "admin",
      members: [
        member({ id: "m1", trips: [{ start: "2026-09-01", end: "2026-09-30", city: "Berlin" }] }),
      ],
    });
    expect(view.querySelector('[data-testid="time-availability-trip-editor"]')).not.toBeNull();
    expect(view.querySelector('[data-testid="time-availability-trip-form"]')).toBeNull();
    // Admin viewing someone else cannot add commitments (not editable)
    expect(view.querySelector(".adminbot-time-availability__add-commitment")).toBeNull();
    expect(view.textContent).toContain("Berlin");
  });

  it("draws no editor stack at all for a reader with nothing to see", () => {
    const view = renderView({ viewerIsAdmin: true, viewerMemberId: "admin" });
    expect(view.querySelector(".adminbot-time-availability__editors")).toBeNull();
  });
});

describe("the where-strip under the chart", () => {
  const berlin = { start: "2026-09-01", end: "2026-09-30", city: "Berlin" };

  // The strip reads today's date through rangeBins, so the clock has to be driven: "which period
  // am I where" is a question about now, and a test that only passes in September is not a test.
  afterEach(() => {
    vi.useRealTimers();
  });

  function renderOn(
    day: string,
    overrides: Partial<AdminBotLabMember> = { trips: [berlin] },
  ): HTMLElement {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${day}T12:00:00Z`));
    return renderView({
      range: "year",
      members: [member({ id: "m1", location: "Toronto", ...overrides })],
    });
  }

  it("names a city per period, at the granularity the range switch chose", () => {
    const cells = [...renderOn("2026-09-15").querySelectorAll(".adminbot-where-strip__cell")].map(
      (cell) => cell.textContent?.replace(/\s+/gu, " ").trim(),
    );
    // "year" is twelve monthly bins, anchored to the start of this month.
    expect(cells).toHaveLength(12);
    expect(cells[0]).toContain("Berlin");
    // Once the trip is over, the strip falls back to where they live.
    expect(cells[1]).toContain("Toronto");
  });

  // The whole point: a period that is not all one place says which stretch was where, in a real
  // element rather than a native title that a pointer often never triggers.
  it("spells out from when to when, in which city", () => {
    const view = renderOn("2026-09-15", {
      trips: [{ start: "2026-09-20", end: "2026-09-24", city: "Vancouver" }],
    });
    const first = view.querySelector(".adminbot-where-strip__cell");
    const rows = [...(first?.querySelectorAll(".adminbot-where-strip__detail-row") ?? [])].map(
      (row) => row.textContent?.replace(/\s+/gu, " ").trim(),
    );
    expect(rows).toEqual([
      "Sep 1 – Sep 19 Toronto",
      "Sep 20 – Sep 24 Vancouver",
      "Sep 25 – Sep 30 Toronto",
    ]);
    // The cell itself names the place most of the period is spent, plus how much it is not saying.
    expect(first?.textContent).toContain("Toronto");
    expect(first?.textContent).toContain("+2");
  });

  // The breakdown is what the "+2" points at, so it has to be reachable without a pointer.
  it("puts the breakdown in the tab order and marks it as a tooltip", () => {
    const first = renderOn("2026-09-15").querySelector(".adminbot-where-strip__cell");
    expect(first?.getAttribute("tabindex")).toBe("0");
    expect(first?.querySelector('[role="tooltip"]')).not.toBeNull();
    // No native title: it is what gave a help cursor and then nothing.
    expect(first?.hasAttribute("title")).toBe(false);
  });

  it("still names the place for a period spent in one city, without a count", () => {
    const first = renderOn("2026-09-15").querySelector(".adminbot-where-strip__cell");
    expect(
      first?.querySelector(".adminbot-where-strip__detail")?.textContent?.replace(/\s+/gu, " "),
    ).toContain("Berlin");
    expect(first?.querySelector(".adminbot-where-strip__more")).toBeNull();
  });

  // Away is what the strip is for; a wall of the member's own city would bury it.
  it("distinguishes away periods from home ones", () => {
    const view = renderOn("2026-09-15");
    expect(view.querySelectorAll(".adminbot-where-strip__cell--away")).toHaveLength(1);
  });

  // The bug this caught: a five-day conference makes no month majority-away, so a guard that asked
  // only about the cell's own city hid the strip for exactly the case the hover explains.
  it("still draws the strip for travel too short to dominate any period", () => {
    const view = renderOn("2026-09-15", {
      trips: [{ start: "2026-09-20", end: "2026-09-24", city: "Vancouver" }],
    });
    expect(view.querySelector('[data-testid="time-availability-where-strip"]')).not.toBeNull();
  });

  it("draws no strip at all for a member who is home the whole horizon", () => {
    expect(
      renderOn("2026-09-15", { trips: [] }).querySelector(
        '[data-testid="time-availability-where-strip"]',
      ),
    ).toBeNull();
  });
});

describe("the big-deadlines panel", () => {
  // Its own fixture: the one in "the split tables and the deadline panel" is scoped to that block.
  const scheduled = (overrides: Partial<AdminBotLabMember> = {}) =>
    member({ milestones: [{ date: "2027-06-12", label: "Graduation" }], ...overrides });

  it("offers workshops as well as conferences", () => {
    const picker = renderView({ members: [scheduled()] }).querySelector<HTMLSelectElement>(
      '[data-testid="time-availability-deadline-pick"]',
    )!;
    const offered = [...picker.options].map((option) => option.value);
    expect(offered.length).toBeGreaterThan(0);
    const offeredEntries = allUpcomingVenues(Date.now()).filter((entry) =>
      offered.includes(entry.venue.deadline_id),
    );
    expect(offeredEntries.some((entry) => entry.venue.entry_type === "workshop")).toBe(true);
    expect(offeredEntries.some((entry) => entry.venue.entry_type !== "workshop")).toBe(true);
  });

  it("does not offer a deadline already linked to the timeline", () => {
    const deadline = allUpcomingVenues(Date.now()).find(
      (entry) => entry.venue.entry_type === "workshop",
    )!;
    const picker = renderView({
      members: [
        scheduled({
          milestones: [
            {
              deadline_id: deadline.venue.deadline_id,
              date: "2000-01-01",
              label: "An intentionally stale copy",
            },
          ],
        }),
      ],
    }).querySelector<HTMLSelectElement>('[data-testid="time-availability-deadline-pick"]')!;

    expect([...picker.options].map((option) => option.value)).not.toContain(
      deadline.venue.deadline_id,
    );
  });

  // A disclosure now, not an open form: the panel is a banner about what is coming, and the editor
  // was more than half its height. Everything it held is still one click away.
  it("keeps the picker shut until it is asked for", () => {
    const view = renderView({ members: [scheduled()] });
    const section = view.querySelector('[data-testid="time-availability-add-deadline-section"]');
    expect(section?.tagName).toBe("DETAILS");
    expect((section as HTMLDetailsElement | null)?.open).toBe(false);
    expect(
      section?.querySelector(".adminbot-time-availability__deadline-add-summary")?.textContent,
    ).toContain("Add a deadline");
    // Shut, not absent: the form is in the DOM and opens without a round trip.
    expect(section?.querySelector("button.primary")).not.toBeNull();
    // Deliberately not classed as an editor: it lives in the deadlines panel, and the commitment
    // form is found by .adminbot-time-availability__form.
    expect(section?.classList.contains("adminbot-time-availability__editor")).toBe(false);
    expect(section?.querySelector(".adminbot-time-availability__form")).toBeNull();
  });

  // The lab's four are context, not an instruction. Somebody not submitting to NeurIPS should be
  // able to clear it off their own page without touching anyone else's.
  it("lets a member hide one of the lab's preset conferences", () => {
    const onSaveSchedule = vi.fn();
    const view = renderView({ members: [scheduled()], onSaveSchedule });
    view
      .querySelector<HTMLButtonElement>('[data-testid="time-availability-deadline-remove-preset"]')
      ?.click();
    expect(onSaveSchedule).toHaveBeenCalledTimes(1);
    const [, patch] = onSaveSchedule.mock.calls[0];
    expect(patch.dismissed_deadlines).toHaveLength(1);
    // Written as the venue name, which is also how an added venue is stored, so one identity
    // covers both directions.
    const nearest = upcomingMajorDeadlines(Date.now(), 4, { archivalOnly: true })[0];
    expect(patch.dismissed_deadlines[0]).toBe(nearest?.venue.name);
  });

  it("drops a hidden conference from the panel and offers it back in the picker", () => {
    const nearest = upcomingMajorDeadlines(Date.now(), 4, { archivalOnly: true })[0];
    const view = renderView({
      members: [scheduled({ dismissed_deadlines: [nearest?.venue.name ?? ""] })],
    });
    // The list, not the whole panel: the picker below it is inside the same aside, and offering
    // the venue back there is the other half of what this test is checking.
    const listed = view.querySelector(".adminbot-time-availability__deadline-list")?.textContent;
    expect(listed).not.toContain(nearest?.venue.name);
    const offered = [
      ...view.querySelectorAll<HTMLOptionElement>(
        '[data-testid="time-availability-deadline-pick"] option',
      ),
    ].map((option) => option.value);
    expect(offered).toContain(nearest?.venue.deadline_id);
  });

  // The bug this pins: the link and the remove button were both placed in the same grid cell, so
  // they drew on top of each other, and the AoE cutoff was held on one line inside a narrow tile
  // and clipped at its border.
  it("gives each part of a deadline tile its own place", () => {
    const tile = renderView({ members: [scheduled()] }).querySelector(
      ".adminbot-time-availability__deadline-list li",
    );
    const actions = tile?.querySelector(".adminbot-time-availability__deadline-actions");
    // The link and the button are siblings in the actions row, not two things in one cell.
    expect(actions?.querySelector("a")).not.toBeNull();
    expect(actions?.querySelector("button")).not.toBeNull();
    // The date and its cutoff sit together, below the name.
    const when = tile?.querySelector(".adminbot-time-availability__deadline-when");
    expect(when?.querySelector(".adminbot-time-availability__deadline-date")).not.toBeNull();
    expect(when?.querySelector(".adminbot-time-availability__deadline-clock")).not.toBeNull();
    expect(tile?.querySelector(".adminbot-time-availability__deadline-label")).not.toBeNull();
  });

  it("keeps the hide button off a schedule the viewer cannot edit", () => {
    expect(
      renderView({ members: [scheduled()], viewerMemberId: "someone-else" }).querySelector(
        '[data-testid="time-availability-deadline-remove-preset"]',
      ),
    ).toBeNull();
  });

  it("removes a linked row by deadline id while keeping a matching personal row", () => {
    const deadline = allUpcomingVenues(Date.now())[0]!;
    const linked = {
      deadline_id: deadline.venue.deadline_id,
      date: deadline.venue.deadline_aoe.slice(0, 10),
      label: deadline.venue.name,
      time: deadline.venue.deadline_aoe.slice(11, 16),
      timezone: "Etc/GMT+12",
    };
    const personal = { date: linked.date, label: linked.label };
    const onSaveSchedule = vi.fn();
    const view = renderView({
      members: [scheduled({ milestones: [linked, personal] })],
      onSaveSchedule,
    });
    view
      .querySelector<HTMLButtonElement>('[data-testid="time-availability-deadline-remove-own"]')
      ?.click();

    const [, patch] = onSaveSchedule.mock.calls[0];
    expect(patch.milestones).toEqual([personal]);
  });

  it("keeps an AoE milestone visible after its displayed date has rolled over in UTC", () => {
    const deadline = allUpcomingVenues(Date.now())[0]!;
    const cutoff = aoeInstantMs(deadline.venue.deadline_aoe);
    vi.useFakeTimers();
    vi.setSystemTime(cutoff - 60 * 60 * 1000);
    try {
      const view = renderView({
        members: [
          scheduled({
            milestones: [
              {
                deadline_id: deadline.venue.deadline_id,
                date: deadline.venue.deadline_aoe.slice(0, 10),
                label: deadline.venue.name,
                time: deadline.venue.deadline_aoe.slice(11, 16),
                timezone: "Etc/GMT+12",
              },
            ],
          }),
        ],
      });
      expect(view.textContent).toContain(deadline.venue.name);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── the tables follow the chart ─────────────────────────────────────────────────────────────
//
// The chart pages through time and the tables are the same schedule in words, so they answer for
// the same span. What is finished drops out of the list until the pager reaches it again.

describe("commitments follow the chart's window", () => {
  const spanning = () =>
    member({
      availability: [
        { start: "2025-09-01", end: "2025-12-15", project: "Last term", hours_per_week: 10 },
        { start: "2026-03-01", end: "2026-06-30", project: "This term", hours_per_week: 20 },
      ],
      time_off: [{ start: "2025-10-01", end: "2025-10-08", kind: "vacation" }],
    } as Partial<AdminBotLabMember>);

  const window = { start: "2026-03-01", end: "2026-04-12" };

  it("lists only what the window covers", () => {
    const container = renderView({ members: [spanning()], chartWindow: window });
    const table = container.querySelector('[data-testid="time-availability-jinesis-table"]');
    expect(table?.textContent).toContain("This term");
    expect(table?.textContent).not.toContain("Last term");
  });

  // Never a silent gap: a row that is filtered out is counted where it would have been.
  it("says how many rows the window is hiding", () => {
    const container = renderView({ members: [spanning()], chartWindow: window });
    const note = container.querySelector('[data-testid="time-availability-hidden"]');
    expect(note?.textContent).toContain("1");
  });

  it("brings the finished ones back when the pager reaches them", () => {
    const container = renderView({
      members: [spanning()],
      chartWindow: { start: "2025-09-01", end: "2025-10-13" },
    });
    const table = container.querySelector('[data-testid="time-availability-jinesis-table"]');
    expect(table?.textContent).toContain("Last term");
    expect(table?.textContent).not.toContain("This term");
  });

  // Before the chart has reported a window there is nothing to filter against, and hiding rows on
  // that first frame would be a flash of a shorter list.
  it("shows everything until the chart says what it is drawing", () => {
    const container = renderView({ members: [spanning()], chartWindow: null });
    const table = container.querySelector('[data-testid="time-availability-jinesis-table"]');
    expect(table?.textContent).toContain("This term");
    expect(table?.textContent).toContain("Last term");
  });
});

describe("withinWindow", () => {
  const window = { start: "2026-03-01", end: "2026-04-01" };

  it("keeps a commitment that straddles the window's start", () => {
    expect(withinWindow({ start: "2026-01-01", end: "2026-03-10" }, window)).toBe(true);
  });

  it("keeps one that runs past the end", () => {
    expect(withinWindow({ start: "2026-03-20", end: "2026-09-01" }, window)).toBe(true);
  });

  it("drops one that finished before it opens", () => {
    expect(withinWindow({ start: "2026-01-01", end: "2026-02-28" }, window)).toBe(false);
  });

  // The window's end is exclusive: a commitment starting on it belongs to the next page.
  it("drops one that starts on the exclusive end", () => {
    expect(withinWindow({ start: "2026-04-01", end: "2026-04-30" }, window)).toBe(false);
  });
});

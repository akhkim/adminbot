import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { AdminBotLabMember } from "../controllers/adminbot.ts";
import {
  renderAdminBotTimeAvailability,
  type AdminBotTimeAvailabilityProps,
} from "./adminbot-time-availability.ts";

function member(
  id: string,
  name: string,
  workload: Pick<AdminBotLabMember, "hours_per_week" | "availability"> = {},
): AdminBotLabMember {
  return {
    id,
    name,
    ...workload,
    privilege_level: "admin",
    access: [],
    created_at: "2026-08-05T00:00:00.000Z",
    updated_at: "2026-08-05T00:00:00.000Z",
  };
}

const members = [
  member("mem_ded86fcd", "Local Dev Admin", {
    hours_per_week: 40,
    availability: [
      { project: "task1", start: "2026-05-08", end: "2026-05-11", hours_per_week: 20 },
      { project: "task2", start: "2026-05-09", end: "2026-05-12", hours_per_week: 12 },
    ],
  }),
  member("mem_19f9c11f", "Local Dev Admin 2", {
    hours_per_week: 40,
    availability: [
      { project: "task1", start: "2026-05-13", end: "2026-05-17", hours_per_week: 24 },
      { project: "task2", start: "2026-05-14", end: "2026-05-19", hours_per_week: 16 },
    ],
  }),
];

function renderView(overrides: Partial<AdminBotTimeAvailabilityProps> = {}): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderAdminBotTimeAvailability({
      members,
      loading: false,
      error: null,
      selectedMemberId: "",
      signedInMemberId: null,
      viewInterval: "day",
      onMemberChange: () => undefined,
      onViewIntervalChange: () => undefined,
      onAvailabilityChange: () => undefined,
      ...overrides,
    }),
    container,
  );
  return container;
}

function chartDateLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".recharts-cartesian-axis-tick-value")]
    .map((item) => item.textContent?.trim() ?? "")
    .filter((label) => /^[A-Z][a-z]{2} \d{1,2}$/u.test(label));
}

function chartBucketLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".recharts-cartesian-axis-tick-value")]
    .slice(0, 7)
    .map((item) => item.textContent?.trim() ?? "");
}

describe("renderAdminBotTimeAvailability", () => {
  beforeEach(async () => {
    document.body.replaceChildren();
    await i18n.setLocale("en");
  });

  it("renders the saved users in the selector", () => {
    const container = renderView();

    expect(container.querySelector(".card-title")?.textContent).toBe("Time Avaliability:");
    expect(
      [
        ...container.querySelectorAll<HTMLOptionElement>('select[aria-label="Select user"] option'),
      ].map((option) => ({
        label: option.textContent,
        value: option.value,
      })),
    ).toEqual([
      { label: "Select user", value: "" },
      { label: "Local Dev Admin", value: "mem_ded86fcd" },
      { label: "Local Dev Admin 2", value: "mem_19f9c11f" },
    ]);
  });

  it("renders the view interval selector and reports interval changes", () => {
    const onViewIntervalChange = vi.fn();
    const container = renderView({ onViewIntervalChange });
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="View Interval"]',
    )!;

    expect(select.value).toBe("day");
    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
      ["day", "Daily"],
      ["week", "Weekly"],
      ["month", "Monthly"],
    ]);

    select.value = "week";
    select.dispatchEvent(new Event("change"));

    expect(onViewIntervalChange).toHaveBeenCalledWith("week");
  });

  it("uses time-weighted weekly averages and records daily capacity details", () => {
    const weeklyMember = member("mem_weekly", "Weekly Allocation", {
      hours_per_week: 40,
      availability: [
        {
          id: "steady",
          project: "Steady",
          start: "2026-05-04",
          end: "2026-05-10",
          hours_per_week: 24,
        },
        {
          id: "burst",
          project: "Burst",
          start: "2026-05-06",
          end: "2026-05-08",
          hours_per_week: 14,
        },
      ],
    });
    const container = renderView({
      members: [weeklyMember],
      selectedMemberId: weeklyMember.id,
      viewInterval: "week",
    });

    expect(chartBucketLabels(container)).toEqual([
      "May 4–May 10",
      "May 11–May 17",
      "May 18–May 24",
      "May 25–May 31",
      "Jun 1–Jun 7",
      "Jun 8–Jun 14",
      "Jun 15–Jun 21",
    ]);
    expect(container.querySelector(".adminbot-time-chart__total")?.textContent?.trim()).toBe("75%");
    expect(container.querySelector(".adminbot-time-chart__summary")?.textContent).toContain(
      "Peak daily allocation 95%. Active days 7 of 7. Days over 100%: 0. Days near capacity: 3.",
    );
  });

  it("weights monthly averages by the month's actual day count", () => {
    const monthlyMember = member("mem_monthly", "Monthly Allocation", {
      hours_per_week: 40,
      availability: [
        {
          id: "one-day",
          project: "One day",
          start: "2026-02-01",
          end: "2026-02-01",
          hours_per_week: 40,
        },
      ],
    });
    const container = renderView({
      members: [monthlyMember],
      selectedMemberId: monthlyMember.id,
      viewInterval: "month",
    });

    expect(chartBucketLabels(container)).toEqual([
      "Feb 2026",
      "Mar 2026",
      "Apr 2026",
      "May 2026",
      "Jun 2026",
      "Jul 2026",
      "Aug 2026",
    ]);
    expect(container.querySelector(".adminbot-time-chart__total")?.textContent?.trim()).toBe(
      "3.6%",
    );
    expect(container.querySelector(".adminbot-time-chart__summary")?.textContent).toContain(
      "Active days 1 of 28.",
    );
  });

  it("renders the selected user's saved allocations as a stacked chart and task table", () => {
    const container = renderView({ selectedMemberId: "mem_ded86fcd" });

    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Time allocation chart for Local Dev Admin",
    );
    expect(
      [...container.querySelectorAll(".recharts-legend-item-text")].map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["task1", "task2"]);
    expect(
      container.querySelectorAll(".recharts-bar-rectangle .adminbot-time-chart__segment"),
    ).toHaveLength(8);
    expect(
      [...container.querySelectorAll(".adminbot-time-chart__total")].map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["50%", "80%", "80%", "80%", "30%"]);
    expect(chartDateLabels(container)).toEqual([
      "May 8",
      "May 9",
      "May 10",
      "May 11",
      "May 12",
      "May 13",
      "May 14",
    ]);
    expect(container.querySelector(".adminbot-time-chart__summary")?.textContent).toContain(
      "total 80%",
    );
    expect(
      [...container.querySelectorAll(".adminbot-time-allocation-table tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim()),
      ),
    ).toEqual([
      ["task1", "05/08/2026", "05/11/2026", "50%"],
      ["task2", "05/09/2026", "05/12/2026", "30%"],
    ]);
  });

  it("pages the chart backward and forward in fixed seven-day windows", async () => {
    const container = renderView({ selectedMemberId: "mem_ded86fcd" });
    const previous = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show previous 7 days"]',
    )!;
    const next = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show next 7 days"]',
    )!;

    expect(previous).not.toBeNull();
    expect(next).not.toBeNull();
    expect(previous.hasAttribute("data-tooltip")).toBe(false);
    expect(next.hasAttribute("data-tooltip")).toBe(false);
    expect(next.hasAttribute("title")).toBe(false);
    next.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await vi.waitFor(() => {
      const tooltip = document.body.querySelector(".adminbot-time-chart__page-tooltip");
      expect(tooltip?.textContent).toBe("Next 7 days");
      expect(tooltip?.parentElement).toBe(document.body);
    });
    next.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));

    next.click();
    await vi.waitFor(() => {
      expect(chartDateLabels(container)).toEqual([
        "May 15",
        "May 16",
        "May 17",
        "May 18",
        "May 19",
        "May 20",
        "May 21",
      ]);
    });

    previous.click();
    await vi.waitFor(() => {
      expect(chartDateLabels(container)).toEqual([
        "May 8",
        "May 9",
        "May 10",
        "May 11",
        "May 12",
        "May 13",
        "May 14",
      ]);
    });
  });

  it("reads distinct saved allocations for the second user", () => {
    const container = renderView({ selectedMemberId: "mem_19f9c11f" });
    const efforts = [
      ...container.querySelectorAll(".adminbot-time-allocation-table tbody td:last-child"),
    ].map((cell) => cell.textContent?.trim());

    expect(efforts).toEqual(["60%", "40%"]);
  });

  it("uses a saved custom colour in both the chart and task list", () => {
    const coloredMember = member("mem_colored", "Colored Schedule", {
      hours_per_week: 40,
      availability: [
        {
          project: "custom task",
          start: "2026-05-08",
          end: "2026-05-12",
          hours_per_week: 20,
          color: "#abcdef",
        },
      ],
    });
    const container = renderView({
      members: [coloredMember],
      selectedMemberId: coloredMember.id,
    });

    expect(
      container.querySelector(".adminbot-time-allocation-table__task")?.getAttribute("style"),
    ).toContain("#ABCDEF");
    expect(container.querySelector(".recharts-bar-rectangle path")?.getAttribute("fill")).toBe(
      "#ABCDEF",
    );
  });

  it("keeps colours independent for tasks with the same name", () => {
    const duplicateMember = member("mem_duplicates", "Duplicate Tasks", {
      hours_per_week: 40,
      availability: [
        {
          id: "task-one",
          project: "Research",
          start: "2026-05-08",
          end: "2026-05-12",
          hours_per_week: 20,
          color: "#3575DA",
        },
        {
          id: "task-two",
          project: "Research",
          start: "2026-05-08",
          end: "2026-05-12",
          hours_per_week: 10,
          color: "#F6511D",
        },
      ],
    });
    const onAvailabilityChange = vi.fn();
    const container = renderView({
      members: [duplicateMember],
      selectedMemberId: duplicateMember.id,
      signedInMemberId: duplicateMember.id,
      onAvailabilityChange,
    });
    const triggers = [
      ...container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Change colour for Research"]',
      ),
    ];

    expect(triggers).toHaveLength(2);
    expect(triggers[0]?.querySelector("i")?.getAttribute("style")).toContain("#3575DA");
    expect(triggers[1]?.querySelector("i")?.getAttribute("style")).toContain("#F6511D");

    triggers[0]?.click();
    triggers[0]
      ?.closest(".adminbot-time-allocation-table__color-picker")
      ?.querySelector<HTMLButtonElement>('button[data-color="#188B3E"]')
      ?.click();

    expect(onAvailabilityChange).toHaveBeenCalledWith(duplicateMember.id, [
      {
        id: "task-one",
        project: "Research",
        start: "2026-05-08",
        end: "2026-05-12",
        hours_per_week: 20,
        color: "#188B3E",
      },
      {
        id: "task-two",
        project: "Research",
        start: "2026-05-08",
        end: "2026-05-12",
        hours_per_week: 10,
        color: "#F6511D",
      },
    ]);
  });

  it("adds a task to the signed-in user's saved availability", () => {
    const onAvailabilityChange = vi.fn();
    const container = renderView({
      selectedMemberId: "mem_ded86fcd",
      signedInMemberId: "mem_ded86fcd",
      onAvailabilityChange,
    });

    container.querySelector<HTMLButtonElement>(".adminbot-time-allocation-table__add")?.click();

    expect(onAvailabilityChange).toHaveBeenCalledWith("mem_ded86fcd", [
      { project: "task1", start: "2026-05-08", end: "2026-05-11", hours_per_week: 20 },
      { project: "task2", start: "2026-05-09", end: "2026-05-12", hours_per_week: 12 },
      {
        id: expect.any(String),
        project: "New task",
        start: "2026-05-08",
        end: "2026-05-11",
        hours_per_week: 4,
      },
    ]);
  });

  it("opens a six-colour picker and saves a default colour", () => {
    const onAvailabilityChange = vi.fn();
    const container = renderView({
      selectedMemberId: "mem_ded86fcd",
      signedInMemberId: "mem_ded86fcd",
      onAvailabilityChange,
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change colour for task1"]',
    )!;
    const panel = trigger
      .closest(".adminbot-time-allocation-table__color-picker")
      ?.querySelector<HTMLElement>(".adminbot-time-allocation-table__color-panel")!;

    trigger.click();

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    expect(panel.querySelectorAll(".adminbot-time-allocation-table__color-option")).toHaveLength(6);
    expect(panel.querySelector('input[aria-label="Custom colour for task1"]')).not.toBeNull();

    panel.querySelector<HTMLButtonElement>('button[data-color="#F6511D"]')?.click();

    expect(onAvailabilityChange).toHaveBeenCalledWith("mem_ded86fcd", [
      {
        id: "legacy:mem_ded86fcd:0",
        project: "task1",
        start: "2026-05-08",
        end: "2026-05-11",
        hours_per_week: 20,
        color: "#F6511D",
      },
      { project: "task2", start: "2026-05-09", end: "2026-05-12", hours_per_week: 12 },
    ]);
    expect(panel.hidden).toBe(true);
  });

  it("normalizes a custom hex colour and rejects invalid colour codes", () => {
    const onAvailabilityChange = vi.fn();
    const container = renderView({
      selectedMemberId: "mem_ded86fcd",
      signedInMemberId: "mem_ded86fcd",
      onAvailabilityChange,
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change colour for task1"]',
    )!;
    trigger.click();
    const form = trigger
      .closest(".adminbot-time-allocation-table__color-picker")
      ?.querySelector<HTMLFormElement>(".adminbot-time-allocation-table__color-panel")!;
    const input = form.querySelector<HTMLInputElement>(
      'input[aria-label="Custom colour for task1"]',
    )!;

    input.value = "not-a-colour";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(input.validationMessage).toBe("Enter a hex colour such as #3575DA.");
    expect(onAvailabilityChange).not.toHaveBeenCalled();

    input.value = "0f80c1";
    input.dispatchEvent(new Event("input"));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(onAvailabilityChange).toHaveBeenCalledWith("mem_ded86fcd", [
      {
        id: "legacy:mem_ded86fcd:0",
        project: "task1",
        start: "2026-05-08",
        end: "2026-05-11",
        hours_per_week: 20,
        color: "#0F80C1",
      },
      { project: "task2", start: "2026-05-09", end: "2026-05-12", hours_per_week: 12 },
    ]);
  });

  it("saves task edits against the signed-in user's source row", () => {
    const onAvailabilityChange = vi.fn();
    const container = renderView({
      selectedMemberId: "mem_ded86fcd",
      signedInMemberId: "mem_ded86fcd",
      onAvailabilityChange,
    });
    const taskName = container.querySelector<HTMLInputElement>(
      'input[aria-label="Task name for task1"]',
    )!;

    taskName.value = "Renamed task";
    taskName.dispatchEvent(new Event("change"));

    expect(onAvailabilityChange).toHaveBeenCalledWith("mem_ded86fcd", [
      {
        id: "legacy:mem_ded86fcd:0",
        project: "Renamed task",
        start: "2026-05-08",
        end: "2026-05-11",
        hours_per_week: 20,
      },
      { project: "task2", start: "2026-05-09", end: "2026-05-12", hours_per_week: 12 },
    ]);
  });

  it("highlights an invalid date range and blocks saving until it is valid", () => {
    const onAvailabilityChange = vi.fn();
    const container = renderView({
      selectedMemberId: "mem_ded86fcd",
      signedInMemberId: "mem_ded86fcd",
      onAvailabilityChange,
    });
    const start = container.querySelector<HTMLInputElement>(
      'input[aria-label="Start date for task1"]',
    )!;
    const end = container.querySelector<HTMLInputElement>(
      'input[aria-label="End date for task1"]',
    )!;
    const row = start.closest("tr")!;

    start.value = "2026-05-13";
    start.dispatchEvent(new Event("input"));
    start.dispatchEvent(new Event("change"));

    expect(row.classList.contains("adminbot-time-allocation-table__row--invalid")).toBe(true);
    expect(start.getAttribute("aria-invalid")).toBe("true");
    expect(end.getAttribute("aria-invalid")).toBe("true");
    expect(start.validationMessage).toBe("Start date must be on or before end date.");
    expect(onAvailabilityChange).not.toHaveBeenCalled();

    end.value = "2026-05-14";
    end.dispatchEvent(new Event("input"));
    end.dispatchEvent(new Event("change"));

    expect(row.classList.contains("adminbot-time-allocation-table__row--invalid")).toBe(false);
    expect(onAvailabilityChange).toHaveBeenCalledWith("mem_ded86fcd", [
      {
        id: "legacy:mem_ded86fcd:0",
        project: "task1",
        start: "2026-05-13",
        end: "2026-05-14",
        hours_per_week: 20,
      },
      { project: "task2", start: "2026-05-09", end: "2026-05-12", hours_per_week: 12 },
    ]);
  });

  it("does not offer task editing for a different selected user", () => {
    const container = renderView({
      selectedMemberId: "mem_19f9c11f",
      signedInMemberId: "mem_ded86fcd",
    });

    expect(container.querySelector(".adminbot-time-allocation-table__add")).toBeNull();
    expect(container.querySelector(".adminbot-time-allocation-table__input")).toBeNull();
  });

  it("shows an empty chart and lets a taskless user add their first task", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-06T12:00:00Z"));
    try {
      const emptyMember = member("mem_empty", "No Schedule");
      const onAvailabilityChange = vi.fn();
      const container = renderView({
        members: [emptyMember],
        selectedMemberId: emptyMember.id,
        signedInMemberId: emptyMember.id,
        onAvailabilityChange,
      });

      expect(container.querySelector(".adminbot-time-chart-wrap")).not.toBeNull();
      expect(container.querySelector(".adminbot-time-allocation-table")).not.toBeNull();
      container.querySelector<HTMLButtonElement>(".adminbot-time-allocation-table__add")?.click();

      expect(onAvailabilityChange).toHaveBeenCalledWith(
        emptyMember.id,
        [
          {
            id: expect.any(String),
            project: "New task",
            start: "2026-08-06",
            end: "2026-08-12",
            hours_per_week: 4,
          },
        ],
        40,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not invent allocations for a user without saved availability", () => {
    const emptyMember = member("mem_empty", "No Schedule", { hours_per_week: 40 });
    const container = renderView({
      members: [emptyMember],
      selectedMemberId: emptyMember.id,
    });

    expect(container.querySelector(".recharts-surface")).toBeNull();
    expect(container.querySelector(".adminbot-time-chart-wrap")).not.toBeNull();
    expect(container.querySelector(".adminbot-time-allocation-table")).not.toBeNull();
    expect(container.textContent).toContain("This user has no saved time allocations.");
  });

  it("treats zero-hour rows as no allocations when weekly capacity is saved", () => {
    const zeroMember = member("mem_zero", "Zero Hours", {
      hours_per_week: 40,
      availability: [
        { project: "paused task", start: "2026-05-08", end: "2026-05-12", hours_per_week: 0 },
      ],
    });
    const container = renderView({
      members: [zeroMember],
      selectedMemberId: zeroMember.id,
    });

    expect(container.textContent).toContain("This user has no saved time allocations.");
    expect(container.textContent).not.toContain("Set this user's weekly capacity");
  });

  it("does not stack declared open capacity as task effort", () => {
    const openMember = member("mem_open", "Open Capacity", {
      hours_per_week: 40,
      availability: [
        { project: "task1", start: "2026-05-08", end: "2026-05-12", hours_per_week: 20 },
        { project: "__open__", start: "2026-05-08", end: "2026-05-12", hours_per_week: 20 },
      ],
    });
    const container = renderView({
      members: [openMember],
      selectedMemberId: openMember.id,
    });

    expect(container.querySelectorAll(".adminbot-time-allocation-table tbody tr")).toHaveLength(1);
    expect(container.querySelector(".adminbot-time-chart__total")?.textContent?.trim()).toBe("50%");
  });

  it("keeps a project named Term baseline distinct from the unlabeled baseline", () => {
    const baselineMember = member("mem_baseline", "Baseline Names", {
      hours_per_week: 40,
      availability: [
        { start: "2026-05-08", end: "2026-05-12", hours_per_week: 10 },
        {
          project: "Term baseline",
          start: "2026-05-08",
          end: "2026-05-12",
          hours_per_week: 10,
        },
      ],
    });
    const container = renderView({
      members: [baselineMember],
      selectedMemberId: baselineMember.id,
    });

    expect(
      container.querySelectorAll(".recharts-bar-rectangle .adminbot-time-chart__segment"),
    ).toHaveLength(10);
    expect(container.querySelector(".adminbot-time-chart__total")?.textContent?.trim()).toBe("50%");
  });

  it("does not request capacity for an open-capacity-only schedule", () => {
    const openOnlyMember = member("mem_open_only", "Open Only", {
      availability: [
        { project: "__open__", start: "2026-05-08", end: "2026-05-12", hours_per_week: 20 },
      ],
    });
    const container = renderView({
      members: [openOnlyMember],
      selectedMemberId: openOnlyMember.id,
    });

    expect(container.textContent).toContain("This user has no saved time allocations.");
    expect(container.textContent).not.toContain("Set this user's weekly capacity");
  });

  it("rounds only displayed percentages and does not falsely report over-capacity", () => {
    const preciseMember = member("mem_precise", "Precise Capacity", {
      hours_per_week: 6,
      availability: Array.from({ length: 6 }, (_, index) => ({
        project: `task${index + 1}`,
        start: "2026-05-08",
        end: "2026-05-12",
        hours_per_week: 1,
      })),
    });
    const container = renderView({
      members: [preciseMember],
      selectedMemberId: preciseMember.id,
    });
    const total = container.querySelector(".adminbot-time-chart__total");

    expect(total?.textContent?.trim()).toBe("100%");
    expect(total?.classList.contains("adminbot-time-chart__total--over")).toBe(false);
  });

  it("builds one daily total for every allocated day in the visible week", () => {
    const container = renderView({ selectedMemberId: "mem_ded86fcd" });

    expect(container.querySelectorAll(".adminbot-time-chart__total")).toHaveLength(5);
    expect(chartDateLabels(container)).toHaveLength(7);
    expect(container.textContent).not.toContain("Temporary preview data");
  });

  it("reports user selection changes", () => {
    const onMemberChange = vi.fn();
    const container = renderView({
      selectedMemberId: "mem_ded86fcd",
      onMemberChange,
    });
    const select = container.querySelector<HTMLSelectElement>("select")!;

    select.value = "mem_19f9c11f";
    select.dispatchEvent(new Event("change"));

    expect(onMemberChange).toHaveBeenCalledWith("mem_19f9c11f");
  });
});

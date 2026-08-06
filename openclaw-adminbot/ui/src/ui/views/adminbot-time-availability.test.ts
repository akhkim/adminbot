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
  render(
    renderAdminBotTimeAvailability({
      members,
      loading: false,
      error: null,
      selectedMemberId: "",
      onMemberChange: () => undefined,
      ...overrides,
    }),
    container,
  );
  return container;
}

describe("renderAdminBotTimeAvailability", () => {
  beforeEach(async () => {
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

  it("renders the selected user's saved allocations as a stacked chart and task table", () => {
    const container = renderView({ selectedMemberId: "mem_ded86fcd" });

    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "Time allocation chart for Local Dev Admin",
    );
    expect(
      [...container.querySelectorAll(".adminbot-time-chart__legend span")].map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["task1", "task2"]);
    expect(container.querySelectorAll(".adminbot-time-chart__segment")).toHaveLength(4);
    expect(
      [...container.querySelectorAll(".adminbot-time-chart__total")].map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["50%", "80%", "30%"]);
    expect(
      [...container.querySelectorAll(".adminbot-time-chart__axis-label--timeline")].map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["May 8 → May 9", "May 9 → May 12", "May 12 → May 13"]);
    expect(container.querySelector("desc")?.textContent).toContain("total 80%");
    expect(
      [...container.querySelectorAll(".adminbot-time-allocation-table tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim()),
      ),
    ).toEqual([
      ["task1", "05/08/2026", "05/11/2026", "50%"],
      ["task2", "05/09/2026", "05/12/2026", "30%"],
    ]);
  });

  it("reads distinct saved allocations for the second user", () => {
    const container = renderView({ selectedMemberId: "mem_19f9c11f" });
    const efforts = [
      ...container.querySelectorAll(".adminbot-time-allocation-table tbody td:last-child"),
    ].map((cell) => cell.textContent?.trim());

    expect(efforts).toEqual(["60%", "40%"]);
  });

  it("does not invent allocations for a user without saved availability", () => {
    const emptyMember = member("mem_empty", "No Schedule", { hours_per_week: 40 });
    const container = renderView({
      members: [emptyMember],
      selectedMemberId: emptyMember.id,
    });

    expect(container.querySelector("svg")).toBeNull();
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

    expect(container.querySelectorAll(".adminbot-time-chart__segment")).toHaveLength(2);
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

  it("builds bars from the selected user's start and end breakpoints", () => {
    const container = renderView({ selectedMemberId: "mem_ded86fcd" });

    expect(container.querySelectorAll(".adminbot-time-chart__total")).toHaveLength(3);
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

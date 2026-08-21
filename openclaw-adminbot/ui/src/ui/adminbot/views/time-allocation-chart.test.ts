// The chart is React mounted inside a custom element, which is the one seam in this view that a
// detached render never exercises: `connectedCallback` only fires once the element is in a
// document. Without a test that attaches it, a broken React root would ship looking fine to every
// other test on the page.
import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import {
  allocationSegments,
  renderTimeAllocationChart,
  type TimeAllocationAwayRange,
  type TimeAllocationTask,
} from "./time-allocation-chart.ts";

const TASKS: TimeAllocationTask[] = [
  {
    id: "atlas:0",
    key: "project:Atlas",
    sourceIndex: 0,
    source: "jinesis",
    name: "Atlas",
    start: "2026-03-02",
    end: "2026-03-29",
    effort: 0.5,
    note: "Shared with Mei",
  },
];

const AWAY: TimeAllocationAwayRange[] = [
  {
    id: "vacation:0",
    name: "Holiday",
    start: "2026-03-04",
    end: "2026-03-04",
    note: "Phone off",
  },
];

function mount(
  interval: "day" | "week" | "month" = "week",
  tasks: readonly TimeAllocationTask[] = TASKS,
  awayRanges: readonly TimeAllocationAwayRange[] = [],
): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  render(renderTimeAllocationChart(tasks, "Pat Doe", "pat", interval, awayRanges), host);
  return host;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("the time allocation chart element", () => {
  it("mounts a React root once it is in the document", () => {
    const chart = mount().querySelector("adminbot-effort-stack-chart")!;
    expect(chart).not.toBeNull();
    // recharts needs layout to draw bars, which jsdom does not do -- but the surrounding chrome
    // React renders unconditionally is proof the root mounted and the component ran.
    expect(chart.querySelector(".adminbot-time-chart__pager")).not.toBeNull();
    expect(chart.querySelectorAll(".adminbot-time-chart__page-button").length).toBe(2);
  });

  it("reads back the properties the view set on it", () => {
    const chart = mount("month").querySelector("adminbot-effort-stack-chart") as unknown as {
      interval: string;
      tasks: readonly TimeAllocationTask[];
      awayRanges: readonly TimeAllocationAwayRange[];
      memberName: string;
    };
    expect(chart.interval).toBe("month");
    expect(chart.memberName).toBe("Pat Doe");
    expect(chart.tasks[0]?.note).toBe("Shared with Mei");
    expect(chart.awayRanges).toEqual([]);
  });

  it("renders a whole-day-only schedule instead of the empty chart state", () => {
    const chart = mount("day", [], AWAY).querySelector("adminbot-effort-stack-chart")!;
    expect(chart.querySelector(".adminbot-time-chart__empty")).toBeNull();
    expect(chart.querySelector(".adminbot-time-chart__legend")?.textContent).toContain(
      "Whole day off",
    );
    expect(chart.querySelector(".adminbot-time-chart__away-background")).not.toBeNull();
    expect(chart.querySelector(".adminbot-time-chart__summary")?.textContent).toContain(
      "outside Jinesis commitments",
    );
  });

  it("gives outside commitments a separate hatched legend treatment", () => {
    const outside: TimeAllocationTask = {
      ...TASKS[0],
      id: "course:0",
      key: "away:Course load",
      name: "Course load",
      source: "outside",
    };
    const chart = mount("week", [TASKS[0], outside]).querySelector("adminbot-effort-stack-chart")!;
    expect(chart.querySelector(".adminbot-time-chart__legend-swatch--outside")).not.toBeNull();
    expect(chart.querySelector(".adminbot-time-chart__legend")?.textContent).toContain(
      "Outside Jinesis commitments",
    );
  });
});

describe("whole-day availability in chart intervals", () => {
  it("clears allocations on away days before averaging the interval", () => {
    const fullWeek: TimeAllocationTask = {
      ...TASKS[0],
      start: "2026-03-02",
      end: "2026-03-08",
      effort: 100,
    };
    const [week] = allocationSegments([fullWeek], AWAY, "2026-03-02", "week");

    expect(week.awayDays).toBe(1);
    expect(week.total).toBeCloseTo((100 * 6) / 7, 5);
    expect(week.awayRanges).toEqual(AWAY);
  });

  it("keeps quantified outside commitments in the numeric stack", () => {
    const outside: TimeAllocationTask = {
      ...TASKS[0],
      id: "course:0",
      key: "away:Course load",
      name: "Course load",
      source: "outside",
      start: "2026-03-02",
      end: "2026-03-08",
      effort: 25,
    };
    const [week] = allocationSegments([outside], [], "2026-03-02", "week");

    expect(week.awayDays).toBe(0);
    expect(week.total).toBe(25);
    expect(week.allocations[0]?.name).toBe("Course load");
  });
});

// The chart is React mounted inside a custom element, which is the one seam in this view that a
// detached render never exercises: `connectedCallback` only fires once the element is in a
// document. Without a test that attaches it, a broken React root would ship looking fine to every
// other test on the page.
import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { renderTimeAllocationChart, type TimeAllocationTask } from "./time-allocation-chart.ts";

const TASKS: TimeAllocationTask[] = [
  {
    id: "atlas:0",
    key: "project:Atlas",
    sourceIndex: 0,
    name: "Atlas",
    start: "2026-03-02",
    end: "2026-03-29",
    effort: 0.5,
    note: "Shared with Mei",
  },
];

function mount(interval: "day" | "week" | "month" = "week"): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  render(renderTimeAllocationChart(TASKS, "Pat Doe", "pat", interval), host);
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
      memberName: string;
    };
    expect(chart.interval).toBe("month");
    expect(chart.memberName).toBe("Pat Doe");
    expect(chart.tasks[0]?.note).toBe("Shared with Mei");
  });
});

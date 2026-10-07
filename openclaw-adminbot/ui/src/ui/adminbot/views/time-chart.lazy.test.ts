// recharts and react-dom are ~420KB of the console's entry chunk and only the Time Availability
// page draws with them. The page renders the chart's tag straight away and the React module
// arrives on first use, so the properties lit sets before the element is defined must survive
// the upgrade.
import { readFileSync } from "node:fs";
import path from "node:path";
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderTimeAllocationChart, type TimeAllocationTask } from "./time-chart.ts";

const TASK: TimeAllocationTask = {
  id: "atlas:0",
  key: "project:Atlas",
  sourceIndex: 0,
  source: "jinesis",
  name: "Atlas",
  start: "2026-03-02",
  end: "2026-03-29",
  effort: 0.5,
};

describe("the lazily loaded time chart", () => {
  it("keeps React out of the page module", () => {
    const page = readFileSync(
      path.resolve(
        process.cwd().endsWith("/ui") ? "" : "ui",
        "src/ui/adminbot/views/time-availability.ts",
      ),
      "utf8",
    );
    expect(page).not.toMatch(/^import [^;]*from "\.\/time-allocation-chart\.ts"/mu);
    expect(page).not.toMatch(/from "react(-dom)?/u);
  });

  it("draws with the properties set before the element was defined", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    render(renderTimeAllocationChart([TASK], "Pat Doe", "pat", "week"), host);
    const chart = host.querySelector("adminbot-effort-stack-chart") as HTMLElement & {
      tasks: readonly TimeAllocationTask[];
    };

    await customElements.whenDefined("adminbot-effort-stack-chart");
    await new Promise((resolve) => {
      setTimeout(resolve);
    });
    expect(Object.hasOwn(chart, "tasks")).toBe(false);
    expect(chart.tasks).toEqual([TASK]);
    expect(chart.querySelector(".adminbot-time-chart__capacity-note")).not.toBeNull();
  });
});

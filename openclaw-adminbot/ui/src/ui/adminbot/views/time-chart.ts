// The Time Allocation chart's entry point. The chart itself is React and recharts
// (time-allocation-chart.ts, ~420KB), so it loads the first time a page draws one rather than
// with the console. Until it arrives the tag is an empty element holding lit's properties.
import { html } from "lit";
import type {
  TimeAllocationAwayRange,
  TimeAllocationInterval,
  TimeAllocationTask,
  TimeChartWindow,
} from "./time-allocation-chart.ts";

export type {
  TimeAllocationAwayRange,
  TimeAllocationInterval,
  TimeAllocationTask,
  TimeChartWindow,
} from "./time-allocation-chart.ts";

export const TIME_CHART_ELEMENT = "adminbot-effort-stack-chart";

// The palette lives in styles/time-allocation-chart.css, not here, because the two themes need
// different steps of the same hue and a hex in this file can only be one of them. Read as CSS
// variables: recharts passes `fill` straight onto the SVG element, so `var(...)` resolves there
// like anywhere else, and switching theme repaints the chart with no JavaScript and no re-render.
//
// Order is the assignment order and is stable per category (first seen, first slot). Nothing here
// cycles past the eighth: a ninth category takes the neutral rather than a second turn at blue,
// which would put one colour on two series in the same stack.
export const CHART_COLORS = [
  "var(--adminbot-chart-series-1)",
  "var(--adminbot-chart-series-2)",
  "var(--adminbot-chart-series-3)",
  "var(--adminbot-chart-series-4)",
  "var(--adminbot-chart-series-5)",
  "var(--adminbot-chart-series-6)",
  "var(--adminbot-chart-series-7)",
  "var(--adminbot-chart-series-8)",
] as const;
export const CHART_NEUTRAL_COLOR = "var(--adminbot-chart-neutral)";

let chartModule: Promise<unknown> | undefined;

export function renderTimeAllocationChart(
  tasks: readonly TimeAllocationTask[],
  memberName: string,
  memberId: string,
  interval: TimeAllocationInterval,
  awayRanges: readonly TimeAllocationAwayRange[] = [],
  onWindowChange?: (window: TimeChartWindow) => void,
) {
  // A failed fetch (offline, a deploy replaced the chunk) is forgotten so the next render retries.
  chartModule ??= import("./time-allocation-chart.ts").catch(() => (chartModule = undefined));
  return html`
    <adminbot-effort-stack-chart
      .memberId=${memberId}
      .interval=${interval}
      .tasks=${tasks}
      .awayRanges=${awayRanges}
      .memberName=${memberName}
      @time-window-change=${(event: Event) =>
        onWindowChange?.((event as CustomEvent<TimeChartWindow>).detail)}
    ></adminbot-effort-stack-chart>
  `;
}

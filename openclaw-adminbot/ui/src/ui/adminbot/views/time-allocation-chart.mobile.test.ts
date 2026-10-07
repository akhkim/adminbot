import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTimeAllocationChart } from "./time-allocation-chart.ts";

// jsdom has no chart geometry. Drive the selected-period seam without real pointer coordinates.
vi.mock("recharts", async () => {
  const { createElement, cloneElement } = await import("react");
  const container = ({ children }: { children?: import("react").ReactNode }) =>
    createElement("div", null, children);
  const empty = () => null;
  return {
    Bar: empty,
    BarChart: ({ children }: { children?: import("react").ReactNode }) =>
      createElement("svg", null, children),
    CartesianGrid: empty,
    LabelList: empty,
    ReferenceLine: empty,
    ResponsiveContainer: container,
    XAxis: empty,
    YAxis: empty,
    Legend: empty,
    Tooltip: ({ content }: { content: import("react").ReactElement }) =>
      cloneElement(content, {
        active: true,
        label: "Oct 5–Oct 11",
        payload: [{ dataKey: "project:Atlas", name: "Atlas", value: 50, payload: { total: 50 } }],
      } as Record<string, unknown>),
  };
});

afterEach(() => {
  for (const chart of document.querySelectorAll("adminbot-effort-stack-chart")) {
    chart.remove();
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("selected period details", () => {
  it.each([true, false])("escape the scrolling plot only on a phone (mobile=%s)", (mobile) => {
    vi.stubGlobal("matchMedia", () => ({ matches: mobile }));
    const host = document.createElement("div");
    document.body.append(host);
    render(
      renderTimeAllocationChart(
        [
          {
            id: "atlas",
            key: "project:Atlas",
            sourceIndex: 0,
            source: "jinesis",
            name: "Atlas",
            start: "2026-10-01",
            end: "2026-10-31",
            effort: 0.5,
          },
        ],
        "Example Member",
        "example",
        "week",
      ),
      host,
    );
    const tooltip = document.querySelector(".adminbot-time-chart__tooltip")!;
    expect(tooltip).not.toBeNull();
    expect(tooltip.textContent).toContain("Oct 5–Oct 11");
    expect(tooltip.textContent).toContain("50%");
    expect(host.contains(tooltip)).toBe(!mobile);
    expect(tooltip.classList.contains("adminbot-time-chart__tooltip--mobile")).toBe(mobile);
  });
});

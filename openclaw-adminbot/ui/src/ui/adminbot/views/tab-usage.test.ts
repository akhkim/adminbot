/* @vitest-environment jsdom */
// The read side: what the usage table says, and what it refuses to imply.
import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { TabVisitRate, TabVisitReport } from "../auth/session.ts";
import {
  dwellLabel,
  renderAdminBotTabUsage,
  tabLabel,
  type TabUsageViewProps,
} from "./tab-usage.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

function rate(fields: Partial<TabVisitRate> & { tab: string }): TabVisitRate {
  return {
    visits: 10,
    members: 3,
    visitsPerDay: 0.33,
    dwellSecondsMedian: 90,
    dwellSecondsTotal: 900,
    dwellSamples: 9,
    firstAt: "2026-09-01T09:00:00.000Z",
    lastAt: "2026-09-14T09:00:00.000Z",
    ...fields,
  };
}

function report(overrides: Partial<TabVisitReport> = {}): TabVisitReport {
  return {
    from: "2026-08-15T00:00:00.000Z",
    to: "2026-09-14T00:00:00.000Z",
    days: 30,
    visits: 10,
    members: 3,
    impersonatedVisits: 0,
    tabs: [rate({ tab: "dashboard" })],
    ...overrides,
  };
}

function draw(overrides: Partial<TabUsageViewProps> = {}) {
  const days: number[] = [];
  const exported: true[] = [];
  const refreshed: true[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderAdminBotTabUsage({
      report: report(),
      days: 30,
      loading: false,
      exporting: false,
      error: null,
      onDaysChange: (value) => days.push(value),
      onExport: () => exported.push(true),
      onRefresh: () => refreshed.push(true),
      ...overrides,
    }),
    container,
  );
  return { container, days, exported, refreshed };
}

describe("tabLabel", () => {
  it("names a tab the build knows", () => {
    expect(tabLabel("adminbotPapers")).toBe("Active Papers");
  });

  it("falls back to the raw id for a tab this build has never heard of", () => {
    // A visit to a renamed or removed tab is the one row proving it existed and was used, so it is
    // shown rather than dropped or drawn blank. t() answers a missing key with the key itself, which
    // would otherwise put "tabs.somethingOld" in the column.
    expect(tabLabel("somethingOld")).toBe("somethingOld");
  });
});

describe("dwellLabel", () => {
  it("says nothing rather than zero when no visit could be timed", () => {
    expect(dwellLabel(0, 0)).toBe("—");
  });

  it("reads in seconds under a minute and in minutes above it", () => {
    expect(dwellLabel(38, 4)).toBe("38s");
    expect(dwellLabel(252, 4)).toBe("4m 12s");
    expect(dwellLabel(300, 4)).toBe("5m");
  });
});

describe("renderAdminBotTabUsage", () => {
  it("draws a row per tab with its counts", () => {
    const { container } = draw({
      report: report({
        visits: 30,
        tabs: [
          rate({ tab: "dashboard", visits: 20, members: 5, visitsPerDay: 0.67 }),
          rate({ tab: "adminbotPapers", visits: 10, members: 2 }),
        ],
      }),
    });
    const row = container.querySelector('[data-testid="tab-usage-row-dashboard"]');
    expect(row?.textContent).toContain("Dashboard");
    expect(row?.textContent).toContain("20");
    expect(row?.textContent).toContain("0.67");
    expect(container.querySelectorAll(".tab-usage__table tbody tr")).toHaveLength(2);
  });

  it("scales each bar against the busiest tab rather than the total", () => {
    const { container } = draw({
      report: report({
        tabs: [rate({ tab: "dashboard", visits: 20 }), rate({ tab: "profile", visits: 5 })],
      }),
    });
    const bars = [...container.querySelectorAll<HTMLElement>(".tab-usage__bar")].map((bar) =>
      bar.getAttribute("style"),
    );
    expect(bars[0]).toContain("100%");
    expect(bars[1]).toContain("25%");
  });

  it("offers the windows and reports which one is showing", () => {
    const { container, days } = draw({ days: 7 });
    const seven = container.querySelector<HTMLButtonElement>('[data-testid="tab-usage-window-7"]');
    const ninety = container.querySelector<HTMLButtonElement>(
      '[data-testid="tab-usage-window-90"]',
    );
    expect(seven?.getAttribute("aria-pressed")).toBe("true");
    expect(ninety?.getAttribute("aria-pressed")).toBe("false");
    ninety?.click();
    expect(days).toEqual([90]);
  });

  it("says an empty window is empty rather than drawing an empty table", () => {
    const { container } = draw({ report: report({ visits: 0, members: 0, tabs: [] }) });
    expect(container.querySelector('[data-testid="tab-usage-empty"]')).not.toBeNull();
    expect(container.querySelector(".tab-usage__table")).toBeNull();
  });

  it("refuses to export a window with nothing in it", () => {
    const empty = draw({ report: report({ visits: 0, tabs: [] }) });
    expect(
      empty.container.querySelector<HTMLButtonElement>('[data-testid="tab-usage-export"]')
        ?.disabled,
    ).toBe(true);

    const full = draw();
    const button = full.container.querySelector<HTMLButtonElement>(
      '[data-testid="tab-usage-export"]',
    );
    expect(button?.disabled).toBe(false);
    button?.click();
    expect(full.exported).toEqual([true]);
  });

  it("counts view-as browsing on the page rather than hiding it", () => {
    const { container } = draw({ report: report({ impersonatedVisits: 4 }) });
    const flagged = container.querySelector('[data-testid="tab-usage-impersonated"]');
    expect(flagged?.textContent).toContain("4");
    expect(flagged?.textContent).toContain("while viewing as");
  });

  it("does not show a stale window as an error and nothing else", () => {
    // An unreachable service should not also erase the numbers somebody was reading.
    const { container } = draw({ error: "Could not reach AdminBot." });
    expect(container.querySelector('[data-testid="tab-usage-error"]')?.textContent).toContain(
      "Could not reach",
    );
    expect(container.querySelector(".tab-usage__table")).not.toBeNull();
  });

  it("says what the numbers cannot say", () => {
    // The caveat is part of the page on purpose: every clause is a way to over-read the table.
    const { container } = draw();
    const caveat = container.querySelector(".tab-usage__caveat")?.textContent ?? "";
    expect(caveat).toContain("30 minutes");
    expect(caveat).toContain("one tab switch");
  });
});

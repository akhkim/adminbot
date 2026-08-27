/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Opportunity } from "../data/opportunities-data.ts";
import { categoryCount, opportunityRows, renderOpportunities } from "./opportunities.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-04T12:00:00Z"));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

async function renderView(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderOpportunities(), container);
  await (
    container.querySelector("adminbot-opportunities-view") as { updateComplete?: Promise<unknown> }
  )?.updateComplete;
  return container;
}

const FIXTURE: Opportunity[] = [
  {
    id: "late",
    name: "Later Grant",
    category: "grants_awards",
    deadline_aoe: "2026-12-01 23:59:59",
  },
  { id: "tba_b", name: "B Program", category: "rising_stars", deadline_aoe: "" },
  {
    id: "soon",
    name: "Soon Internship",
    category: "internship",
    deadline_aoe: "2026-09-01 23:59:59",
  },
  { id: "tba_a", name: "A Program", category: "rising_stars", deadline_aoe: "" },
];

describe("opportunityRows", () => {
  it("sorts dated entries ascending and puts undated ones last", () => {
    const ids = opportunityRows("all", FIXTURE).map((row) => row.item.id);
    expect(ids).toEqual(["soon", "late", "tba_a", "tba_b"]);
  });

  it("orders undated entries by name so the list is stable", () => {
    const undated = opportunityRows("rising_stars", FIXTURE).map((row) => row.item.name);
    expect(undated).toEqual(["A Program", "B Program"]);
  });

  it("filters to a single category", () => {
    const rows = opportunityRows("internship", FIXTURE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.item.id).toBe("soon");
  });

  it("counts per category and in total", () => {
    expect(categoryCount("all", FIXTURE)).toBe(4);
    expect(categoryCount("rising_stars", FIXTURE)).toBe(2);
    expect(categoryCount("phd", FIXTURE)).toBe(0);
  });
});

describe("renderOpportunities", () => {
  it("renders a sub-tab per category plus All", async () => {
    const container = await renderView();
    const labels = [...container.querySelectorAll(".opp-tab")].map(
      (tab) => (tab.textContent ?? "").trim().split(/\s+/u)[0],
    );
    expect(labels[0]).toBe("All");
    expect(labels).toContain("Rising");
    expect(labels).toContain("Internships");
  });

  it("shows the bundled Rising Stars programs with eligibility quoted", async () => {
    const container = await renderView();
    const text = container.textContent ?? "";
    expect(text).toContain("Rising Stars in EECS");
    expect(text).toContain("underrepresented");
  });

  // The whole point of the undated state: an unannounced cycle must never render as a date.
  it("renders undated entries as Deadline TBA and never as a countdown", async () => {
    const container = await renderView();
    const rows = [...container.querySelectorAll(".opp-row")];
    expect(rows.length).toBeGreaterThan(0);
    const tba = rows.filter((row) =>
      (row.querySelector(".opp-date")?.textContent ?? "").includes("Deadline TBA"),
    );
    expect(tba.length).toBeGreaterThan(0);
    for (const row of tba) {
      expect(row.querySelector(".opp-rel")).toBeNull();
    }
  });

  it("switches the visible rows when a sub-tab is clicked", async () => {
    const container = await renderView();
    const view = container.querySelector("adminbot-opportunities-view") as HTMLElement & {
      updateComplete?: Promise<unknown>;
    };
    const phdTab = [...container.querySelectorAll(".opp-tab")].find((tab) =>
      (tab.textContent ?? "").includes("PhD"),
    ) as HTMLButtonElement;
    phdTab.click();
    await view.updateComplete;
    expect(phdTab.getAttribute("aria-selected")).toBe("true");
    // No PhD entries are seeded yet, so the empty state is what should show.
    expect(container.textContent ?? "").toContain("Nothing listed here yet.");
  });
});

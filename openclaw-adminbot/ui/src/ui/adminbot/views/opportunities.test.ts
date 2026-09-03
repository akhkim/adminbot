/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminBotOpportunityView, Opportunity } from "../data/opportunities-data.ts";
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
  const element = container.querySelector("adminbot-opportunities-view") as {
    updateComplete?: Promise<unknown>;
  } | null;
  await element?.updateComplete;
  // The contributed half is fetched in connectedCallback, so the first paint predates it. Fake
  // timers are in force, so drain microtasks by hand rather than waiting on a clock that is frozen.
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
  await element?.updateComplete;
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

// The board is a public tab, so who gets a control matters as much as what the control does. The
// service re-checks all of it; these cover the half a visitor can see.
describe("who may contribute", () => {
  const SESSION_KEY = "openclaw.adminbot.session.v1";

  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  function signIn(): void {
    window.localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ sessionToken: "tok", expiresAt: "2099-01-01T00:00:00.000Z" }),
    );
  }

  function serveContributed(entries: AdminBotOpportunityView[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ opportunities: entries }), { status: 200 })),
    );
  }

  const contributed = (
    overrides: Partial<AdminBotOpportunityView> = {},
  ): AdminBotOpportunityView => ({
    id: "opp_1",
    name: "Member Find",
    category: "internship",
    deadline_aoe: "",
    status: "approved",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });

  it("gives a signed-out visitor no add, edit or delete control", async () => {
    serveContributed([contributed()]);
    const container = await renderView();

    expect(container.textContent ?? "").toContain("Member Find");
    expect(container.querySelector(".opp-fab")).toBeNull();
    expect(container.querySelector(".opp-actions")).toBeNull();
  });

  it("gives a signed-in member the add control and row actions", async () => {
    signIn();
    serveContributed([contributed()]);
    const container = await renderView();

    expect(container.querySelector(".opp-fab")).not.toBeNull();
    expect(container.querySelector(".opp-actions")).not.toBeNull();
  });

  it("marks an entry still waiting on review, and never a bundled one", async () => {
    signIn();
    serveContributed([contributed({ status: "pending" })]);
    const container = await renderView();

    expect(container.querySelector(".opp-pending-tag")).not.toBeNull();
    // The bundled snapshot has no review state and must not grow one.
    const bundledRows = [...container.querySelectorAll(".opp-row")].filter(
      (row) => !row.textContent?.includes("Member Find"),
    );
    for (const row of bundledRows) {
      expect(row.querySelector(".opp-member-tag")).toBeNull();
      expect(row.querySelector(".opp-actions")).toBeNull();
    }
  });

  it("still shows the bundled half when the service cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const container = await renderView();

    expect(container.querySelectorAll(".opp-row").length).toBeGreaterThan(0);
  });
});

/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderDeadlines } from "./deadlines.ts";

// The countdown element owns a 1-second interval; drive it with fake timers so
// the test asserts the tick behavior instead of sleeping.
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
  render(renderDeadlines(), container);
  // The view is a custom element; its first render is scheduled asynchronously.
  await settle(container);
  return container;
}

async function settle(container: HTMLElement): Promise<void> {
  await (
    container.querySelector("adminbot-deadlines-view") as { updateComplete?: Promise<unknown> }
  )?.updateComplete;
}

// Inside the last day the "Nd " prefix is dropped, so it is optional here.
const COUNTDOWN = /^(?:\d+d )?\d{2}:\d{2}:\d{2}$/u;

function conferenceNamed(container: HTMLElement, needle: string): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>(".conference")].find((node) =>
    node.querySelector(".conference__name")?.textContent?.includes(needle),
  )!;
}

describe("renderDeadlines", () => {
  it("lists one row per conference, soonest first, with a live countdown", async () => {
    const container = await renderView();

    const rows = [...container.querySelectorAll(".conference")];
    expect(rows.length).toBeGreaterThan(0);
    // The snapshot carries a handful of conferences behind a hundred-odd venues; the point of the
    // view is that the board is the size of the former, not the latter.
    expect(rows.length).toBeLessThan(20);

    const countdowns = rows.map(
      (row) => row.querySelector(".conference__countdown")?.textContent?.trim() ?? "",
    );
    for (const label of countdowns) {
      expect(label).toMatch(COUNTDOWN);
    }
    // Sorted ascending by the soonest deadline under each conference.
    const daysOf = (label: string) => (label.includes("d ") ? Number(label.split("d")[0]) : 0);
    expect(daysOf(countdowns[0] ?? "")).toBeLessThanOrEqual(daysOf(countdowns.at(-1) ?? ""));
  });

  it("keeps every conference collapsed until it is opened", async () => {
    const container = await renderView();

    const toggles = [...container.querySelectorAll('[data-testid="conference-toggle"]')];
    expect(toggles.length).toBeGreaterThan(0);
    for (const toggle of toggles) {
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    }
    for (const panel of container.querySelectorAll(".conference__panel")) {
      expect(panel.hasAttribute("hidden")).toBe(true);
    }
  });

  it("opens a conference to its workshops and closes it again", async () => {
    const container = await renderView();

    // NeurIPS is the conference carrying a full workshop track in the bundled snapshot.
    conferenceNamed(container, "NeurIPS")
      .querySelector<HTMLButtonElement>('[data-testid="conference-toggle"]')!
      .click();
    await settle(container);

    const opened = conferenceNamed(container, "NeurIPS");
    const toggle = opened.querySelector('[data-testid="conference-toggle"]')!;
    const panel = opened.querySelector(".conference__panel")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hasAttribute("hidden")).toBe(false);
    // aria-controls points at the panel it actually reveals.
    expect(toggle.getAttribute("aria-controls")).toBe(panel.id);

    const workshopRows = panel.querySelectorAll(".deadline-row");
    expect(workshopRows.length).toBeGreaterThan(1);
    for (const row of workshopRows) {
      expect(row.querySelector(".deadline-row__countdown")?.textContent?.trim()).toMatch(COUNTDOWN);
      expect(row.querySelector(".deadline-row__name")?.textContent?.trim()).not.toBe("");
    }

    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(container);
    expect(
      conferenceNamed(container, "NeurIPS")
        .querySelector('[data-testid="conference-toggle"]')!
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("hoists the date a whole workshop track shares instead of repeating it per row", async () => {
    const container = await renderView();

    conferenceNamed(container, "NeurIPS")
      .querySelector<HTMLButtonElement>('[data-testid="conference-toggle"]')!
      .click();
    await settle(container);

    const workshops = [...container.querySelectorAll(".deadline-section")].find((section) =>
      section.querySelector(".deadline-section__title")?.textContent?.includes("Workshops"),
    )!;
    expect(workshops).toBeDefined();
    expect(workshops.querySelector(".deadline-section__shared")?.textContent).toMatch(/all due/u);
    // The shared date is stated once in the head, so the rows carry no date column of their own.
    expect(workshops.querySelectorAll(".deadline-row__date").length).toBe(0);
  });

  it("leads with the single most urgent deadline anywhere", async () => {
    const container = await renderView();

    const lead = container.querySelector(".deadline-lead");
    expect(lead).not.toBeNull();
    expect(lead?.querySelector(".deadline-lead__countdown")?.textContent?.trim()).toMatch(
      COUNTDOWN,
    );
    expect(lead?.querySelector(".deadline-lead__name")?.textContent?.trim()).not.toBe("");
  });

  it("ticks the countdown in place every second", async () => {
    const container = await renderView();
    const readFirst = () => container.querySelector(".conference__countdown")?.textContent ?? "";

    const before = readFirst();
    await vi.advanceTimersByTimeAsync(2_000);
    const after = readFirst();

    expect(before).toMatch(/^(?:\d+d )?\d{2}:/u);
    expect(after).not.toBe(before);
  });

  it("stops its timer when the element leaves the DOM", async () => {
    const container = await renderView();
    const element = container.querySelector("adminbot-deadlines-view");
    expect(element).not.toBeNull();

    element?.remove();
    const detachedLabel = element?.querySelector(".conference__countdown")?.textContent;
    await vi.advanceTimersByTimeAsync(5_000);

    // disconnectedCallback cleared the interval, so the detached node stops updating —
    // a leaked timer would keep re-rendering it every second forever.
    expect(element?.querySelector(".conference__countdown")?.textContent).toBe(detachedLabel);
  });
});

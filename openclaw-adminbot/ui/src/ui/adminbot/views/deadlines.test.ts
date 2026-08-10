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
  await (
    container.querySelector("adminbot-deadlines-view") as { updateComplete?: Promise<unknown> }
  )?.updateComplete;
  return container;
}

describe("renderDeadlines", () => {
  it("lists only future deadlines, soonest first, with a d/HH:MM:SS countdown", async () => {
    const container = await renderView();

    expect(container.querySelectorAll(".deadline-row").length).toBeGreaterThan(0);
    // The countdown belongs to the date band, not the row: every venue in a band shares it.
    const countdowns = [...container.querySelectorAll(".deadlines__day-countdown")].map(
      (node) => node.textContent?.trim() ?? "",
    );
    expect(countdowns.length).toBeGreaterThan(0);
    for (const label of countdowns) {
      // Inside the last day the "Nd " prefix is dropped, so it is optional here.
      expect(label).toMatch(/^(?:\d+d )?\d{2}:\d{2}:\d{2}$/u);
    }
    // Sorted ascending: the first band's day count never exceeds the last's.
    const daysOf = (label: string) => (label.includes("d ") ? Number(label.split("d")[0]) : 0);
    expect(daysOf(countdowns[0] ?? "")).toBeLessThanOrEqual(daysOf(countdowns.at(-1) ?? ""));
  });

  it("pulls the soonest deadline out of the list into its own lead panel", async () => {
    const container = await renderView();

    const lead = container.querySelector(".deadline-lead");
    expect(lead).not.toBeNull();
    const leadCountdown = lead?.querySelector(".deadline-lead__countdown")?.textContent?.trim();
    expect(leadCountdown).toMatch(/^(?:\d+d )?\d{2}:\d{2}:\d{2}$/u);

    // The lead is not repeated in the date bands below it.
    const leadName = lead?.querySelector(".deadline-lead__name")?.textContent?.trim() ?? "";
    expect(leadName).not.toBe("");
    const listNames = [...container.querySelectorAll(".deadline-row__name")].map((node) =>
      node.textContent?.trim(),
    );
    expect(listNames).not.toContain(leadName);
  });

  it("groups the remaining deadlines under date bands", async () => {
    const container = await renderView();

    const months = [...container.querySelectorAll(".deadlines__day-name")].map((node) =>
      node.textContent?.trim(),
    );
    expect(months.length).toBeGreaterThan(0);
    for (const month of months) {
      expect(month).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4} AoE$/u);
    }
    // Every row lives inside a date band.
    expect(container.querySelectorAll(".deadlines__day .deadline-row").length).toBe(
      container.querySelectorAll(".deadline-row").length,
    );
  });

  it("ticks the countdown in place every second", async () => {
    const container = await renderView();
    const readFirst = () => container.querySelector(".deadlines__day-countdown")?.textContent ?? "";

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
    const detachedLabel = element?.querySelector(".deadlines__day-countdown")?.textContent;
    await vi.advanceTimersByTimeAsync(5_000);

    // disconnectedCallback cleared the interval, so the detached node stops updating —
    // a leaked timer would keep re-rendering it every second forever.
    expect(element?.querySelector(".deadlines__day-countdown")?.textContent).toBe(detachedLabel);
  });
});

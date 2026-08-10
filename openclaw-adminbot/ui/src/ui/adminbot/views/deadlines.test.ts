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

    const rows = [...container.querySelectorAll(".deadline-row")];
    expect(rows.length).toBeGreaterThan(0);
    const countdowns = rows.map((row) => row.querySelector(".dl-cd")?.textContent ?? "");
    for (const label of countdowns) {
      expect(label).toMatch(/^\d+d \d{2}:\d{2}:\d{2}$/u);
    }
    // Sorted ascending: the first row's day count never exceeds the last's.
    const firstDays = Number(countdowns[0]?.split("d")[0]);
    const lastDays = Number(countdowns.at(-1)?.split("d")[0]);
    expect(firstDays).toBeLessThanOrEqual(lastDays);
  });

  it("ticks the countdown in place every second", async () => {
    const container = await renderView();
    const readFirst = () => container.querySelector(".deadline-row .dl-cd")?.textContent ?? "";

    const before = readFirst();
    await vi.advanceTimersByTimeAsync(2_000);
    const after = readFirst();

    expect(before).toMatch(/^\d+d /u);
    expect(after).not.toBe(before);
  });

  it("stops its timer when the element leaves the DOM", async () => {
    const container = await renderView();
    const element = container.querySelector("adminbot-deadlines-view");
    expect(element).not.toBeNull();

    element?.remove();
    const detachedLabel = element?.querySelector(".dl-cd")?.textContent;
    await vi.advanceTimersByTimeAsync(5_000);

    // disconnectedCallback cleared the interval, so the detached node stops updating —
    // a leaked timer would keep re-rendering it every second forever.
    expect(element?.querySelector(".dl-cd")?.textContent).toBe(detachedLabel);
  });
});

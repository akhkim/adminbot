import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginPageActivity,
  notePageIntent,
  pageActivityCount,
  resetPageActivityForTest,
  subscribePageActivity,
  trackPageActivity,
} from "./page-activity.ts";
import {
  createPageProgressController,
  PAGE_PROGRESS_MIN_VISIBLE_MS,
  PAGE_PROGRESS_SHOW_DELAY_MS,
} from "./page-progress.ts";

afterEach(() => {
  resetPageActivityForTest();
  vi.useRealTimers();
});

describe("page activity", () => {
  it("ignores work that no gesture explains (background polling)", () => {
    const end = beginPageActivity(10_000);
    expect(pageActivityCount()).toBe(0);
    end();
    expect(pageActivityCount()).toBe(0);
  });

  it("counts work that starts just after a gesture, and what chains onto it", () => {
    notePageIntent(1_000);
    const first = beginPageActivity(1_500);
    // Long after the click, but the page load it started is still running.
    const second = beginPageActivity(9_000);
    expect(pageActivityCount()).toBe(2);
    first();
    first();
    expect(pageActivityCount()).toBe(1);
    second();
    expect(pageActivityCount()).toBe(0);
    expect(beginPageActivity(9_500)).toBeTypeOf("function");
    expect(pageActivityCount()).toBe(0);
  });

  it("ends when the tracked promise settles either way and tells subscribers", async () => {
    const seen: number[] = [];
    subscribePageActivity((active) => seen.push(active));
    notePageIntent();
    await trackPageActivity(Promise.resolve("ok"));
    await trackPageActivity(Promise.reject(new Error("no"))).catch(() => undefined);
    await Promise.resolve();
    expect(pageActivityCount()).toBe(0);
    expect(seen).toEqual([1, 0, 1, 0]);
  });
});

describe("page progress controller", () => {
  it("never shows for work that finishes quickly", () => {
    vi.useFakeTimers();
    const visible: boolean[] = [];
    const controller = createPageProgressController((next) => visible.push(next));
    controller.update(1);
    vi.advanceTimersByTime(PAGE_PROGRESS_SHOW_DELAY_MS - 1);
    controller.update(0);
    vi.advanceTimersByTime(5_000);
    expect(visible).toEqual([]);
  });

  it("shows after the delay and stays long enough to be seen", () => {
    vi.useFakeTimers();
    const visible: boolean[] = [];
    const controller = createPageProgressController((next) => visible.push(next));
    controller.update(1);
    vi.advanceTimersByTime(PAGE_PROGRESS_SHOW_DELAY_MS);
    expect(visible).toEqual([true]);
    controller.update(0);
    vi.advanceTimersByTime(PAGE_PROGRESS_MIN_VISIBLE_MS - 1);
    expect(visible).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(visible).toEqual([true, false]);
  });

  it("stays up across back-to-back requests instead of blinking", () => {
    vi.useFakeTimers();
    const visible: boolean[] = [];
    const controller = createPageProgressController((next) => visible.push(next));
    controller.update(1);
    vi.advanceTimersByTime(PAGE_PROGRESS_SHOW_DELAY_MS);
    controller.update(0);
    controller.update(1);
    vi.advanceTimersByTime(10_000);
    expect(visible).toEqual([true]);
    controller.update(0);
    vi.advanceTimersByTime(PAGE_PROGRESS_MIN_VISIBLE_MS);
    expect(visible).toEqual([true, false]);
  });
});

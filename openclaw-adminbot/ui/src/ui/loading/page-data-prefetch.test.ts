import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingTabDataPrefetch,
  isPrefetchableReadPath,
  prefetchTabDataNow,
  prefetchTabDataOnIntent,
  registerPageDataPrefetch,
  resetPageDataPrefetchForTest,
} from "./page-data-prefetch.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetPageDataPrefetchForTest();
  vi.useRealTimers();
});

describe("page data prefetch", () => {
  it("asks only after the pointer has rested on the link for a moment", () => {
    const warm = vi.fn();
    registerPageDataPrefetch(["badges"], warm);
    prefetchTabDataOnIntent("badges");
    vi.advanceTimersByTime(79);
    expect(warm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing when the pointer only passes over, or moves on to another link", () => {
    const badges = vi.fn();
    const meetings = vi.fn();
    registerPageDataPrefetch(["badges"], badges);
    registerPageDataPrefetch(["meetings"], meetings);

    prefetchTabDataOnIntent("badges");
    vi.advanceTimersByTime(40);
    cancelPendingTabDataPrefetch();
    vi.advanceTimersByTime(200);
    expect(badges).not.toHaveBeenCalled();

    prefetchTabDataOnIntent("badges");
    vi.advanceTimersByTime(40);
    prefetchTabDataOnIntent("meetings");
    vi.advanceTimersByTime(200);
    expect(badges).not.toHaveBeenCalled();
    expect(meetings).toHaveBeenCalledTimes(1);
  });

  it("does not restart the pause when the same link reports the pointer again", () => {
    const warm = vi.fn();
    registerPageDataPrefetch(["badges"], warm);
    prefetchTabDataOnIntent("badges");
    vi.advanceTimersByTime(60);
    prefetchTabDataOnIntent("badges");
    vi.advanceTimersByTime(20);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("never asks on a guess when the viewer is saving data or on a slow connection", () => {
    const warm = vi.fn();
    registerPageDataPrefetch(["badges"], warm);
    prefetchTabDataOnIntent("badges", () => false);
    vi.advanceTimersByTime(500);
    expect(warm).not.toHaveBeenCalled();
  });

  it("asks at once when the tab is chosen, and not again for the hover that led to it", () => {
    const warm = vi.fn();
    registerPageDataPrefetch(["badges"], warm);
    prefetchTabDataOnIntent("badges");
    vi.advanceTimersByTime(80);
    prefetchTabDataNow("badges");
    expect(warm).toHaveBeenCalledTimes(1);

    // Much later the answer in hand is stale, so a new approach asks again.
    vi.advanceTimersByTime(11_000);
    prefetchTabDataNow("badges");
    expect(warm).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a tab with no registered read, and survives a warmer that throws", () => {
    registerPageDataPrefetch(["broken"], () => {
      throw new Error("no session");
    });
    expect(() => prefetchTabDataNow("unknown")).not.toThrow();
    expect(() => prefetchTabDataNow("broken")).not.toThrow();
  });

  it("refuses the reads that are heavy for the service", () => {
    for (const path of [
      "/audit",
      "/audit?limit=50",
      "/openreview/citation-checks",
      "/venue-picker",
      "/venue-picker?q=acl",
      "/venue-papers/acl-2026",
      "/slack/channels",
    ]) {
      expect(isPrefetchableReadPath(path), path).toBe(false);
    }
    for (const path of ["/lab/projects", "/badges", "/auditions", "/meetings/series"]) {
      expect(isPrefetchableReadPath(path), path).toBe(true);
    }
  });
});

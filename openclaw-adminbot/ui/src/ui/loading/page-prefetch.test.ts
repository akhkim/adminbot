import { afterEach, describe, expect, it, vi } from "vitest";
import { createLazyView } from "../lazy-view.ts";
import { pageActivityCount, notePageIntent, resetPageActivityForTest } from "./page-activity.ts";
import {
  canPrefetchInBackground,
  notePrefetchableNavTab,
  prefetchTab,
  registerPagePrefetch,
  resetPagePrefetchForTest,
} from "./page-prefetch.ts";

afterEach(() => {
  resetPagePrefetchForTest();
  resetPageActivityForTest();
});

const flush = async () => {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
};

function manualScheduler(allowed = true) {
  const queue: Array<() => void> = [];
  return {
    scheduler: {
      delay: (run: () => void) => void queue.push(run),
      idle: (run: () => void) => void queue.push(run),
      allowed: () => allowed,
    },
    runAll: () => {
      for (let guard = 0; queue.length && guard < 100; guard += 1) {
        queue.shift()?.();
      }
    },
    pending: () => queue.length,
  };
}

describe("page prefetch", () => {
  it("starts a tab's code once, however often its link is pointed at", async () => {
    const loader = vi.fn(async () => ({ page: "events" }));
    const view = createLazyView(loader, undefined, { tabs: ["events"] });
    prefetchTab("events");
    prefetchTab("events");
    expect(loader).toHaveBeenCalledTimes(1);
    await flush();
    prefetchTab("events");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(view.read()).toEqual({ page: "events" });
  });

  it("does nothing for a tab with no lazy code", () => {
    expect(() => prefetchTab("dashboard")).not.toThrow();
  });

  it("prefetches quietly: no repaint, no progress line, and a failure is retried by the visit", async () => {
    const onChange = vi.fn();
    const loader = vi
      .fn<() => Promise<{ page: string }>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ page: "cron" });
    const view = createLazyView(loader, onChange, { tabs: ["cron"] });
    notePageIntent();
    view.prefetch();
    expect(pageActivityCount()).toBe(0);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(view.hasError()).toBe(false);
    expect(view.read()).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(view.read()).toEqual({ page: "cron" });
  });

  it("repaints the page that started waiting on a prefetch already in flight", async () => {
    const onChange = vi.fn();
    let resolve: (mod: { page: string }) => void = () => undefined;
    const view = createLazyView(
      () => new Promise<{ page: string }>((done) => (resolve = done)),
      onChange,
    );
    view.prefetch();
    notePageIntent();
    expect(view.read()).toBeNull();
    expect(pageActivityCount()).toBe(1);
    resolve({ page: "logs" });
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(pageActivityCount()).toBe(0);
    expect(view.read()).toEqual({ page: "logs" });
  });

  it("walks the viewer's sidebar one page at a time when idle", () => {
    const events = vi.fn();
    const cron = vi.fn();
    const adminOnly = vi.fn();
    registerPagePrefetch(["events"], events);
    registerPagePrefetch(["cron"], cron);
    registerPagePrefetch(["adminbotRegistrations"], adminOnly);
    const { scheduler, runAll, pending } = manualScheduler();
    notePrefetchableNavTab("dashboard", scheduler);
    notePrefetchableNavTab("events", scheduler);
    notePrefetchableNavTab("cron", scheduler);
    expect(events).not.toHaveBeenCalled();
    runAll();
    expect(events).toHaveBeenCalledTimes(1);
    expect(cron).toHaveBeenCalledTimes(1);
    // Not in this viewer's sidebar, so never fetched on a guess.
    expect(adminOnly).not.toHaveBeenCalled();
    // The sidebar announces its links on every render; handled tabs do not re-arm the pass.
    notePrefetchableNavTab("events", scheduler);
    expect(pending()).toBe(0);
  });

  it("stays out of the way on a data-saving or very slow connection", () => {
    const events = vi.fn();
    registerPagePrefetch(["events"], events);
    const { scheduler, runAll } = manualScheduler(false);
    notePrefetchableNavTab("events", scheduler);
    runAll();
    expect(events).not.toHaveBeenCalled();
    expect(canPrefetchInBackground({ saveData: true })).toBe(false);
    expect(canPrefetchInBackground({ effectiveType: "slow-2g" })).toBe(false);
    expect(canPrefetchInBackground({ effectiveType: "4g" })).toBe(true);
    expect(canPrefetchInBackground(undefined)).toBe(true);
  });
});

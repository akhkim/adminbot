// Loads a page's code before the click that needs it.
//
// Every lazily loaded page registers the tabs it draws (lazy-view.ts). Pointing at, focusing or
// touching a sidebar link starts that page's download, so the click that follows usually finds the
// module already there; and once the first page has settled, the pages in the viewer's own sidebar
// are fetched one at a time while the browser is idle. Only code is fetched here -- never data --
// and only for tabs the sidebar actually offers this viewer.

type Prefetch = () => void;

const prefetchersByTab = new Map<string, Set<Prefetch>>();
const navTabs = new Set<string>();
// Tabs the idle pass has already dealt with; the sidebar re-announces every link on every render.
const idleHandled = new Set<string>();
let idleScheduled = false;

// Long enough after first paint that the page in front has its own code and data.
const IDLE_START_DELAY_MS = 2_500;
// One module at a time, with a breath between them, so parsing never lands in one long task.
const IDLE_STEP_DELAY_MS = 350;

export function registerPagePrefetch(tabs: readonly string[], prefetch: Prefetch): void {
  for (const tab of tabs) {
    const existing = prefetchersByTab.get(tab);
    if (existing) {
      existing.add(prefetch);
    } else {
      prefetchersByTab.set(tab, new Set([prefetch]));
    }
  }
}

/** Starts loading the code for one tab. Safe to call any number of times. */
export function prefetchTab(tab: string): void {
  for (const prefetch of prefetchersByTab.get(tab) ?? []) {
    prefetch();
  }
}

type ConnectionHint = { saveData?: boolean; effectiveType?: string };

/** False when the viewer asked to save data or is on a connection too slow to spend on guesses. */
export function canPrefetchInBackground(
  connection: ConnectionHint | undefined = (
    globalThis.navigator as { connection?: ConnectionHint } | undefined
  )?.connection,
): boolean {
  if (!connection) {
    return true;
  }
  return !connection.saveData && !/(^|-)2g$/.test(connection.effectiveType ?? "");
}

type IdleScheduler = {
  delay: (run: () => void, ms: number) => void;
  idle: (run: () => void) => void;
  allowed: () => boolean;
};

const defaultScheduler: IdleScheduler = {
  delay: (run, ms) => void globalThis.setTimeout(run, ms),
  idle: (run) => {
    const request = (
      globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }
    ).requestIdleCallback;
    if (request) {
      request(run, { timeout: 4_000 });
    } else {
      globalThis.setTimeout(run, 200);
    }
  },
  allowed: () => canPrefetchInBackground(),
};

/**
 * Called for every link the sidebar draws. The first new tab arms the idle pass; tabs that appear
 * later (a role resolved, a group expanded) are picked up because the pass reads the live queue.
 */
export function notePrefetchableNavTab(tab: string, scheduler: IdleScheduler = defaultScheduler) {
  if (idleHandled.has(tab)) {
    return;
  }
  navTabs.add(tab);
  if (idleScheduled) {
    return;
  }
  idleScheduled = true;
  const step = () => {
    if (!scheduler.allowed()) {
      idleScheduled = false;
      return;
    }
    for (const next of navTabs) {
      navTabs.delete(next);
      idleHandled.add(next);
      if (prefetchersByTab.has(next)) {
        prefetchTab(next);
        scheduler.delay(() => scheduler.idle(step), IDLE_STEP_DELAY_MS);
        return;
      }
    }
    // Queue drained; a tab that joins the sidebar later arms a new pass.
    idleScheduled = false;
  };
  scheduler.delay(() => scheduler.idle(step), IDLE_START_DELAY_MS);
}

export function resetPagePrefetchForTest(): void {
  prefetchersByTab.clear();
  navTabs.clear();
  idleHandled.clear();
  idleScheduled = false;
}

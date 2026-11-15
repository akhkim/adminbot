// Asks for a page's first read before the click that needs it.
//
// page-prefetch.ts fetches a page's code on the way to it; this does the same for the one read the
// page is certain to make. Pointing at, focusing or touching a sidebar link starts that read after
// a short pause (so sweeping the pointer down the sidebar asks for nothing), and choosing a tab
// starts it at once, beside the download of the page's code rather than after it. The page's own
// loader then joins the request or takes its answer (prefetchAuthedRead in auth/session.ts), so
// nothing is fetched twice.
//
// Only reads that are cheap for the service belong here. The heavy ones are refused by name below,
// whatever a page registers.
import { canPrefetchInBackground } from "./page-prefetch.ts";

/** Starts the read(s) for a tab. Returns nothing: the answer reaches the page through the cache. */
export type PageDataWarmer = () => void;

// Reads that cost the service real work, or pull a large payload. Never asked for on a guess.
const HEAVY_READ_PREFIXES = [
  "/audit",
  "/openreview/",
  "/venue-picker",
  "/venue-papers/",
  "/slack/channels",
] as const;

/** True for a path a hover may ask for ahead of time. */
export function isPrefetchableReadPath(path: string): boolean {
  return !HEAVY_READ_PREFIXES.some(
    (prefix) =>
      path === prefix ||
      path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`) ||
      path.startsWith(`${prefix}?`),
  );
}

// Long enough that a pointer passing over a link on its way elsewhere asks for nothing.
const HOVER_DELAY_MS = 80;
// A second hover or a click straight after the first finds the answer still in hand; asking again
// inside this window would only repeat the request.
const REPEAT_WINDOW_MS = 10_000;

const warmersByTab = new Map<string, PageDataWarmer>();
const lastWarmedAt = new Map<string, number>();
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let hoverTab: string | undefined;

export function registerPageDataPrefetch(tabs: readonly string[], warm: PageDataWarmer): void {
  for (const tab of tabs) {
    warmersByTab.set(tab, warm);
  }
}

function warm(tab: string, now: number): void {
  const warmer = warmersByTab.get(tab);
  if (!warmer) {
    return;
  }
  const last = lastWarmedAt.get(tab);
  if (last !== undefined && now - last < REPEAT_WINDOW_MS) {
    return;
  }
  lastWarmedAt.set(tab, now);
  try {
    warmer();
  } catch {
    // A guess that cannot be made is not an error; the page asks for itself when it opens.
  }
}

/** The viewer chose this tab: its read goes out now, beside the page's code. */
export function prefetchTabDataNow(tab: string, now: number = Date.now()): void {
  cancelPendingTabDataPrefetch();
  warm(tab, now);
}

/**
 * The viewer is pointing at, focusing or touching this tab's link. The read goes out only if they
 * are still there a moment later, and never on a connection that asked to save data.
 */
export function prefetchTabDataOnIntent(
  tab: string,
  allowed: () => boolean = canPrefetchInBackground,
): void {
  if (!warmersByTab.has(tab) || hoverTab === tab) {
    return;
  }
  cancelPendingTabDataPrefetch();
  if (!allowed()) {
    return;
  }
  hoverTab = tab;
  hoverTimer = setTimeout(() => {
    hoverTimer = undefined;
    hoverTab = undefined;
    warm(tab, Date.now());
  }, HOVER_DELAY_MS);
}

/** The pointer left the link (or another link took over) before the pause ran out. */
export function cancelPendingTabDataPrefetch(): void {
  if (hoverTimer !== undefined) {
    clearTimeout(hoverTimer);
  }
  hoverTimer = undefined;
  hoverTab = undefined;
}

export function resetPageDataPrefetchForTest(): void {
  cancelPendingTabDataPrefetch();
  warmersByTab.clear();
  lastWarmedAt.clear();
}

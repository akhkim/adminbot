/**
 * Keeps a page's data current without a Refresh button (DESIGN.md rule 12).
 *
 * One ticker for the whole app. The page that is on screen registers what to reload each time it
 * renders; the ticker runs that reload every minute while the browser tab is visible, and once as
 * soon as a hidden tab comes back. A reload is skipped while the viewer is in the middle of
 * something -- a popover open, or focus in a field -- so it never replaces what they are editing,
 * and while the previous reload is still running.
 */
export const QUIET_POLL_INTERVAL_MS = 60_000;

type PollTarget = {
  /** Whether the page that registered this is still the one on screen. */
  active: () => boolean;
  reload: () => Promise<unknown>;
};

let ticker: ReturnType<typeof setInterval> | undefined;
let target: PollTarget | undefined;
let running = false;

function viewerIsBusy(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  if (document.querySelector(":popover-open")) {
    return true;
  }
  const focused = document.activeElement;
  return (
    focused instanceof HTMLInputElement ||
    focused instanceof HTMLTextAreaElement ||
    focused instanceof HTMLSelectElement ||
    (focused instanceof HTMLElement && focused.isContentEditable)
  );
}

/** Run one poll now if nothing stops it. Exported for tests. */
export async function quietPollTick(): Promise<void> {
  const current = target;
  const visible = typeof document === "undefined" || document.visibilityState === "visible";
  if (!current || running || !visible || !current.active() || viewerIsBusy()) {
    return;
  }
  running = true;
  try {
    await current.reload();
  } catch {
    // The page shows its own load errors; a failed background read waits for the next tick.
  } finally {
    running = false;
  }
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") {
    void quietPollTick();
  }
}

/** Register the reload for the page on screen. Call on every render; the latest call wins. */
export function ensureQuietPoll(active: () => boolean, reload: () => Promise<unknown>): void {
  target = { active, reload };
  if (ticker !== undefined || typeof setInterval !== "function") {
    return;
  }
  ticker = setInterval(() => void quietPollTick(), QUIET_POLL_INTERVAL_MS);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
}

/** Stop the ticker and forget the page. For tests. */
export function resetQuietPoll(): void {
  if (ticker !== undefined) {
    clearInterval(ticker);
  }
  ticker = undefined;
  target = undefined;
  running = false;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
}

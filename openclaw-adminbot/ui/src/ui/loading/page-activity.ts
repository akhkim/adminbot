// What the viewer is waiting on right now, for the thin progress line at the top of the page.
//
// Work counts only when the viewer asked for it: it starts within a moment of a click, a key
// press or a navigation, or while such work is already running (a page load is usually a short
// chain of reads). Background polling starts with no gesture behind it and so never draws the
// line -- a bar that flickers on its own teaches people to ignore it.

// A gesture explains the work that starts this soon after it.
const INTENT_WINDOW_MS = 2_000;

type Listener = (active: number) => void;

let active = 0;
let lastIntentAt = Number.NEGATIVE_INFINITY;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    listener(active);
  }
}

/** The viewer just did something (clicked, typed, navigated); work that follows is theirs. */
export function notePageIntent(now: number = Date.now()): void {
  lastIntentAt = now;
}

/**
 * Marks the start of work the viewer may be waiting on. Returns the function that ends it; calling
 * it twice is harmless. Work nobody asked for returns a no-op and is never counted.
 */
export function beginPageActivity(now: number = Date.now()): () => void {
  if (active === 0 && now - lastIntentAt > INTENT_WINDOW_MS) {
    return () => undefined;
  }
  active += 1;
  emit();
  let ended = false;
  return () => {
    if (ended) {
      return;
    }
    ended = true;
    active = Math.max(0, active - 1);
    emit();
  };
}

/** Counts a promise as page activity until it settles; the promise itself is returned unchanged. */
export function trackPageActivity<T>(work: Promise<T>): Promise<T> {
  const end = beginPageActivity();
  void work.then(end, end);
  return work;
}

export function pageActivityCount(): number {
  return active;
}

export function subscribePageActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetPageActivityForTest(): void {
  active = 0;
  lastIntentAt = Number.NEGATIVE_INFINITY;
  listeners.clear();
}

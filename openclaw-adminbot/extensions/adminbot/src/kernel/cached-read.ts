// One slow outbound read (Slack, OpenReview, a subprocess), kept for a while and shared.
//
// Three things a page load should never pay for: asking again for an answer it was given a moment
// ago, waiting on a refresh when a slightly older answer would do, and starting a second copy of a
// read that is already on its way. Nothing here knows what is being read.

export type CachedReadOptions<T> = {
  /** How long an answer is handed back without asking again. */
  freshMs: number;
  /**
   * How long past `freshMs` an answer may still be handed back while a new one is fetched behind
   * it. Zero (the default) means an answer older than `freshMs` is always waited for.
   */
  staleMs?: number;
  /** False keeps an answer out of the cache: an empty or failed result that should be retried. */
  keep?: (value: T) => boolean;
  now?: () => number;
};

export type CachedRead<T> = {
  read(): Promise<T>;
  /** Forget the kept answer, and do not keep the one a read already under way comes back with. */
  invalidate(): void;
};

/**
 * Wraps `load` so callers share one answer and one read in flight.
 *
 * A failed load is never kept: the next caller asks again, because the usual cause is a token or a
 * scope somebody is in the middle of fixing. A failed background refresh leaves the older answer
 * in place until it is too old to serve, and is otherwise silent -- the caller it would have
 * failed for was already answered.
 */
export function createCachedRead<T>(
  load: () => Promise<T>,
  options: CachedReadOptions<T>,
): CachedRead<T> {
  const now = options.now ?? (() => Date.now());
  const staleMs = options.staleMs ?? 0;
  let kept: { at: number; value: T } | undefined;
  let inFlight: Promise<T> | undefined;
  // Bumped by invalidate(), so a read that started before a write cannot put its answer back.
  let generation = 0;

  const refresh = (): Promise<T> => {
    if (inFlight) {
      return inFlight;
    }
    const startedIn = generation;
    const pending = load()
      .then((value) => {
        if (startedIn === generation && (options.keep?.(value) ?? true)) {
          kept = { at: now(), value };
        }
        return value;
      })
      .finally(() => {
        if (inFlight === pending) {
          inFlight = undefined;
        }
      });
    inFlight = pending;
    return pending;
  };

  return {
    read() {
      if (kept) {
        const age = now() - kept.at;
        if (age < options.freshMs) {
          return Promise.resolve(kept.value);
        }
        if (age < options.freshMs + staleMs) {
          refresh().catch(() => {});
          return Promise.resolve(kept.value);
        }
      }
      return refresh();
    },
    invalidate() {
      generation += 1;
      kept = undefined;
      inFlight = undefined;
    },
  };
}

/**
 * `items` mapped through `task`, at most `limit` at a time, results in the order of `items`.
 *
 * For a handful of independent slow calls against one host: running them in series costs the sum,
 * and running them all at once is how a rate limit gets tripped.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

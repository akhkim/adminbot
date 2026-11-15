// In-memory request bookkeeping for the signed-in session's GET reads: the last body per URL, so a
// reload can revalidate with If-None-Match and take an empty 304, and the read currently in flight
// per URL, so two loaders on one page share a request instead of each sending it.
//
// Both are keyed by session token as well as URL. The service's ETag is a hash of the bytes that
// caller was sent after its role projection (see sendJson), so a tag is only ever meaningful for
// the session that received it; a View-as or a sign-in under another account starts empty. Nothing
// here is written to storage -- it is personal data, and it dies with the tab or the session.

type RememberedRead = { etag: string; text: string; url: string };

// Enough for every page's reads plus a few roster searches; a long session paging through search
// results must not grow without bound, so the oldest entry goes first.
const MAX_REMEMBERED_READS = 200;

// How long a pending read stays joinable. A read still pending past this has most likely stalled
// on a dead connection; later loaders start their own rather than wait on it. Generous enough that
// a slow first load of a large roster is still shared.
const JOIN_WINDOW_MS = 15_000;

const remembered = new Map<string, RememberedRead>();
const inFlight = new Map<string, { promise: Promise<unknown>; startedAt: number }>();

// A read fetched ahead of the loader that needs it (the profile read that starts beside the
// session check on boot). It is handed to exactly one caller, and only for a few seconds, so it
// is never "the cache": every later read goes to the service as before.
const WARM_WINDOW_MS = 5_000;
const warm = new Map<string, { value: unknown; keptAt: number }>();
// Bumped by every write and every change of session. A prefetch that started before the bump
// may hold the state from before it and is dropped when it lands.
let warmEpoch = 0;

function readKey(token: string | null, url: string): string {
  return `${token ?? ""}\n${url}`;
}

export function rememberedRead(token: string | null, url: string): RememberedRead | undefined {
  const key = readKey(token, url);
  const entry = remembered.get(key);
  if (entry) {
    // Refresh recency so the pages in use are the last to be dropped.
    remembered.delete(key);
    remembered.set(key, entry);
  }
  return entry;
}

export function rememberRead(token: string | null, url: string, entry: RememberedRead): void {
  const key = readKey(token, url);
  remembered.delete(key);
  remembered.set(key, entry);
  while (remembered.size > MAX_REMEMBERED_READS) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    remembered.delete(oldest);
  }
}

export function forgetRead(token: string | null, url: string): void {
  remembered.delete(readKey(token, url));
}

/**
 * One request per session and URL at a time.
 *
 * A caller that arrives while the same read is pending gets that read's promise rather than a
 * second request, unless that read has been pending past JOIN_WINDOW_MS. `forgetReadsInFlight` drops the bookkeeping after any write, so a reload that a
 * save triggers never joins a read that started before the save landed.
 */
export function sharedRead<T>(
  token: string | null,
  url: string,
  start: () => Promise<T>,
): Promise<T> {
  const key = readKey(token, url);
  const pending = inFlight.get(key);
  if (pending && Date.now() - pending.startedAt < JOIN_WINDOW_MS) {
    return pending.promise as Promise<T>;
  }
  const entry = { promise: undefined as unknown as Promise<T>, startedAt: Date.now() };
  entry.promise = start().finally(() => {
    if (inFlight.get(key) === entry) {
      inFlight.delete(key);
    }
  });
  inFlight.set(key, entry);
  return entry.promise;
}

export function forgetReadsInFlight(): void {
  inFlight.clear();
  warm.clear();
  warmEpoch += 1;
}

/** Sign-out, View-as, and any change of session token. */
export function forgetSessionReads(): void {
  remembered.clear();
  inFlight.clear();
  warm.clear();
  warmEpoch += 1;
}

/** Captured when a prefetch starts and handed back to `keepWarmRead` when it lands. */
export function currentWarmEpoch(): number {
  return warmEpoch;
}

/**
 * Keeps a prefetched read for the one loader about to ask for it. Dropped instead when a write or
 * a change of session happened since `epoch` was captured. Callers keep successful reads only: a
 * refusal or an error is never held, so the loader's own request reports the real state.
 */
export function keepWarmRead(
  token: string | null,
  url: string,
  value: unknown,
  epoch: number,
  now: number = Date.now(),
): void {
  if (epoch !== warmEpoch) {
    return;
  }
  warm.set(readKey(token, url), { value, keptAt: now });
}

/** The prefetched read for this session and URL, once, if it is still within its few seconds. */
export function takeWarmRead<T>(
  token: string | null,
  url: string,
  now: number = Date.now(),
): T | undefined {
  const key = readKey(token, url);
  const entry = warm.get(key);
  if (!entry) {
    return undefined;
  }
  warm.delete(key);
  return now - entry.keptAt <= WARM_WINDOW_MS ? (entry.value as T) : undefined;
}

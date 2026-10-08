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

const remembered = new Map<string, RememberedRead>();
const inFlight = new Map<string, Promise<unknown>>();

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
 * second request. `forgetReadsInFlight` drops the bookkeeping after any write, so a reload that a
 * save triggers never joins a read that started before the save landed.
 */
export function sharedRead<T>(token: string | null, url: string, start: () => Promise<T>): Promise<T> {
  const key = readKey(token, url);
  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) {
    return pending;
  }
  const promise = start().finally(() => {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key);
    }
  });
  inFlight.set(key, promise);
  return promise;
}

export function forgetReadsInFlight(): void {
  inFlight.clear();
}

/** Sign-out, View-as, and any change of session token. */
export function forgetSessionReads(): void {
  remembered.clear();
  inFlight.clear();
}

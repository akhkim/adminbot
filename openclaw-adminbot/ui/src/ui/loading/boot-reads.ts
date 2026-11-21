// Reads the HTML page sends before the app's code has arrived.
//
// On a cold load the browser fetches the HTML, then the entry chunk and its imports, and only then
// can a loader ask the service for the page's data; behind the tunnel each of those is a round
// trip of a quarter of a second or more. The inline script in ui/index.html starts the current
// route's first reads while the code downloads, using the stored session token and the plan this
// module writes below. The loaders then take those responses instead of sending the same GETs.
//
// The plan holds paths only: no token and no response data. A response is taken at most once,
// only by a request for the exact same URL with the same token, and only while it is young, so
// a stale plan or a changed session costs at most a wasted request, never someone else's answer.

/** localStorage key the inline script in ui/index.html reads. Keep the two in step. */
export const BOOT_READS_STORAGE_KEY = "openclaw.adminbot.boot-reads.v1";

/** A boot response older than this is left alone; the loader asks afresh. */
const BOOT_READ_MAX_AGE_MS = 15_000;

export type BootReadPlan = {
  v: 1;
  /** The AdminBot origin the app resolved last time; the script sends nothing elsewhere. */
  base: string;
  /** Authenticated GETs every signed-in route opens with. */
  always: string[];
  /** Route pathname (with the app's base path) to the GETs that page opens with. */
  routes: Record<string, string[]>;
};

type BootRead = { token: string; at: number; response: Promise<Response> };

type BootReadWindow = { __adminbotBootReads?: Record<string, BootRead> };

function bootReads(): Record<string, BootRead> | undefined {
  return (globalThis as BootReadWindow).__adminbotBootReads;
}

/** Saves the plan the next cold load of this browser starts its reads from. */
export function rememberBootReadPlan(plan: BootReadPlan, storage: Storage | null): void {
  try {
    storage?.setItem(BOOT_READS_STORAGE_KEY, JSON.stringify(plan));
  } catch {
    // Storage full or blocked: the next load just starts its reads from the app as before.
  }
}

/**
 * The response the HTML page already requested for this URL with this token, handed over once.
 * Undefined when there is none, it was sent with another token, or it is too old to trust.
 */
export function takeBootResponse(
  url: string,
  token: string | null,
  now: number = Date.now(),
): Promise<Response> | undefined {
  const reads = bootReads();
  const read = reads?.[url];
  if (!reads || !read) {
    return undefined;
  }
  delete reads[url];
  if (!token || read.token !== token || now - read.at > BOOT_READ_MAX_AGE_MS) {
    return undefined;
  }
  return read.response;
}

/** Drops every boot response not yet taken: the session they were sent for has changed. */
export function forgetBootResponses(): void {
  const reads = bootReads();
  if (!reads) {
    return;
  }
  for (const url of Object.keys(reads)) {
    delete reads[url];
  }
}

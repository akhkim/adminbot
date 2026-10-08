// The session side of the on-disk read store (offline/read-store.ts): which session a stored
// read belongs to, when authedJson may read or write one, and when they are wiped.
//
// A read is written to disk only if its path is on the store's allowlist, it came back 200 for a
// session token, and that session is not a View-as. An admin viewing as somebody else is looking
// at another member's data on the admin's own device; none of it is kept.

import {
  type OfflineRead,
  type OfflineReadScope,
  isOfflineReadPath,
  offlineReadGeneration,
  readOfflineRead,
  storeOfflineRead,
  touchOfflineRead,
  wipeOfflineReads,
} from "../offline/read-store.ts";

export type { OfflineRead, OfflineReadScope };

async function principalKeyFor(token: string): Promise<string | undefined> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    return undefined;
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    // Offline storage must never make an otherwise-valid online request unusable. If the browser
    // cannot derive a non-secret session identity, fail closed by disabling cache/outbox.
    return undefined;
  }
}

/** The non-secret identity offline rows are filed under: a hash of the session token. */
export async function resolveOfflineScope(
  baseUrl: string,
  token: string | null,
): Promise<OfflineReadScope | undefined> {
  if (!token) return undefined;
  const principalKey = await principalKeyFor(token);
  return principalKey ? { baseUrl: baseUrl.replace(/\/+$/u, ""), principalKey } : undefined;
}

/** What a GET needs to know before it goes out, captured so a wipe mid-flight is noticed. */
export type OwnReadContext = {
  scope: OfflineReadScope;
  path: string;
  generation: number;
};

export async function ownReadContext(
  baseUrl: string,
  path: string,
  token: string | null,
  viewingAs: boolean,
): Promise<OwnReadContext | undefined> {
  if (!token || viewingAs || !isOfflineReadPath(path)) {
    return undefined;
  }
  const generation = offlineReadGeneration();
  const scope = await resolveOfflineScope(baseUrl, token);
  return scope ? { scope, path, generation } : undefined;
}

/** The stored copy, for If-None-Match on the first read after a page refresh. */
export async function storedOwnRead(context: OwnReadContext): Promise<OfflineRead | undefined> {
  return await readOfflineRead(context.scope, context.path).catch(() => undefined);
}

/** A 200 with this body: queue it for disk. Fire-and-forget; unchanged bytes write nothing. */
export function keepOwnRead(context: OwnReadContext, text: string, etag: string | null): void {
  void storeOfflineRead(context.scope, context.path, text, etag, {
    generation: context.generation,
  }).catch(() => {});
}

/** A 304 on the stored copy: at most a timestamp refresh, usually nothing. */
export function confirmOwnRead(context: OwnReadContext, read: OfflineRead): void {
  void touchOfflineRead(context.scope, context.path, read, {
    generation: context.generation,
  }).catch(() => {});
}

/**
 * Delete stored reads, keeping only those of `keepToken`'s session if one is given. Sign-out,
 * View-as and token changes pass through saveStoredMemberSession / clearStoredMemberSession, the
 * same place the in-memory reads are forgotten (forgetSessionReads).
 */
export function forgetOfflineReads(keepToken?: string | null): void {
  void wipeOfflineReads(keepToken ? principalKeyFor(keepToken) : undefined).catch(() => {});
}

// The on-disk copy of the signed-in member's own reads, for offline use and a warm start after a
// page refresh.
//
// What may be stored is an allowlist, and the default is deny. Before this store existed every
// successful GET was written to IndexedDB -- admin queues, the full roster, sensitive notes,
// pending proposals -- with no expiry and no wipe at sign-out, so a shared or lost laptop kept
// whatever its last admin had opened. Only reads that are the member's own data and that an
// offline feature actually draws are kept here; everything else lives in memory only
// (auth/read-cache.ts) and dies with the tab.
//
// The store is bounded three ways: an entry over MAX_ENTRY_CHARS is never written, the total is
// held under MAX_TOTAL_CHARS by evicting the oldest entry first, and an entry older than
// OFFLINE_READ_TTL_MS reads as missing and is deleted.
//
// Writes are off the render path and minimal. A read whose bytes did not change (a 304, or a 200
// carrying the ETag already stored) writes nothing; writes that land together are batched into
// one transaction on a short timer; the database connection is opened once (offline-db.ts).

import { GET_STORE, hasIndexedDb, openOfflineDb } from "./offline-db.ts";

export type OfflineReadScope = { baseUrl: string; principalKey: string };

/**
 * GET paths whose bodies may be written to disk, each the signed-in member's own data:
 *
 * - `/offline-identity` is not a route. It is the session snapshot fetchMemberSession falls back
 *   to when the service is unreachable (member id, privilege, onboarding; never a credential),
 *   which is what lets a reopened tab know who is signed in while offline.
 * - `/lab/members/self` is the viewer's own profile, which the Dashboard and Profile draw first.
 * - `/papers?scope=mine` is the viewer's own papers (filed, mentored or authored), which the
 *   Profile and a member's Dashboard draw. The unscoped `/papers` is the lab's list and is not here.
 *
 * Working drafts are not in this store at all: offline/draft-sync.ts keeps them in their own
 * database, scoped by member rather than session token.
 */
export const OFFLINE_READ_PATHS: ReadonlySet<string> = new Set([
  "/offline-identity",
  "/lab/members/self",
  "/papers?scope=mine",
]);

/** A week: long enough to cover a trip taken offline, short enough that old data does not linger. */
export const OFFLINE_READ_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Sizes are string lengths. The bodies are JSON, overwhelmingly ASCII, so this tracks bytes. A
// member with a thousand papers of their own is ~1.5M; anything bigger stays memory-only.
export const MAX_ENTRY_CHARS = 2 * 1024 * 1024;
export const MAX_TOTAL_CHARS = 5 * 1024 * 1024;
// Bursts of reads land within a frame or two of each other; one transaction takes them all.
const FLUSH_DELAY_MS = 25;

type StoredRead = {
  key: string;
  base_url: string;
  principal_key: string;
  path: string;
  text: string;
  etag: string | null;
  // The ETag when the service sent one, else a hash of the text: what "unchanged" compares.
  fingerprint: string;
  size: number;
  stored_at: number;
};
type ReadMeta = Omit<StoredRead, "text">;

export type OfflineRead = { text: string; etag: string | null };
export type StoreOutcome = "denied" | "too-large" | "stale" | "unchanged" | "queued";

const memoryRows = new Map<string, StoredRead>();
const pending = new Map<string, StoredRead>();
const pendingDeletes = new Set<string>();
let meta: Map<string, ReadMeta> | null = null;
let metaLoading: Promise<Map<string, ReadMeta>> | null = null;
let generation = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> = Promise.resolve();
const stats = { transactions: 0, puts: 0, deletes: 0 };

export function isOfflineReadPath(path: string): boolean {
  return OFFLINE_READ_PATHS.has(path);
}

/** Disk transactions and rows written since the page loaded (or the last reset). */
export function offlineReadStoreStats(): { transactions: number; puts: number; deletes: number } {
  return { ...stats };
}

/**
 * A counter bumped by every wipe. A read captures it before its request goes out and hands it
 * back with the write, so a response that arrives after sign-out or a View-as switch is dropped
 * instead of being written for a session that has already been wiped.
 */
export function offlineReadGeneration(): number {
  return generation;
}

function readKey(scope: OfflineReadScope, path: string): string {
  return `${scope.principalKey}|${scope.baseUrl}|${path}`;
}

function fingerprintOf(text: string, etag: string | null): string {
  if (etag) {
    return `etag:${etag}`;
  }
  // FNV-1a: only ever compared with the previous copy of the same entry, so collisions just
  // cost a skipped write of a value that is at worst one revision behind.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv:${text.length}:${(hash >>> 0).toString(16)}`;
}

function isExpired(storedAt: number, now = Date.now()): boolean {
  return !(storedAt <= now && now - storedAt < OFFLINE_READ_TTL_MS);
}

/** A row from disk is used only if it has every field this version writes and is still fresh. */
function isUsableRow(row: unknown, now = Date.now()): row is StoredRead {
  const candidate = row as Partial<StoredRead> | null;
  return Boolean(
    candidate &&
    typeof candidate.key === "string" &&
    typeof candidate.base_url === "string" &&
    typeof candidate.principal_key === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.text === "string" &&
    typeof candidate.fingerprint === "string" &&
    typeof candidate.size === "number" &&
    candidate.size <= MAX_ENTRY_CHARS &&
    typeof candidate.stored_at === "number" &&
    (candidate.etag === null || typeof candidate.etag === "string") &&
    isOfflineReadPath(candidate.path) &&
    !isExpired(candidate.stored_at, now),
  );
}

function metaOf(row: StoredRead): ReadMeta {
  const { text: _text, ...rest } = row;
  return rest;
}

// Loaded once per page: the metadata of every usable row, so a miss or an unchanged write is
// answered without touching disk. Rows that are expired, over the cap, off the allowlist or
// missing fields are deleted in the same pass.
async function loadMeta(): Promise<Map<string, ReadMeta>> {
  const now = Date.now();
  const loaded = new Map<string, ReadMeta>();
  if (!hasIndexedDb()) {
    for (const [key, row] of memoryRows) {
      if (isUsableRow(row, now)) loaded.set(key, metaOf(row));
      else memoryRows.delete(key);
    }
    return loaded;
  }
  const db = await openOfflineDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(GET_STORE, "readwrite");
    const cursorRequest = transaction.objectStore(GET_STORE).openCursor();
    cursorRequest.addEventListener("success", () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      if (isUsableRow(cursor.value, now)) {
        loaded.set(cursor.value.key, metaOf(cursor.value));
      } else {
        cursor.delete();
        stats.deletes += 1;
      }
      cursor.continue();
    });
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  return loaded;
}

async function ensureMeta(): Promise<Map<string, ReadMeta>> {
  while (!meta) {
    const startedAt = generation;
    metaLoading ??= loadMeta();
    const loading = metaLoading;
    try {
      const loaded = await loading;
      // A wipe while this was loading may have deleted what it read; load again.
      if (startedAt === generation && metaLoading === loading) {
        meta = loaded;
      }
    } finally {
      if (metaLoading === loading) metaLoading = null;
    }
  }
  return meta;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushOfflineReads().catch(() => {});
  }, FLUSH_DELAY_MS);
}

async function commit(puts: StoredRead[], deletes: string[], forGeneration: number): Promise<void> {
  if (!hasIndexedDb()) {
    if (forGeneration !== generation) return;
    for (const key of deletes) memoryRows.delete(key);
    for (const row of puts) memoryRows.set(row.key, row);
    stats.transactions += 1;
    stats.puts += puts.length;
    stats.deletes += deletes.length;
    return;
  }
  const db = await openOfflineDb();
  // Checked after the await and immediately before the transaction is created: a wipe that ran
  // in between has already dropped these rows from `pending`, and must not see them land after.
  if (forGeneration !== generation) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(GET_STORE, "readwrite");
      const store = transaction.objectStore(GET_STORE);
      for (const key of deletes) store.delete(key);
      for (const row of puts) store.put(row);
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } catch (error) {
    // The index already lists these rows (storeOfflineRead records them when it queues). Left as
    // is, a quota abort would make every later copy of the same bytes "unchanged" and never retried
    // for the life of the page; reload it from what is actually on disk instead.
    if (forGeneration === generation) meta = null;
    throw error;
  }
  stats.transactions += 1;
  stats.puts += puts.length;
  stats.deletes += deletes.length;
}

/** Write everything queued now, in one transaction. Resolves when it has committed. */
export function flushOfflineReads(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const puts = [...pending.values()];
  const deletes = [...pendingDeletes];
  pending.clear();
  pendingDeletes.clear();
  if (puts.length === 0 && deletes.length === 0) {
    return flushing;
  }
  const forGeneration = generation;
  flushing = flushing.catch(() => {}).then(() => commit(puts, deletes, forGeneration));
  return flushing;
}

function evictToFit(index: Map<string, ReadMeta>, keep: string): void {
  let total = 0;
  for (const row of index.values()) total += row.size;
  const oldestFirst = [...index.values()].toSorted((a, b) => a.stored_at - b.stored_at);
  for (const row of oldestFirst) {
    if (total <= MAX_TOTAL_CHARS) break;
    if (row.key === keep) continue;
    index.delete(row.key);
    pending.delete(row.key);
    pendingDeletes.add(row.key);
    total -= row.size;
  }
}

/**
 * Queue an own-data read for disk. Returns what happened, so callers and tests can tell a
 * refused path from an unchanged body. `options.generation` is the value offlineReadGeneration()
 * had when the request went out; `options.immediate` writes now rather than on the batch timer,
 * for the session snapshot that must be on disk before the session switch that follows it.
 */
export async function storeOfflineRead(
  scope: OfflineReadScope,
  path: string,
  text: string,
  etag: string | null,
  options: { generation?: number; immediate?: boolean } = {},
): Promise<StoreOutcome> {
  if (!isOfflineReadPath(path)) {
    return "denied";
  }
  const forGeneration = options.generation ?? generation;
  if (forGeneration !== generation) {
    return "stale";
  }
  const key = readKey(scope, path);
  const index = await ensureMeta();
  if (forGeneration !== generation) {
    return "stale";
  }
  if (text.length > MAX_ENTRY_CHARS) {
    // The copy on disk is now behind the service and cannot be replaced; drop it.
    if (index.delete(key) || pending.delete(key)) {
      pendingDeletes.add(key);
      scheduleFlush();
    }
    return "too-large";
  }
  const fingerprint = fingerprintOf(text, etag);
  const now = Date.now();
  const existing = pending.get(key) ?? index.get(key);
  // Unchanged bytes are not rewritten. The age is refreshed at most once per half-TTL so a read
  // the service keeps confirming does not expire while it is in use.
  if (existing?.fingerprint === fingerprint && now - existing.stored_at < OFFLINE_READ_TTL_MS / 2) {
    return "unchanged";
  }
  const row: StoredRead = {
    key,
    base_url: scope.baseUrl,
    principal_key: scope.principalKey,
    path,
    text,
    etag,
    fingerprint,
    size: text.length,
    stored_at: now,
  };
  pending.set(key, row);
  pendingDeletes.delete(key);
  index.set(key, metaOf(row));
  evictToFit(index, key);
  if (options.immediate) {
    await flushOfflineReads();
  } else {
    scheduleFlush();
  }
  return "queued";
}

/**
 * The service confirmed (304) that the stored copy is current. Rewrites only the timestamp, and
 * only when it is past half its life; the common case writes nothing.
 */
export async function touchOfflineRead(
  scope: OfflineReadScope,
  path: string,
  read: OfflineRead,
  options: { generation?: number } = {},
): Promise<StoreOutcome> {
  return await storeOfflineRead(scope, path, read.text, read.etag, options);
}

/** The stored copy of an own-data read, or undefined if there is none, it expired, or the path is not allowlisted. */
export async function readOfflineRead(
  scope: OfflineReadScope,
  path: string,
): Promise<OfflineRead | undefined> {
  if (!isOfflineReadPath(path)) {
    return undefined;
  }
  const key = readKey(scope, path);
  const queued = pending.get(key);
  if (queued) {
    return { text: queued.text, etag: queued.etag };
  }
  const index = await ensureMeta();
  const known = index.get(key);
  if (!known) {
    return undefined;
  }
  if (isExpired(known.stored_at)) {
    index.delete(key);
    pendingDeletes.add(key);
    scheduleFlush();
    return undefined;
  }
  const row = hasIndexedDb()
    ? await (async () => {
        const db = await openOfflineDb();
        return await new Promise<unknown>((resolve, reject) => {
          const request = db.transaction(GET_STORE, "readonly").objectStore(GET_STORE).get(key);
          request.addEventListener("success", () => resolve(request.result));
          request.addEventListener("error", () => reject(request.error));
        });
      })()
    : memoryRows.get(key);
  if (!isUsableRow(row)) {
    index.delete(key);
    return undefined;
  }
  return { text: row.text, etag: row.etag };
}

/**
 * Delete stored reads: every one, or every one not belonging to `keepPrincipal`.
 *
 * Called at sign-out, at View-as start and stop, on any change of session token, and when the
 * service answers 401. Anything queued is dropped synchronously and the generation moves on, so
 * a response still in flight for the departing session cannot be written after this.
 */
export async function wipeOfflineReads(
  keepPrincipal?: string | Promise<string | undefined>,
): Promise<void> {
  generation += 1;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pending.clear();
  pendingDeletes.clear();
  meta = null;
  const keep = await keepPrincipal;
  if (!hasIndexedDb()) {
    for (const [key, row] of memoryRows) {
      if (row.principal_key !== keep) memoryRows.delete(key);
    }
    return;
  }
  const db = await openOfflineDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(GET_STORE, "readwrite");
    const store = transaction.objectStore(GET_STORE);
    if (keep === undefined) {
      store.clear();
    } else {
      const cursorRequest = store.openCursor();
      cursorRequest.addEventListener("success", () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if ((cursor.value as Partial<StoredRead>).principal_key !== keep) cursor.delete();
        cursor.continue();
      });
    }
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  stats.transactions += 1;
  // Metadata loaded while the delete was pending may list rows it removed.
  meta = null;
}

/** Tests: an empty store, fresh counters, and metadata reloaded on next use. */
export async function resetOfflineReadStore(): Promise<void> {
  memoryRows.clear();
  await wipeOfflineReads();
  stats.transactions = 0;
  stats.puts = 0;
  stats.deletes = 0;
}

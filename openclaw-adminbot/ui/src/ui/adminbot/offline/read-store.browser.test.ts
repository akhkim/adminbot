// The on-disk read store against real IndexedDB in Chromium: the first open of this version
// purging what the old code wrote, the allowlist, expiry, write counts and the single connection.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GET_STORE,
  OFFLINE_DB_NAME,
  OUTBOX_STORE,
  closeOfflineDb,
  offlineDbOpenCount,
} from "./offline-db.ts";
import { listAdminBotOutbox } from "./outbox.ts";
import {
  OFFLINE_READ_TTL_MS,
  flushOfflineReads,
  offlineReadStoreStats,
  readOfflineRead,
  resetOfflineReadStore,
  storeOfflineRead,
  wipeOfflineReads,
} from "./read-store.ts";

const BASE = "https://aurora.test";
const ADMIN = { baseUrl: BASE, principalKey: "legacy-admin" };
const MEMBER = { baseUrl: BASE, principalKey: "member" };

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function rawRows(store: string): Promise<unknown[]> {
  const db = await request(indexedDB.open(OFFLINE_DB_NAME));
  try {
    return await request(db.transaction(store, "readonly").objectStore(store).getAll());
  } finally {
    db.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("offline read store in real IndexedDB", () => {
  it("purges every legacy GET row on the first open, keeping the outbox", async () => {
    await closeOfflineDb();
    await request(indexedDB.deleteDatabase(OFFLINE_DB_NAME));
    // What the previous release left behind: version 2, every GET body kept, admin data included.
    const legacy = indexedDB.open(OFFLINE_DB_NAME, 2);
    legacy.onupgradeneeded = () => {
      legacy.result.createObjectStore(GET_STORE, { keyPath: "key" });
      legacy.result.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
    };
    const old = await request(legacy);
    const tx = old.transaction([GET_STORE, OUTBOX_STORE], "readwrite");
    for (const path of ["/sensitive-info", "/lab/members", "/lab/members/self"]) {
      tx.objectStore(GET_STORE).put({
        key: `legacy-admin|${BASE}|${path}`,
        base_url: BASE,
        principal_key: "legacy-admin",
        path,
        body: { notes: "admin-only" },
        stored_at: Date.now(),
      });
    }
    tx.objectStore(OUTBOX_STORE).put({
      id: "outbox_1",
      method: "PUT",
      base_url: BASE,
      principal_key: "legacy-admin",
      path: "/lab/members/ada",
      payload: { name: "Ada" },
      created_at: Date.now(),
      retry_count: 0,
      kind: "mutation",
    });
    await new Promise<void>((resolve) => (tx.oncomplete = () => resolve()));
    old.close();

    const opensBefore = offlineDbOpenCount();
    // The first read of the new code opens version 3; the user does nothing.
    await expect(readOfflineRead(ADMIN, "/lab/members/self")).resolves.toBeUndefined();
    await expect(readOfflineRead(ADMIN, "/sensitive-info")).resolves.toBeUndefined();
    expect(await rawRows(GET_STORE)).toEqual([]);
    expect(await listAdminBotOutbox(ADMIN)).toHaveLength(1);
    expect(offlineDbOpenCount()).toBe(opensBefore + 1);
  });

  it("opens the database once for many reads and writes", async () => {
    await resetOfflineReadStore();
    const opens = offlineDbOpenCount();
    for (let i = 0; i < 20; i += 1) {
      await storeOfflineRead(MEMBER, "/lab/members/self", `{"n":${i}}`, `W/"${i}"`);
      await readOfflineRead(MEMBER, "/lab/members/self");
    }
    await flushOfflineReads();
    expect(offlineDbOpenCount()).toBe(opens);
  });

  it("never writes an admin-only path, and batches a burst into one transaction", async () => {
    await resetOfflineReadStore();
    await storeOfflineRead(MEMBER, "/sensitive-info", '{"x":1}', null);
    await storeOfflineRead(MEMBER, "/lab/members", '{"members":[]}', null);
    await Promise.all([
      storeOfflineRead(MEMBER, "/lab/members/self", "a", 'W/"a"'),
      storeOfflineRead(MEMBER, "/papers?scope=mine", "b", 'W/"b"'),
    ]);
    await flushOfflineReads();
    expect(offlineReadStoreStats()).toMatchObject({ transactions: 1, puts: 2 });
    const paths = (await rawRows(GET_STORE)).map((row) => (row as { path: string }).path);
    expect(paths.toSorted()).toEqual(["/lab/members/self", "/papers?scope=mine"]);

    // Same ETag again: nothing written, nothing opened.
    await storeOfflineRead(MEMBER, "/lab/members/self", "a", 'W/"a"');
    await flushOfflineReads();
    expect(offlineReadStoreStats()).toMatchObject({ transactions: 1, puts: 2 });
  });

  it("ignores an expired entry after a reload and deletes it", async () => {
    await resetOfflineReadStore();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await storeOfflineRead(MEMBER, "/lab/members/self", "old", null);
    await flushOfflineReads();
    vi.setSystemTime(Date.now() + OFFLINE_READ_TTL_MS + 1);
    // As after a reload: a fresh connection, and (via a wipe that keeps this session's rows)
    // the metadata dropped, so the next read loads it from disk again.
    await closeOfflineDb();
    await wipeOfflineReads("member");
    await expect(readOfflineRead(MEMBER, "/lab/members/self")).resolves.toBeUndefined();
    expect(await rawRows(GET_STORE)).toEqual([]);
  });

  it("wipes every other session's rows and keeps the named one", async () => {
    await resetOfflineReadStore();
    await storeOfflineRead(MEMBER, "/lab/members/self", "m", null);
    await storeOfflineRead(ADMIN, "/lab/members/self", "a", null);
    await flushOfflineReads();
    await wipeOfflineReads("member");
    await expect(readOfflineRead(ADMIN, "/lab/members/self")).resolves.toBeUndefined();
    await expect(readOfflineRead(MEMBER, "/lab/members/self")).resolves.toEqual({
      text: "m",
      etag: null,
    });
    await wipeOfflineReads();
    expect(await rawRows(GET_STORE)).toEqual([]);
  });
});

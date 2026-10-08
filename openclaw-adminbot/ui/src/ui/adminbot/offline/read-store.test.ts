// @vitest-environment node
// The bounded on-disk read store, through its in-memory fallback (no IndexedDB in node). The same
// rules against real IndexedDB, plus the v3 legacy purge, are in read-store.browser.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ENTRY_CHARS,
  MAX_TOTAL_CHARS,
  OFFLINE_READ_TTL_MS,
  flushOfflineReads,
  offlineReadGeneration,
  offlineReadStoreStats,
  readOfflineRead,
  resetOfflineReadStore,
  storeOfflineRead,
  wipeOfflineReads,
} from "./read-store.ts";

const ADA = { baseUrl: "http://127.0.0.1:8765", principalKey: "ada" };
const MEI = { baseUrl: "http://127.0.0.1:8765", principalKey: "mei" };

beforeEach(async () => {
  await resetOfflineReadStore();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("offline read store", () => {
  it("refuses every path off the allowlist, admin data included", async () => {
    for (const path of [
      "/lab/members",
      "/lab/members?view=summary",
      "/sensitive-info",
      "/papers",
      "/logistics/requests",
      "/proposals",
      "/settings",
    ]) {
      await expect(storeOfflineRead(ADA, path, "{}", null)).resolves.toBe("denied");
      await expect(readOfflineRead(ADA, path)).resolves.toBeUndefined();
    }
    await flushOfflineReads();
    expect(offlineReadStoreStats().puts).toBe(0);
  });

  it("keeps an own read for its session only", async () => {
    await storeOfflineRead(ADA, "/lab/members/self", '{"id":"ada"}', 'W/"1"');
    await flushOfflineReads();
    await expect(readOfflineRead(ADA, "/lab/members/self")).resolves.toEqual({
      text: '{"id":"ada"}',
      etag: 'W/"1"',
    });
    await expect(readOfflineRead(MEI, "/lab/members/self")).resolves.toBeUndefined();
  });

  it("writes nothing when the bytes did not change", async () => {
    await storeOfflineRead(ADA, "/papers?scope=mine", "[1]", 'W/"p1"');
    await flushOfflineReads();
    const before = offlineReadStoreStats();
    await expect(storeOfflineRead(ADA, "/papers?scope=mine", "[1]", 'W/"p1"')).resolves.toBe(
      "unchanged",
    );
    // No ETag: compared by a hash of the text instead.
    await storeOfflineRead(ADA, "/offline-identity", '{"m":1}', null);
    await flushOfflineReads();
    const mid = offlineReadStoreStats();
    await expect(storeOfflineRead(ADA, "/offline-identity", '{"m":1}', null)).resolves.toBe(
      "unchanged",
    );
    await flushOfflineReads();
    expect(offlineReadStoreStats()).toEqual(mid);
    expect(mid.transactions).toBe(before.transactions + 1);
  });

  it("batches a burst of writes into one transaction", async () => {
    await Promise.all([
      storeOfflineRead(ADA, "/lab/members/self", "a", null),
      storeOfflineRead(ADA, "/papers?scope=mine", "b", null),
      storeOfflineRead(ADA, "/offline-identity", "c", null),
    ]);
    await flushOfflineReads();
    expect(offlineReadStoreStats()).toMatchObject({ transactions: 1, puts: 3 });
  });

  it("treats an expired entry as missing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await storeOfflineRead(ADA, "/lab/members/self", "old", null);
    await flushOfflineReads();
    vi.setSystemTime(Date.now() + OFFLINE_READ_TTL_MS + 1);
    await expect(readOfflineRead(ADA, "/lab/members/self")).resolves.toBeUndefined();
  });

  it("skips an entry over the per-entry cap and evicts oldest-first past the total", async () => {
    const huge = "x".repeat(MAX_ENTRY_CHARS + 1);
    await expect(storeOfflineRead(ADA, "/papers?scope=mine", huge, null)).resolves.toBe(
      "too-large",
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    const big = "y".repeat(Math.floor(MAX_TOTAL_CHARS / 3) + 1);
    vi.setSystemTime(1_000_000);
    await storeOfflineRead(ADA, "/lab/members/self", big, null);
    vi.setSystemTime(2_000_000);
    await storeOfflineRead(MEI, "/lab/members/self", big, null);
    vi.setSystemTime(3_000_000);
    await storeOfflineRead(ADA, "/papers?scope=mine", big, null);
    await flushOfflineReads();
    // Three thirds-plus-one overflow the cap; the oldest goes.
    await expect(readOfflineRead(ADA, "/lab/members/self")).resolves.toBeUndefined();
    await expect(readOfflineRead(MEI, "/lab/members/self")).resolves.toBeDefined();
    await expect(readOfflineRead(ADA, "/papers?scope=mine")).resolves.toBeDefined();
  });

  it("wipes everything, or everything but one session", async () => {
    await storeOfflineRead(ADA, "/lab/members/self", "a", null);
    await storeOfflineRead(MEI, "/lab/members/self", "m", null);
    await flushOfflineReads();
    await wipeOfflineReads("mei");
    await expect(readOfflineRead(ADA, "/lab/members/self")).resolves.toBeUndefined();
    await expect(readOfflineRead(MEI, "/lab/members/self")).resolves.toBeDefined();
    await wipeOfflineReads();
    await expect(readOfflineRead(MEI, "/lab/members/self")).resolves.toBeUndefined();
  });

  it("drops a write captured before a wipe", async () => {
    const generation = offlineReadGeneration();
    await storeOfflineRead(ADA, "/lab/members/self", "queued", null);
    await wipeOfflineReads();
    await expect(
      storeOfflineRead(ADA, "/lab/members/self", "late", null, { generation }),
    ).resolves.toBe("stale");
    await flushOfflineReads();
    await expect(readOfflineRead(ADA, "/lab/members/self")).resolves.toBeUndefined();
  });
});

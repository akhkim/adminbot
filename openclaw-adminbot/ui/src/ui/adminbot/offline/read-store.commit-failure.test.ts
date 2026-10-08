// @vitest-environment node
// A disk write that fails (quota, a closed connection) must not leave the store believing the row
// landed. The real-IndexedDB rules are in read-store.browser.test.ts; this fakes the database so a
// transaction can be made to abort on demand.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

type Row = { key: string } & Record<string, unknown>;

const disk = new Map<string, Row>();
const control = { failNextWrite: false };

function fakeTransaction() {
  const listeners = new Map<string, () => void>();
  const ops: Array<() => void> = [];
  let failed = false;
  const transaction = {
    error: null as unknown,
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, listener);
    },
    objectStore() {
      return {
        put(row: Row) {
          if (control.failNextWrite) {
            control.failNextWrite = false;
            failed = true;
          }
          ops.push(() => disk.set(row.key, structuredClone(row)));
        },
        delete(key: string) {
          ops.push(() => disk.delete(key));
        },
        clear() {
          ops.push(() => disk.clear());
        },
        get(key: string) {
          const request = {
            result: undefined as unknown,
            error: null,
            addEventListener(type: string, listener: () => void) {
              if (type === "success") {
                queueMicrotask(() => {
                  request.result = disk.has(key) ? structuredClone(disk.get(key)) : undefined;
                  listener();
                });
              }
            },
          };
          return request;
        },
        openCursor() {
          // No rows to page through in these tests' starting state: report the end at once.
          const request = {
            result: null,
            addEventListener(type: string, listener: () => void) {
              if (type === "success") queueMicrotask(listener);
            },
          };
          return request;
        },
      };
    },
  };
  // Settle after the caller has queued its operations and attached its listeners.
  setTimeout(() => {
    if (failed) {
      transaction.error = new DOMException("quota", "QuotaExceededError");
      listeners.get("abort")?.();
      return;
    }
    for (const op of ops) op();
    listeners.get("complete")?.();
  }, 0);
  return transaction;
}

vi.mock("./offline-db.ts", () => ({
  GET_STORE: "get-cache",
  hasIndexedDb: () => true,
  openOfflineDb: async () => ({ transaction: () => fakeTransaction() }),
}));

// The suite shares one module cache across files (isolate: false): a read-store another file loaded
// first is bound to the real database and would never see the fake. Load a fresh one, and leave
// none of it behind for the files after this one.
vi.resetModules();
const { flushOfflineReads, readOfflineRead, resetOfflineReadStore, storeOfflineRead } =
  await import("./read-store.ts");

afterAll(() => {
  vi.doUnmock("./offline-db.ts");
  vi.resetModules();
});

const ADA = { baseUrl: "http://127.0.0.1:8765", principalKey: "ada" };

beforeEach(async () => {
  control.failNextWrite = false;
  await resetOfflineReadStore();
  disk.clear();
});

describe("a disk write that fails", () => {
  it("is retried by the next read of the same bytes instead of being taken as stored", async () => {
    control.failNextWrite = true;
    await expect(storeOfflineRead(ADA, "/lab/members/self", '{"id":"ada"}', 'W/"1"')).resolves.toBe(
      "queued",
    );
    await expect(flushOfflineReads()).rejects.toThrow();
    expect(disk.size).toBe(0);

    // The service sends the same bytes again: this time they must be written.
    await expect(storeOfflineRead(ADA, "/lab/members/self", '{"id":"ada"}', 'W/"1"')).resolves.toBe(
      "queued",
    );
    await flushOfflineReads();
    await expect(readOfflineRead(ADA, "/lab/members/self")).resolves.toEqual({
      text: '{"id":"ada"}',
      etag: 'W/"1"',
    });
  });

  it("does not wedge later flushes", async () => {
    control.failNextWrite = true;
    await storeOfflineRead(ADA, "/lab/members/self", "{}", null);
    await expect(flushOfflineReads()).rejects.toThrow();
    await storeOfflineRead(ADA, "/papers?scope=mine", "[]", null);
    await flushOfflineReads();
    expect([...disk.keys()]).toEqual(["ada|http://127.0.0.1:8765|/papers?scope=mine"]);
  });
});

// The one IndexedDB connection behind the AdminBot offline stores (read-store.ts, outbox.ts).
//
// Opened once per page and reused: opening per operation cost a full open/upgrade-check/close
// round trip on every cached read and every write, which is most of what a small transaction
// costs. The connection is dropped when another tab upgrades the schema (`versionchange`) or the
// browser closes it, and the next caller opens a fresh one.

export const OFFLINE_DB_NAME = "adminbot-offline";
// v2 scoped rows to an origin and principal. v3 drops the old GET store wholesale: the code
// before it wrote every successful GET body to disk -- admin queues, the full roster, sensitive
// notes -- with no expiry, and none of those rows carry the fields the bounded store needs. The
// outbox is kept: it holds unsent writes, and its rows were already principal-scoped.
export const OFFLINE_DB_VERSION = 3;
export const GET_STORE = "get-cache";
export const OUTBOX_STORE = "outbox";

let connection: Promise<IDBDatabase> | null = null;
let opens = 0;

export function hasIndexedDb(): boolean {
  return typeof globalThis.indexedDB !== "undefined";
}

/** How many times this page opened the database; for tests and the cache report. */
export function offlineDbOpenCount(): number {
  return opens;
}

function upgrade(db: IDBDatabase, oldVersion: number): void {
  // Version 1 rows have neither an origin nor a principal. They cannot be safely assigned to
  // whoever happens to sign in after the upgrade, so discard them rather than risk replaying one
  // member's write or cached response as another member.
  if (oldVersion < 2 && db.objectStoreNames.contains(OUTBOX_STORE)) {
    db.deleteObjectStore(OUTBOX_STORE);
  }
  if (oldVersion < 3 && db.objectStoreNames.contains(GET_STORE)) {
    db.deleteObjectStore(GET_STORE);
  }
  if (!db.objectStoreNames.contains(GET_STORE)) {
    db.createObjectStore(GET_STORE, { keyPath: "key" });
  }
  if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
    db.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
  }
}

export function openOfflineDb(): Promise<IDBDatabase> {
  if (connection) {
    return connection;
  }
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    opens += 1;
    const request = globalThis.indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.addEventListener("upgradeneeded", (event) =>
      upgrade(request.result, (event as IDBVersionChangeEvent).oldVersion),
    );
    request.addEventListener("success", () => {
      const db = request.result;
      // Another tab running newer code needs this connection gone before it can upgrade.
      db.addEventListener("versionchange", () => {
        db.close();
        if (connection === pending) connection = null;
      });
      db.addEventListener("close", () => {
        if (connection === pending) connection = null;
      });
      resolve(db);
    });
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Could not open AdminBot offline storage.")),
    );
  });
  connection = pending;
  pending.catch(() => {
    if (connection === pending) connection = null;
  });
  return pending;
}

/** Run one request in its own transaction and resolve when the transaction commits. */
export async function withOfflineStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openOfflineDb();
  return await new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = run(transaction.objectStore(storeName));
    transaction.addEventListener("complete", () => resolve(request.result));
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("AdminBot offline storage failed.")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("AdminBot offline storage failed.")),
    );
  });
}

/** Close the shared connection; tests use it to simulate a fresh page. */
export async function closeOfflineDb(): Promise<void> {
  const current = connection;
  connection = null;
  if (current) {
    (await current.catch(() => null))?.close();
  }
}

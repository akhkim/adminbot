// Browser-local GET cache and mutation outbox for AdminBot HTTP.
//
// The Control UI is often on a different origin from `:8765`, so a service worker cannot
// intercept those fetches. IndexedDB on this origin is the same idea as Chrome/Docs offline
// and WhatsApp queued sends: reads come from the last successful GET; writes wait until the
// service is reachable again. On-device SLM drafting is an interview-task stub, not wired here.

const DB_NAME = "adminbot-offline";
const DB_VERSION = 2;
const GET_STORE = "get-cache";
const OUTBOX_STORE = "outbox";

export type AdminBotOfflineScope = {
  baseUrl: string;
  principalKey: string;
};

export type OfflineOutboxItem = {
  id: string;
  method: "POST" | "PUT" | "DELETE";
  base_url: string;
  principal_key: string;
  path: string;
  payload?: unknown;
  created_at: number;
  retry_count: number;
  kind: "mutation";
};

type GetCacheEntry = {
  key: string;
  base_url: string;
  principal_key: string;
  path: string;
  body: unknown;
  stored_at: number;
};

const memoryGets = new Map<string, GetCacheEntry>();
const memoryOutbox = new Map<string, OfflineOutboxItem>();

function cacheKey(scope: AdminBotOfflineScope, path: string): string {
  return `${scope.principalKey}|${scope.baseUrl}|${path}`;
}

function belongsToScope(
  item: Pick<OfflineOutboxItem, "base_url" | "principal_key">,
  scope: AdminBotOfflineScope,
): boolean {
  return item.base_url === scope.baseUrl && item.principal_key === scope.principalKey;
}

function hasIndexedDb(): boolean {
  return typeof globalThis.indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase> {
  const factory = globalThis.indexedDB;
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", (event) => {
      const db = request.result;
      // Version 1 rows have neither an origin nor a principal. They cannot be safely assigned to
      // whoever happens to sign in after the upgrade, so discard them rather than risk replaying
      // one member's write or cached response as another member.
      if ((event as IDBVersionChangeEvent).oldVersion < 2) {
        if (db.objectStoreNames.contains(GET_STORE)) {
          db.deleteObjectStore(GET_STORE);
        }
        if (db.objectStoreNames.contains(OUTBOX_STORE)) {
          db.deleteObjectStore(OUTBOX_STORE);
        }
      }
      if (!db.objectStoreNames.contains(GET_STORE)) {
        db.createObjectStore(GET_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Could not open AdminBot offline storage.")),
    );
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  try {
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
  } finally {
    db.close();
  }
}

export async function cacheAdminBotGet(
  scope: AdminBotOfflineScope,
  path: string,
  body: unknown,
): Promise<void> {
  const entry: GetCacheEntry = {
    key: cacheKey(scope, path),
    base_url: scope.baseUrl,
    principal_key: scope.principalKey,
    path,
    body,
    stored_at: Date.now(),
  };
  if (!hasIndexedDb()) {
    memoryGets.set(entry.key, entry);
    return;
  }
  await withStore(GET_STORE, "readwrite", (store) => store.put(entry));
}

export async function readCachedAdminBotGet(
  scope: AdminBotOfflineScope,
  path: string,
): Promise<unknown | undefined> {
  const key = cacheKey(scope, path);
  if (!hasIndexedDb()) {
    return memoryGets.get(key)?.body;
  }
  const entry = await withStore<GetCacheEntry | undefined>(GET_STORE, "readonly", (store) =>
    store.get(key),
  );
  return entry?.body;
}

export async function enqueueAdminBotMutation(
  scope: AdminBotOfflineScope,
  item: Omit<
    OfflineOutboxItem,
    "id" | "base_url" | "principal_key" | "created_at" | "retry_count" | "kind"
  >,
): Promise<OfflineOutboxItem> {
  const row: OfflineOutboxItem = {
    ...item,
    base_url: scope.baseUrl,
    principal_key: scope.principalKey,
    id: `outbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    created_at: Date.now(),
    retry_count: 0,
    kind: "mutation",
  };
  if (!hasIndexedDb()) {
    memoryOutbox.set(row.id, row);
    return row;
  }
  await withStore(OUTBOX_STORE, "readwrite", (store) => store.put(row));
  return row;
}

export async function listAdminBotOutbox(
  scope?: AdminBotOfflineScope,
): Promise<OfflineOutboxItem[]> {
  let rows: OfflineOutboxItem[];
  if (!hasIndexedDb()) {
    rows = [...memoryOutbox.values()];
  } else {
    rows = await withStore<OfflineOutboxItem[]>(OUTBOX_STORE, "readonly", (store) =>
      store.getAll(),
    );
  }
  return rows
    .filter((item) => !scope || belongsToScope(item, scope))
    .sort((left, right) => left.created_at - right.created_at);
}

export async function removeAdminBotOutboxItem(id: string): Promise<void> {
  if (!hasIndexedDb()) {
    memoryOutbox.delete(id);
    return;
  }
  await withStore(OUTBOX_STORE, "readwrite", (store) => store.delete(id));
}

export async function pendingAdminBotOutboxCount(scope: AdminBotOfflineScope): Promise<number> {
  return (await listAdminBotOutbox(scope)).length;
}

/**
 * Replay queued writes. Caller supplies the live fetch so this module never holds the session
 * token. Stops at the first failure so order is preserved.
 */
export async function flushAdminBotOutbox(
  scope: AdminBotOfflineScope,
  send: (item: OfflineOutboxItem) => Promise<boolean>,
): Promise<{ flushed: number; remaining: number }> {
  const items = await listAdminBotOutbox(scope);
  let flushed = 0;
  for (const item of items) {
    const ok = await send(item);
    if (!ok) {
      break;
    }
    await removeAdminBotOutboxItem(item.id);
    flushed += 1;
  }
  return { flushed, remaining: (await listAdminBotOutbox(scope)).length };
}

export async function resetAdminBotOfflineMemory(): Promise<void> {
  memoryGets.clear();
  memoryOutbox.clear();
  if (!hasIndexedDb()) {
    return;
  }
  await withStore(GET_STORE, "readwrite", (store) => store.clear());
  await withStore(OUTBOX_STORE, "readwrite", (store) => store.clear());
}

/**
 * Interview / later-work contract: a small on-device model for drafts while offline.
 * Not bundled. Do not call this from production UI until a real SLM is approved.
 */
export function onDeviceSlmDraftContract(): {
  status: "unwired";
  purpose: string;
} {
  return {
    status: "unwired",
    purpose:
      "Run a small on-device language model for offline drafts; never send private lab text off the device until reconnect.",
  };
}

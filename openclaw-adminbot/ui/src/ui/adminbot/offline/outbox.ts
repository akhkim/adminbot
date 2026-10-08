// Mutation outbox for AdminBot HTTP.
//
// The Control UI is often on a different origin from `:8765`, so a service worker cannot
// intercept those fetches; IndexedDB on this origin holds what must survive offline. Reads live
// in read-store.ts (own data only, bounded, wiped with the session). Writes here wait until the
// service is reachable again, scoped to the session that made them. Nothing enqueues new rows
// today -- member drafts sync through draft-sync.ts -- and legacy rows are kept for recovery but
// never replayed (flushQueuedAdminBotWrites). On-device SLM drafting is an interview-task stub.

import { resetOfflineReadStore } from "./read-store.ts";
import { OUTBOX_STORE, hasIndexedDb, withOfflineStore as withStore } from "./offline-db.ts";

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

const memoryOutbox = new Map<string, OfflineOutboxItem>();

function belongsToScope(
  item: Pick<OfflineOutboxItem, "base_url" | "principal_key">,
  scope: AdminBotOfflineScope,
): boolean {
  return item.base_url === scope.baseUrl && item.principal_key === scope.principalKey;
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

/** Tests: empty both the read store and the outbox. */
export async function resetAdminBotOfflineMemory(): Promise<void> {
  memoryOutbox.clear();
  await resetOfflineReadStore();
  if (!hasIndexedDb()) {
    return;
  }
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

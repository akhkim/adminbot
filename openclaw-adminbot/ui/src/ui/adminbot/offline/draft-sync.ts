// Each tab retains its own working copy. Concurrent edits meet at the server's revision check,
// so a background tab cannot overwrite either an offline edit or another device's newer draft.
export type DraftKey = "document-signature" | "recommendation-letters" | "book-meeting";
type RemoteDraft = { revision: number; mutationId: string; data: unknown };
type LocalDraft = {
  id: string;
  scope: string;
  key: DraftKey;
  data: unknown;
  revision: number;
  mutationId: string;
  dirty: boolean;
  updatedAt: number;
};
type Connection = {
  baseUrl: string;
  token: string;
  changed: (key: DraftKey, data?: unknown) => void;
};
export type DraftStatus =
  | "loading"
  | "saving"
  | "local"
  | "syncing"
  | "synced"
  | "conflict"
  | "error";
type Working = {
  row: LocalDraft;
  status: DraftStatus;
  error?: string;
  remote?: RemoteDraft | null;
  source?: { id: string; mutationId: string };
  legacy?: unknown;
};
const connections = new Map<string, Connection>();
const working = new Map<string, Working>();
const loading = new Map<string, Promise<unknown>>();
const syncing = new Set<string>();
const writes = new Map<string, Promise<void>>();
const keys: DraftKey[] = ["document-signature", "recommendation-letters", "book-meeting"];
// A fresh tab gets a fresh branch, including duplicated tabs. All branches survive browser exit.
const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const branch = newId();
let activeScope: string | undefined;
let pendingSaves = 0;

function id(scope: string, key: DraftKey) {
  return JSON.stringify([scope, key]);
}
export function draftScope(baseUrl: string, memberId: string) {
  return JSON.stringify([baseUrl.replace(/\/+$/u, ""), memberId]);
}

async function storage<T>(
  run: (store: IDBObjectStore) => IDBRequest<T>,
  write = false,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("adminbot-working-drafts", 1);
    request.addEventListener("upgradeneeded", () =>
      request.result.createObjectStore("drafts", { keyPath: "id" }),
    );
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("drafts", write ? "readwrite" : "readonly");
      const request = run(tx.objectStore("drafts"));
      // A request succeeding does not imply that its transaction committed (e.g. quota failure).
      tx.addEventListener("complete", () => resolve(request.result));
      tx.addEventListener("abort", () => reject(tx.error ?? new Error("Local save failed")));
      tx.addEventListener("error", () => reject(tx.error ?? new Error("Local save failed")));
    });
  } finally {
    db.close();
  }
}

function changed(scope: string, key: DraftKey, data?: unknown) {
  if (scope === activeScope) {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("adminbot-draft-status"));
    connections.get(scope)?.changed(key, data);
  }
}
function persist(row: LocalDraft) {
  const snapshot = structuredClone(row);
  const previous = writes.get(row.id) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => storage((s) => s.put(snapshot), true))
    .then(() => {});
  writes.set(row.id, next);
  return next;
}

export function configureDraftSync(scope: string, connection: Connection | null) {
  activeScope = scope;
  for (const existing of connections.keys()) {
    if (existing !== scope) {
      connections.delete(existing);
    }
  }
  const previous = connections.get(scope);
  if (
    connection &&
    previous?.baseUrl === connection.baseUrl &&
    previous.token === connection.token
  ) {
    previous.changed = connection.changed;
  } else if (connection) {
    connections.set(scope, connection);
    // Recover saved drafts even when the member reopens on the dashboard.
    for (const key of keys) {
      void loadWorkingDraft(scope, key)
        .then(() => {
          if (working.get(id(scope, key))?.row.dirty) return syncWorkingDraft(scope, key);
          return undefined;
        })
        .catch(() => {});
    }
  } else {
    connections.delete(scope);
  }
}

export function pendingDraftCount(scope: string): number {
  return [...working.values()].filter(
    (entry) =>
      entry.row.scope === scope &&
      (entry.row.dirty || entry.status === "conflict" || entry.status === "error"),
  ).length;
}

export function draftSyncStatus(
  scope: string,
  key: DraftKey,
): { status: DraftStatus; error?: string; hasLegacy?: boolean } {
  const entry = working.get(id(scope, key));
  return entry
    ? { status: entry.status, error: entry.error, hasLegacy: entry.legacy != null }
    : { status: "loading" };
}

async function legacyDraft(scope: string, key: DraftKey): Promise<unknown> {
  const memberId = (JSON.parse(scope) as string[])[1];
  return new Promise((resolve) => {
    const request = indexedDB.open("adminbot-logistics");
    request.addEventListener("error", () => resolve(null));
    request.addEventListener("success", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("drafts")) {
        db.close();
        resolve(null);
        return;
      }
      const read = db
        .transaction("drafts", "readonly")
        .objectStore("drafts")
        .get(`${key}:${memberId}`);
      read.addEventListener("success", () => {
        db.close();
        resolve(read.result ?? null);
      });
      read.addEventListener("error", () => {
        db.close();
        resolve(null);
      });
    });
  });
}

async function retireCopy(source: { id: string; mutationId: string }) {
  await storage((store) => {
    const read = store.get(source.id);
    read.addEventListener("success", () => {
      if ((read.result as LocalDraft | undefined)?.mutationId === source.mutationId) {
        store.delete(source.id);
      }
    });
    return read;
  }, true);
}

export async function importLegacyDraft(scope: string, key: DraftKey) {
  const entry = working.get(id(scope, key));
  if (!entry?.legacy) {
    return;
  }
  await saveWorkingDraft(scope, key, entry.legacy);
  changed(scope, key, entry.row.data);
  entry.legacy = undefined;
  changed(scope, key);
}

export async function loadWorkingDraft(scope: string, key: DraftKey): Promise<unknown> {
  const identity = id(scope, key);
  if (working.has(identity)) {
    return working.get(identity)!.row.data;
  }
  if (loading.has(identity)) {
    return loading.get(identity);
  }
  const promise = (async () => {
    const rows = await storage<LocalDraft[]>((s) => s.getAll());
    // Prefer unsynced work after a restart; a clean copy must never hide an offline branch.
    const candidates = rows
      .filter((r) => r.scope === scope && r.key === key)
      .toSorted((a, b) => Number(b.dirty) - Number(a.dirty) || b.updatedAt - a.updatedAt);
    const previous = candidates[0];
    const row: LocalDraft = previous
      ? { ...previous, id: `${identity}:${branch}` }
      : {
          id: `${identity}:${branch}`,
          scope,
          key,
          data: null,
          revision: 0,
          mutationId: newId(),
          dirty: false,
          updatedAt: Date.now(),
        };
    const legacy = previous ? undefined : await legacyDraft(scope, key).catch(() => null);
    working.set(identity, {
      legacy,
      row,
      status: row.dirty ? "local" : "loading",
      ...(previous ? { source: { id: previous.id, mutationId: previous.mutationId } } : {}),
    });
    return row.data;
  })();
  loading.set(identity, promise);
  try {
    return await promise;
  } finally {
    loading.delete(identity);
  }
}

export async function saveWorkingDraft(scope: string, key: DraftKey, data: unknown): Promise<void> {
  pendingSaves += 1;
  try {
    try {
      await loadWorkingDraft(scope, key);
    } catch {
      // Retain the typed value in memory even when opening IndexedDB itself fails, so Export
      // can rescue it. Persistence below still fails visibly; nothing is uploaded as saved.
      working.set(id(scope, key), {
        status: "error",
        row: {
          id: `${id(scope, key)}:${branch}`,
          scope,
          key,
          data: null,
          revision: 0,
          mutationId: newId(),
          dirty: false,
          updatedAt: Date.now(),
        },
      });
    }
    const entry = working.get(id(scope, key))!;
    entry.row = {
      ...entry.row,
      data: structuredClone(data),
      dirty: true,
      mutationId: newId(),
      updatedAt: Date.now(),
    };
    const mutation = entry.row.mutationId;
    const conflict = entry.status === "conflict";
    entry.status = conflict ? "conflict" : "saving";
    changed(scope, key);
    try {
      await persist(entry.row);
      // Transfer the restored copy only after its replacement committed. A source edited by
      // another live tab has a different mutation and must remain recoverable.
      if (entry.source) {
        await retireCopy(entry.source);
        entry.source = undefined;
      }
      if (entry.row.mutationId === mutation && !conflict && entry.status !== "conflict") {
        entry.status = "local";
      }
      entry.error = undefined;
      changed(scope, key);
      // Coalesced by syncWorkingDraft; never wait for the network to finish a local save.
      if (!conflict) {
        void syncWorkingDraft(scope, key);
      }
    } catch (error) {
      entry.status = "error";
      entry.error = error instanceof Error ? error.message : "Could not save on this device";
      changed(scope, key);
      throw error;
    }
  } finally {
    pendingSaves -= 1;
  }
}

// File objects stay native in IndexedDB; only the authenticated Aurora request encodes them.
async function encode(value: unknown): Promise<unknown> {
  if (value instanceof File) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result)));
      reader.addEventListener("error", () => reject(reader.error));
      reader.readAsDataURL(value);
    });
    return { adminbotFile: true, name: value.name, type: value.type, data };
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map(encode));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await encode(v)])),
    );
  }
  return value;
}
function decode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decode);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.adminbotFile === true && typeof obj.data === "string" && typeof obj.name === "string") {
      const bytes = Uint8Array.from(atob(obj.data.slice(obj.data.indexOf(",") + 1)), (c) =>
        c.charCodeAt(0),
      );
      return new File([bytes], obj.name, { type: typeof obj.type === "string" ? obj.type : "" });
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}

export async function syncWorkingDraft(scope: string, key: DraftKey): Promise<void> {
  const identity = id(scope, key);
  const connection = connections.get(scope);
  const entry = working.get(identity);
  if (
    !connection ||
    scope !== activeScope ||
    !entry ||
    syncing.has(identity) ||
    entry.status === "conflict" ||
    entry.status === "error"
  ) {
    return;
  }
  syncing.add(identity);
  const snapshot = structuredClone(entry.row);
  try {
    await writes.get(snapshot.id);
    entry.status = snapshot.dirty ? "syncing" : entry.status;
    changed(scope, key);
    const response = await fetch(`${connection.baseUrl}/member-drafts/${key}`, {
      method: snapshot.dirty ? "PUT" : "GET",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
      ...(snapshot.dirty
        ? {
            body: JSON.stringify({
              baseRevision: snapshot.revision,
              mutationId: snapshot.mutationId,
              data: await encode(snapshot.data),
            }),
          }
        : {}),
    });
    if (connections.get(scope) !== connection || scope !== activeScope) {
      return;
    }
    if (response.status === 409) {
      entry.remote = (await response.json()).draft as RemoteDraft | null;
      entry.status = "conflict";
      return;
    }
    if (!response.ok) {
      entry.status = "local";
      entry.error =
        response.status === 401 || response.status === 403
          ? "Sign in again to sync. Your draft is saved on this device."
          : `Saved on this device. Sync unavailable (${response.status}).`;
      return;
    }
    const remote = (await response.json()).draft as RemoteDraft | null;
    if (!snapshot.dirty && entry.row.mutationId !== snapshot.mutationId) {
      return;
    }
    entry.row.revision = remote?.revision ?? 0;
    if (entry.row.mutationId === snapshot.mutationId) {
      entry.row.dirty = false;
      if (!snapshot.dirty && remote && remote.revision !== snapshot.revision) {
        entry.row.data = decode(remote.data);
        changed(scope, key, entry.row.data);
      }
      entry.status = "synced";
    } else {
      entry.status = "local";
    }
    entry.error = undefined;
    try {
      await persist(entry.row);
      // A restored branch can have the same mutation as its source tab. Retire only exact
      // acknowledged copies; other unsynced versions remain available for recovery.
      if (!entry.row.dirty) {
        const rows = await storage<LocalDraft[]>((store) => store.getAll());
        for (const row of rows) {
          if (
            row.id !== entry.row.id &&
            row.scope === scope &&
            row.key === key &&
            row.mutationId === snapshot.mutationId
          ) {
            await retireCopy(row);
          }
        }
      }
    } catch {
      entry.status = "error";
      entry.error = "Could not save on this device. Keep this page open and try Save again.";
    }
  } catch {
    const currentStatus = draftSyncStatus(scope, key).status;
    if (currentStatus !== "saving" && currentStatus !== "error") {
      entry.status = "local";
    }
  } finally {
    syncing.delete(identity);
    changed(scope, key);
  }
}

export async function resolveDraftConflict(
  scope: string,
  key: DraftKey,
  choice: "mine" | "server",
) {
  const entry = working.get(id(scope, key));
  if (!entry || entry.status !== "conflict") {
    return;
  }
  await persist({
    ...entry.row,
    id: `${entry.row.id}:recovery:${newId()}`,
    dirty: false,
  });
  entry.row.revision = entry.remote?.revision ?? 0;
  if (choice === "server") {
    entry.row.data = entry.remote ? decode(entry.remote.data) : null;
    entry.row.dirty = false;
    entry.status = "synced";
    changed(scope, key, entry.row.data);
  } else {
    entry.row.dirty = true;
    entry.row.mutationId = newId();
    entry.status = "local";
  }
  await persist(entry.row);
  changed(scope, key);
  if (choice === "mine") {
    await syncWorkingDraft(scope, key);
  }
}

export async function downloadDraftCopies(scope: string, key: DraftKey) {
  const entry = working.get(id(scope, key));
  // Export remains a recovery path when quota/security failures prevent IndexedDB writes.
  const rows = await storage<LocalDraft[]>((store) => store.getAll()).catch(() => []);
  const copies = rows.filter((row) => row.scope === scope && row.key === key);
  const content = await encode({
    current: entry?.row.data ?? null,
    local: copies,
    server: entry?.remote ?? null,
  });
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(content, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${key}-saved-copies.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function retryDraftSync() {
  if (activeScope) {
    for (const key of keys) {
      void syncWorkingDraft(activeScope, key);
    }
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (
      pendingSaves > 0 ||
      [...working.values()].some(
        (entry) => entry.row.scope === activeScope && entry.status === "error",
      )
    ) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  window.addEventListener("online", retryDraftSync);
  window.addEventListener("focus", retryDraftSync);
  window.setInterval(retryDraftSync, 10000);
}

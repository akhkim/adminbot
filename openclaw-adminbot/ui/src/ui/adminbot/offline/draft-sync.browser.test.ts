import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureDraftSync,
  downloadDraftCopies,
  draftScope,
  draftSyncStatus,
  loadWorkingDraft,
  saveWorkingDraft,
  syncWorkingDraft,
  resolveDraftConflict,
} from "./draft-sync.ts";

afterEach(() => {
  configureDraftSync("signed-out", null);
  vi.restoreAllMocks();
});
const key = "book-meeting";
function setup() {
  const scope = draftScope("https://aurora.test", crypto.randomUUID());
  const changed = vi.fn();
  configureDraftSync(scope, { baseUrl: "https://aurora.test", token: "synthetic", changed });
  return { scope, changed };
}
async function settle(scope: string) {
  await vi.waitFor(() =>
    expect(["saving", "syncing"]).not.toContain(draftSyncStatus(scope, key).status),
  );
}
describe("offline working copies in real IndexedDB", () => {
  it("restores pending drafts on connection without opening a form", async () => {
    const scope = draftScope("https://aurora.test", crypto.randomUUID());
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("adminbot-working-drafts", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put({
        id: `saved-${scope}`,
        scope,
        key,
        data: { text: "from last launch" },
        revision: 0,
        mutationId: "saved-mutation",
        dirty: true,
        updatedAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        draft: { revision: 1, mutationId: body.mutationId, data: body.data },
      });
    });
    configureDraftSync(scope, {
      baseUrl: "https://aurora.test",
      token: "synthetic",
      changed: vi.fn(),
    });
    await vi.waitFor(() => expect(draftSyncStatus(scope, key).status).toBe("synced"));
    expect(fetcher).toHaveBeenCalledWith(
      "https://aurora.test/member-drafts/book-meeting",
      expect.objectContaining({ method: "PUT", body: expect.stringContaining("from last launch") }),
    );
  });
  it("persists offline edits and files, then syncs when Aurora returns without a browser online event", async () => {
    const { scope } = setup();
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const data = {
      meetings: [{ purpose: "Synthetic draft" }],
      file: new File(["attachment"], "example.txt"),
    };
    await saveWorkingDraft(scope, key, data);
    await settle(scope);
    expect(draftSyncStatus(scope, key).status).toBe("local");
    const restored = (await loadWorkingDraft(scope, key)) as typeof data;
    expect(await restored.file.text()).toBe("attachment");
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.data.file.adminbotFile).toBe(true);
      return Response.json({
        draft: { revision: 1, mutationId: body.mutationId, data: body.data },
      });
    });
    await syncWorkingDraft(scope, key);
    expect(draftSyncStatus(scope, key).status).toBe("synced");
  });
  it("keeps local content on conflict until the member explicitly chooses a version", async () => {
    const { scope } = setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          draft: {
            revision: 4,
            mutationId: "other-device",
            data: { text: "server" },
          },
        },
        { status: 409 },
      ),
    );
    await saveWorkingDraft(scope, key, { text: "mine" });
    await settle(scope);
    expect(draftSyncStatus(scope, key).status).toBe("conflict");
    expect(await loadWorkingDraft(scope, key)).toEqual({ text: "mine" });
    await resolveDraftConflict(scope, key, "server");
    expect(await loadWorkingDraft(scope, key)).toEqual({ text: "server" });
  });
  it("does not apply a late response to a newly signed-in member", async () => {
    const { scope, changed } = setup();
    let finish!: (r: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await loadWorkingDraft(scope, key);
    const pending = syncWorkingDraft(scope, key);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    configureDraftSync("another-member", null);
    changed.mockClear();
    finish(Response.json({ draft: { revision: 5, data: { secret: "old member" } } }));
    await pending;
    expect(changed).not.toHaveBeenCalled();
    expect(await loadWorkingDraft(scope, key)).toBeNull();
  });
  it("keeps a newer local edit pending when an earlier upload finishes", async () => {
    const { scope } = setup();
    let finish!: (r: Response) => void;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await saveWorkingDraft(scope, key, { text: "first" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await saveWorkingDraft(scope, key, { text: "second" });
    finish(Response.json({ draft: { revision: 1, data: { text: "first" } } }));
    await settle(scope);
    expect(await loadWorkingDraft(scope, key)).toEqual({ text: "second" });
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.baseRevision).toBe(1);
      expect(body.data.text).toBe("second");
      return Response.json({ draft: { revision: 2, data: body.data } });
    });
    await vi.waitFor(async () => {
      await syncWorkingDraft(scope, key);
      expect(draftSyncStatus(scope, key).status).toBe("synced");
    });
  });

  it("reports a failed local commit and does not upload work that was not saved", async () => {
    const { scope } = setup();
    await loadWorkingDraft(scope, key);
    const fetcher = vi.spyOn(globalThis, "fetch");
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    });
    await expect(saveWorkingDraft(scope, key, { text: "keep me" })).rejects.toThrow();
    expect(draftSyncStatus(scope, key).status).toBe("error");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await loadWorkingDraft(scope, key)).toEqual({ text: "keep me" });
    let exported!: Blob;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      exported = blob as Blob;
      return "blob:synthetic";
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await downloadDraftCopies(scope, key);
    expect(JSON.parse(await exported.text()).current).toEqual({ text: "keep me" });
  });
});

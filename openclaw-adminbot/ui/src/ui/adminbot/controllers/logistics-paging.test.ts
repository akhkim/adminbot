// My Desk's letters: every open recommendation-letter request, read page by page to the end.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import type { LogisticsRequest } from "../api/logistics.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import { DEFAULT_LOGISTICS_QUEUE_OPTIONS } from "../data/logistics-queue.ts";
import { EMPTY_PAGED_LIST } from "../load-more.ts";
import { resetAdminBotOfflineMemory } from "../offline/outbox.ts";
import {
  loadAdminBotDeskLetters,
  readAdminBotLogisticsLists,
  type LogisticsReadHost,
} from "./logistics-paging.ts";
import type { AdminBotLogisticsHost } from "./logistics.ts";

function letter(id: string): LogisticsRequest {
  return {
    id,
    kind: "recommendation_letters",
    member_id: "ada",
    member_name: "Ada",
    status: "submitted",
    submitted_at: "2026-08-02T09:30:00.000Z",
    updated_at: "2026-08-02T09:30:00.000Z",
    documents: [],
  };
}

function createHost(): AdminBotLogisticsHost {
  return {
    settings: { adminBotUrl: "http://127.0.0.1:8765" } as UiSettings,
    memberId: "ada",
    adminBotLogisticsRequests: [],
    adminBotLogisticsRequestsLoading: false,
    adminBotLogisticsRequestsError: null,
    adminBotLogisticsPage: EMPTY_PAGED_LIST,
    adminBotDeskLetters: { requests: [], loading: false, loadedAt: null },
    adminBotLogisticsOpenRequest: null,
    adminBotLogisticsOpenRequestId: null,
    adminBotLogisticsOpenLoading: false,
    adminBotLogisticsSubmitting: false,
    adminBotLogisticsSubmitError: null,
    adminBotLogisticsSubmittedId: null,
    adminBotLogisticsSigningId: null,
    adminBotLogisticsDownloadingId: null,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Answers each page by its cursor ("" for the first). */
function pagedFetch(pages: Record<string, () => Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const cursor = new URL(String(input)).searchParams.get("cursor") ?? "";
    const page = pages[cursor];
    if (!page) {
      throw new Error(`unexpected page: ${cursor}`);
    }
    return page();
  });
}

describe("My Desk letters", () => {
  beforeEach(async () => {
    await resetAdminBotOfflineMemory();
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads every page, in order", async () => {
    const host = createHost();
    pagedFetch({
      "": () => json({ requests: [letter("a"), letter("b")], next_cursor: "2" }),
      "2": () => json({ requests: [letter("c")] }),
    });
    await loadAdminBotDeskLetters(host);
    expect(host.adminBotDeskLetters.requests.map((request) => request.id)).toEqual(["a", "b", "c"]);
    expect(host.adminBotDeskLetters.loading).toBe(false);
  });

  it("counts a letter once when a new one pushes it onto the next page between reads", async () => {
    const host = createHost();
    pagedFetch({
      "": () => json({ requests: [letter("a"), letter("b")], next_cursor: "2" }),
      // A letter with an earlier deadline arrived after page 1 was read: "b" moved down a place.
      "2": () => json({ requests: [letter("b"), letter("c")] }),
    });
    await loadAdminBotDeskLetters(host);
    expect(host.adminBotDeskLetters.requests.map((request) => request.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps the letters it had when a later read fails, rather than a partial count", async () => {
    const host = createHost();
    host.adminBotDeskLetters = {
      requests: [letter("a"), letter("b"), letter("c")],
      loading: false,
      loadedAt: null,
    };
    pagedFetch({
      "": () => json({ requests: [letter("a"), letter("b")], next_cursor: "2" }),
      "2": () => json({ error: "unavailable" }, 503),
    });
    await loadAdminBotDeskLetters(host);
    expect(host.adminBotDeskLetters.requests.map((request) => request.id)).toEqual(["a", "b", "c"]);
    expect(host.adminBotDeskLetters.loading).toBe(false);
    // Not re-asked on every render while the service is down.
    expect(host.adminBotDeskLetters.loadedAt).not.toBeNull();
  });
});

describe("the admin queue on each Requests tab", () => {
  beforeEach(async () => {
    await resetAdminBotOfflineMemory();
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks for the tab's own kind, and asks again on moving to another tab", async () => {
    const asked: (string | null)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      asked.push(new URL(String(input)).searchParams.get("kind"));
      return json({ requests: [] });
    });
    const host: LogisticsReadHost = {
      ...createHost(),
      tab: "adminbotRecLetters",
      adminBotLogisticsMode: "view",
      adminBotLogisticsQueueOptions: DEFAULT_LOGISTICS_QUEUE_OPTIONS,
      adminBotLogisticsShowSettled: false,
      adminBotLogisticsRequestsLoadedAt: null,
    };
    const read = async () => {
      readAdminBotLogisticsLists(host, { isAdmin: true, hasMemberSession: true }, undefined);
      await vi.waitFor(() => expect(host.adminBotLogisticsRequestsLoading).toBe(false));
    };
    await read();
    await read();
    expect(asked).toEqual(["recommendation_letters"]);
    host.tab = "adminbotMeetingRequests";
    await read();
    expect(asked).toEqual(["recommendation_letters", "book_meeting"]);
  });
});

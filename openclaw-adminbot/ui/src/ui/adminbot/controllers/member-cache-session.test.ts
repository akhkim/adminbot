import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import type { AdminBotHost } from "./admin.ts";
import { loadAdminBotLocationDrifts, loadAdminBotLocationPrompt } from "./location-prompt.ts";
import { loadAdminBotMeetings, loadMoreAdminBotMeetings } from "./meetings.ts";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

function host(): AdminBotHost {
  return {
    settings: { adminBotUrl: "https://admin.safe.eu" } as UiSettings,
    adminBotLocationDrift: undefined,
    adminBotLocationDrifts: undefined,
    adminBotMeetings: undefined,
    adminBotMeetingsNextCursor: null,
    adminBotMeetingsLoading: false,
    adminBotMeetingsLoadingMore: false,
    adminBotMeetingsVisibleCount: 12,
    adminBotMeetingsError: null,
  } as AdminBotHost;
}

describe("member-owned location and meeting caches", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "token-a", expiresAt: "later" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("drops late location prompt and drift responses from A after B signs in", async () => {
    const finish: Record<string, (response: Response) => void> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      const key = url.includes("location-drifts") ? "drifts" : "prompt";
      return new Promise<Response>((resolve) => {
        finish[key] = resolve;
      });
    });
    const app = host();
    const prompt = loadAdminBotLocationPrompt(app);
    const drifts = loadAdminBotLocationDrifts(app);
    saveStoredMemberSession({ sessionToken: "token-b", expiresAt: "later" });
    finish.prompt?.(json({ drift: { current_city: "A's city" } }));
    finish.drifts?.(json({ drifts: [{ current_city: "A's city" }] }));
    await Promise.all([prompt, drifts]);
    expect(app.adminBotLocationDrift).toBeUndefined();
    expect(app.adminBotLocationDrifts).toBeUndefined();
  });

  it("does not show A's meetings or clear B's loading state after a late response", async () => {
    let finish: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const app = host();
    const loading = loadAdminBotMeetings(app);
    saveStoredMemberSession({ sessionToken: "token-b", expiresAt: "later" });
    app.adminBotMeetingsLoading = true;
    finish?.(json({ meetings: [{ id: "a-private-meeting" }] }));
    await loading;
    expect(app.adminBotMeetings).toBeUndefined();
    expect(app.adminBotMeetingsLoading).toBe(true);
  });

  it("fetches the next cursor page once and appends only unseen recordings", async () => {
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      return json(
        url.includes("before_id=")
          ? { meetings: [{ id: "older" }, { id: "newest" }] }
          : {
              meetings: [{ id: "newest" }],
              next_cursor: { started_at: "2026-08-12T14:00:00Z", id: "newest" },
            },
      );
    });
    const app = host();
    await loadAdminBotMeetings(app);
    expect(requests[0]).toContain("/meetings?limit=12");
    await loadMoreAdminBotMeetings(app);
    expect(requests[1]).toContain("before_id=newest");
    expect(app.adminBotMeetings?.map((meeting) => meeting.id)).toEqual(["newest", "older"]);
    expect(app.adminBotMeetingsNextCursor).toBeNull();
    await loadMoreAdminBotMeetings(app);
    expect(requests).toHaveLength(2);
  });

  it("drops an old cursor page after a same-session refresh", async () => {
    let finishOldPage: ((response: Response) => void) | undefined;
    let firstPageRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const beforeId = new URL(String(input)).searchParams.get("before_id");
      if (beforeId === "a-newest") {
        return new Promise<Response>((resolve) => {
          finishOldPage = resolve;
        });
      }
      if (beforeId === "b-newest") {
        return Promise.resolve(json({ meetings: [{ id: "b-older" }] }));
      }
      firstPageRequests++;
      const id = firstPageRequests === 1 ? "a-newest" : "b-newest";
      return Promise.resolve(
        json({ meetings: [{ id }], next_cursor: { id, started_at: "2026-08-12T14:00:00Z" } }),
      );
    });
    const app = host();
    await loadAdminBotMeetings(app);
    const oldPage = loadMoreAdminBotMeetings(app);
    await loadAdminBotMeetings(app);
    finishOldPage?.(json({ meetings: [{ id: "a-older" }] }));
    await oldPage;
    expect(app.adminBotMeetings?.map((meeting) => meeting.id)).toEqual(["b-newest"]);
    expect(app.adminBotMeetingsNextCursor?.id).toBe("b-newest");
    expect(app.adminBotMeetingsLoadingMore).toBe(false);
    await loadMoreAdminBotMeetings(app);
    expect(app.adminBotMeetings?.map((meeting) => meeting.id)).toEqual(["b-newest", "b-older"]);
  });

  it("does not append an old member's later page after a new member signs in", async () => {
    let finish: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const app = host();
    app.adminBotMeetings = [{ id: "a-newest" }] as never;
    app.adminBotMeetingsNextCursor = { id: "a-newest", started_at: "2026-08-12T14:00:00Z" };
    const loading = loadMoreAdminBotMeetings(app);
    saveStoredMemberSession({ sessionToken: "token-b", expiresAt: "later" });
    app.adminBotMeetings = undefined;
    app.adminBotMeetingsLoadingMore = true;
    finish?.(json({ meetings: [{ id: "a-older" }] }));
    await loading;
    expect(app.adminBotMeetings).toBeUndefined();
    expect(app.adminBotMeetingsLoadingMore).toBe(true);
  });
});

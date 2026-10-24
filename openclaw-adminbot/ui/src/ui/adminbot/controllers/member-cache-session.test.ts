import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import type { AdminBotHost } from "./admin.ts";
import { loadAdminBotLocationDrifts, loadAdminBotLocationPrompt } from "./location-prompt.ts";
import { loadAdminBotMeetings, loadAdminBotMeetingSeriesPage } from "./meetings.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const WEEKLY = {
  key: "weekly",
  topic: "Weekly",
  count: 2,
  latest_started_at: "2026-08-12T14:00:00Z",
};

function host(): AdminBotHost {
  return {
    settings: { adminBotUrl: "https://admin.safe.eu" } as UiSettings,
    adminBotLocationDrift: undefined,
    adminBotLocationDrifts: undefined,
    adminBotMeetingSeries: undefined,
    adminBotMeetingSeriesPages: {},
    adminBotMeetingsLoading: false,
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

  // The render pass asks again on every render while the answer is undefined, and re-renders when
  // the ask settles. A repeat ask that settled at once would re-render, ask again, and settle at
  // once again -- a microtask loop that never lets the response it is waiting for arrive.
  it("makes a repeat location ask wait for the request already in flight", async () => {
    const finish: Record<string, (response: Response) => void> = {};
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const key = String(input).includes("location-drifts") ? "drifts" : "prompt";
      return new Promise<Response>((resolve) => {
        finish[key] = resolve;
      });
    });
    const app = host();
    const first = [loadAdminBotLocationPrompt(app), loadAdminBotLocationDrifts(app)];
    let repeatsSettled = false;
    const repeats = Promise.all([
      loadAdminBotLocationPrompt(app),
      loadAdminBotLocationDrifts(app),
    ]).then(() => {
      repeatsSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repeatsSettled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    finish.prompt?.(json({ drift: null }));
    finish.drifts?.(json({ drifts: [] }));
    await Promise.all([...first, repeats]);
    expect(repeatsSettled).toBe(true);
    expect(app.adminBotLocationDrifts).toEqual([]);
  });

  it("does not show A's meeting index or clear B's loading state after a late response", async () => {
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
    finish?.(json({ series: [{ ...WEEKLY, topic: "A's private meeting" }] }));
    await loading;
    expect(app.adminBotMeetingSeries).toBeUndefined();
    expect(app.adminBotMeetingsLoading).toBe(true);
  });

  it("reads the newest series with the index, then each page of it once", async () => {
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/meetings/series")) {
        return json({ series: [WEEKLY, { ...WEEKLY, key: "reading", topic: "Reading" }] });
      }
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
    expect(app.adminBotMeetingSeries?.map((series) => series.key)).toEqual(["weekly", "reading"]);
    // Only the newest series is read on arrival; "reading" waits for its dropdown.
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("/meetings?limit=10&series=weekly");
    // Re-opening a series already read does not read it again.
    await loadAdminBotMeetingSeriesPage(app, "weekly");
    expect(requests).toHaveLength(2);
    await loadAdminBotMeetingSeriesPage(app, "weekly", { more: true });
    expect(requests[2]).toContain("series=weekly");
    expect(requests[2]).toContain("before_id=newest");
    const weekly = app.adminBotMeetingSeriesPages?.weekly;
    expect(weekly?.meetings.map((meeting) => meeting.id)).toEqual(["newest", "older"]);
    expect(weekly?.next_cursor).toBeNull();
    await loadAdminBotMeetingSeriesPage(app, "weekly", { more: true });
    expect(requests).toHaveLength(3);
  });

  it("shows a failed series read in its dropdown and retries it on the next open", async () => {
    let fail = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      fail
        ? json({ error: { message: "Synthetic outage" } }, 500)
        : json({ meetings: [{ id: "only" }] }),
    );
    const app = host();
    await loadAdminBotMeetingSeriesPage(app, "weekly");
    expect(app.adminBotMeetingSeriesPages?.weekly).toMatchObject({
      meetings: [],
      loading: false,
    });
    expect(app.adminBotMeetingSeriesPages?.weekly?.error).toBeTruthy();
    // The tab-wide error stays clear: one series failing is not the tab failing.
    expect(app.adminBotMeetingsError).toBeNull();
    fail = false;
    await loadAdminBotMeetingSeriesPage(app, "weekly");
    expect(app.adminBotMeetingSeriesPages?.weekly).toEqual({
      meetings: [{ id: "only" }],
      next_cursor: null,
      loading: false,
      error: null,
    });
  });

  it("drops an old series page after a same-session refresh", async () => {
    let finishOldPage: ((response: Response) => void) | undefined;
    let firstPageRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/meetings/series")) {
        return Promise.resolve(json({ series: [WEEKLY] }));
      }
      const beforeId = url.searchParams.get("before_id");
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
    const oldPage = loadAdminBotMeetingSeriesPage(app, "weekly", { more: true });
    await loadAdminBotMeetings(app);
    finishOldPage?.(json({ meetings: [{ id: "a-older" }] }));
    await oldPage;
    const weekly = app.adminBotMeetingSeriesPages?.weekly;
    expect(weekly?.meetings.map((meeting) => meeting.id)).toEqual(["b-newest"]);
    expect(weekly?.next_cursor?.id).toBe("b-newest");
    expect(weekly?.loading).toBe(false);
    await loadAdminBotMeetingSeriesPage(app, "weekly", { more: true });
    expect(app.adminBotMeetingSeriesPages?.weekly?.meetings.map((meeting) => meeting.id)).toEqual([
      "b-newest",
      "b-older",
    ]);
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
    app.adminBotMeetingSeriesPages = {
      weekly: {
        meetings: [{ id: "a-newest" }] as never,
        next_cursor: { id: "a-newest", started_at: "2026-08-12T14:00:00Z" },
        loading: false,
        error: null,
      },
    };
    const loading = loadAdminBotMeetingSeriesPage(app, "weekly", { more: true });
    saveStoredMemberSession({ sessionToken: "token-b", expiresAt: "later" });
    // What sign-out does to the series lists (auth/flow.ts).
    app.adminBotMeetingSeriesPages = {};
    finish?.(json({ meetings: [{ id: "a-older" }] }));
    await loading;
    expect(app.adminBotMeetingSeriesPages).toEqual({});
  });
});

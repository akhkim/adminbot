// The profile overview controller: what lands on host state for each answer the service gives.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import {
  EMPTY_PROFILE_OVERVIEW_PAGE,
  loadAdminBotProfileOverview,
  loadMoreAdminBotProfileOverview,
  remindAdminBotIncompleteProfiles,
  type AdminBotProfileOverviewHost,
} from "./profile-overview.ts";

const DESK = () => new URLSearchParams({ view: "desk" });
const LIST = () => new URLSearchParams();

function createHost(): AdminBotProfileOverviewHost {
  return {
    settings: { adminBotUrl: "http://127.0.0.1:8765" } as UiSettings,
    adminBotProfileOverview: [],
    adminBotProfileOverviewPage: EMPTY_PROFILE_OVERVIEW_PAGE,
    adminBotEscalatedNudges: [],
    adminBotPiReview: [],
    adminBotPiReviewError: null,
    adminBotProfileOverviewFieldCount: 0,
    adminBotProfileOverviewLoading: false,
    adminBotProfileOverviewError: null,
    adminBotProfileOverviewLoadedAt: 1,
    adminBotProfileOverviewReminding: false,
    adminBotProfileOverviewNotice: null,
  };
}

const ROW = {
  id: "ada",
  name: "Ada",
  privilege_level: "member",
  missing_fields: ["cv_url"],
  filled_field_count: 11,
  timeline: { availability: 0, time_off: 0, milestones: 0, trips: 0, total: 0 },
};

function routedFetch(routes: Record<string, () => Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const match = Object.keys(routes).find((path) => url.includes(path));
    if (!match) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    return routes[match]!();
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("profile overview controller", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks the admin to sign in rather than showing an empty sweep", async () => {
    const host = createHost();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await loadAdminBotProfileOverview(host, LIST());
    expect(host.adminBotProfileOverviewError).toContain("Sign in");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the denominator the service sent", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    routedFetch({
      "/members/profile-overview": () => json({ members: [ROW], mandatory_field_count: 12 }),
    });
    await loadAdminBotProfileOverview(host, LIST());
    // ROW is what a service older than the adoption columns sends. The counts it leaves out arrive
    // zeroed rather than absent, because the page reads every one of them unguarded while rendering.
    expect(host.adminBotProfileOverview).toEqual([
      { ...ROW, self_filled_field_count: 0, projects: { total: 0, self_updated: 0 } },
    ]);
    expect(host.adminBotProfileOverviewFieldCount).toBe(12);
    expect(host.adminBotProfileOverviewLoading).toBe(false);
  });

  it("passes the service's own refusal through, rather than guessing at one", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    routedFetch({
      "/members/profile-overview": () =>
        json({ error: { message: "insufficient privileges" } }, 403),
    });
    await loadAdminBotProfileOverview(host, LIST());
    expect(host.adminBotProfileOverviewError).toBe("insufficient privileges");
    expect(host.adminBotProfileOverview).toEqual([]);
  });

  it("keeps a failed PI queue distinct from a successfully empty queue, and retries", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    let failed = true;
    routedFetch({
      "/members/profile-overview": () => json({ members: [ROW], mandatory_field_count: 12 }),
      "/nudges/escalated": () => json({ members: [] }),
      "/papers/pi-review": () =>
        failed ? json({ error: { message: "PI queue unavailable" } }, 503) : json({ papers: [] }),
    });
    await loadAdminBotProfileOverview(host, DESK());
    expect(host.adminBotPiReviewError).toBe("PI queue unavailable");
    expect(host.adminBotProfileOverview).toHaveLength(1);
    failed = false;
    await loadAdminBotProfileOverview(host, DESK());
    expect(host.adminBotPiReviewError).toBeNull();
    expect(host.adminBotPiReview).toEqual([]);
  });

  it.each([
    [404, {}, "does not support"],
    [200, {}, "invalid PI review queue"],
    [200, { papers: [null] }, "invalid PI review queue"],
  ])(
    "does not turn HTTP %s or invalid queue data into an empty success",
    async (status, body, message) => {
      saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
      const host = createHost();
      routedFetch({
        "/members/profile-overview": () => json({ members: [ROW], mandatory_field_count: 12 }),
        "/nudges/escalated": () => json({ members: [] }),
        "/papers/pi-review": () => json(body, status),
      });
      await loadAdminBotProfileOverview(host, DESK());
      expect(host.adminBotPiReviewError).toContain(message);
    },
  );

  it("asks for the next page with the same filter, and draws a row it already holds once", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      return url.includes("cursor=20")
        ? json({ members: [ROW, { ...ROW, id: "bo", name: "Bo" }], total: 21 })
        : json({
            members: [ROW],
            total: 21,
            next_cursor: "20",
            summary: { remind_count: 17 },
            mandatory_field_count: 12,
          });
    });
    await loadAdminBotProfileOverview(host, new URLSearchParams("gap=profile&q=a"));
    expect(host.adminBotProfileOverviewPage).toMatchObject({
      view: "list",
      total: 21,
      nextCursor: "20",
      remindCount: 17,
    });
    await loadMoreAdminBotProfileOverview(host);
    expect(urls.at(-1)).toContain("/members/profile-overview?gap=profile&q=a&cursor=20");
    expect(host.adminBotProfileOverview.map((row) => row.id)).toEqual(["ada", "bo"]);
    expect(host.adminBotProfileOverviewPage.nextCursor).toBeNull();
    expect(host.adminBotProfileOverviewPage.loadingMore).toBe(false);
    // The list's read does not re-ask for My Desk's queues on every filter change.
    expect(urls.some((url) => url.includes("/papers/pi-review"))).toBe(false);
  });

  it("drops a slow answer to an earlier filter", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    let releaseFirst: (() => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("q=old")) {
        await new Promise<void>((resolve) => (releaseFirst = resolve));
        return json({ members: [ROW], total: 1 });
      }
      return json({ members: [{ ...ROW, id: "bo", name: "Bo" }], total: 1 });
    });
    const first = loadAdminBotProfileOverview(host, new URLSearchParams("q=old"));
    await loadAdminBotProfileOverview(host, new URLSearchParams("q=new"));
    releaseFirst?.();
    await first;
    expect(host.adminBotProfileOverview.map((row) => row.id)).toEqual(["bo"]);
    expect(host.adminBotProfileOverviewLoading).toBe(false);
  });

  it("sends the page's filter to the reminder, not the ids it happens to hold", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    const fetchMock = routedFetch({
      "/members/mandatory-fields-reminder/run": () => json({ created: [], skipped: [] }),
    });
    await remindAdminBotIncompleteProfiles(
      host,
      { include: "timeline", memberIds: ["ada"] },
      new URLSearchParams("gap=timeline"),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ include: "timeline", filter: "gap=timeline" });
  });

  it("reports how many were nudged, and re-reads so the column updates", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    routedFetch({
      "/members/mandatory-fields-reminder/run": () =>
        json({ created: [{ id: "act_1" }, { id: "act_2" }], skipped: [] }),
    });
    await remindAdminBotIncompleteProfiles(host);
    expect(host.adminBotProfileOverviewNotice).toContain("2");
    // Clearing the stamp is what asks the render pass for a fresh read.
    expect(host.adminBotProfileOverviewLoadedAt).toBeNull();
    expect(host.adminBotProfileOverviewReminding).toBe(false);
  });

  it("says nobody was due rather than claiming a send", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    routedFetch({
      "/members/mandatory-fields-reminder/run": () => json({ created: [], skipped: [] }),
    });
    await remindAdminBotIncompleteProfiles(host);
    expect(host.adminBotProfileOverviewNotice).toContain("Nobody was due");
  });

  it("leaves the stamp alone when the reminder failed, so nothing looks refreshed", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    routedFetch({
      "/members/mandatory-fields-reminder/run": () =>
        json({ error: { message: "insufficient" } }, 403),
    });
    await remindAdminBotIncompleteProfiles(host);
    expect(host.adminBotProfileOverviewError).toBeTruthy();
    expect(host.adminBotProfileOverviewLoadedAt).toBe(1);
  });
});

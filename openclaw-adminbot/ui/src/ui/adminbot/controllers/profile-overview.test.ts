// The profile overview controller: what lands on host state for each answer the service gives.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import {
  loadAdminBotProfileOverview,
  remindAdminBotIncompleteProfiles,
  type AdminBotProfileOverviewHost,
} from "./profile-overview.ts";

function createHost(): AdminBotProfileOverviewHost {
  return {
    settings: { adminBotUrl: "http://127.0.0.1:8765" } as UiSettings,
    adminBotProfileOverview: [],
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
    await loadAdminBotProfileOverview(host);
    expect(host.adminBotProfileOverviewError).toContain("Sign in");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the denominator the service sent", async () => {
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
    const host = createHost();
    routedFetch({
      "/members/profile-overview": () => json({ members: [ROW], mandatory_field_count: 12 }),
    });
    await loadAdminBotProfileOverview(host);
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
    await loadAdminBotProfileOverview(host);
    expect(host.adminBotProfileOverviewError).toBe("insufficient privileges");
    expect(host.adminBotProfileOverview).toEqual([]);
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

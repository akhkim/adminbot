import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import {
  type AdminBotBadgesHost,
  loadAdminBadgeNominations,
  loadBadgeDefinitions,
  shouldLoadAdminBadgeNominations,
  shouldLoadBadgeDefinitions,
  shouldLoadProfileBadgeNominations,
} from "./badges.ts";

function host(): AdminBotBadgesHost {
  return {
    settings: {
      adminBotUrl: "http://127.0.0.1:8765",
    } as AdminBotBadgesHost["settings"],
    adminBotData: {} as AdminBotBadgesHost["adminBotData"],
    adminBotBadgeDefinitions: [],
    adminBotBadgeDefinitionsLoading: false,
    adminBotBadgeDefinitionsLoadedAt: null,
    adminBotBadgeDefinitionsError: null,
    adminBotBadgeNominations: [],
    adminBotBadgeNominationsLoading: false,
    adminBotBadgeNominationsLoadedAt: null,
    adminBotBadgeNominationsError: null,
    adminBotBadgeBusyKey: null,
    adminBotBadgeNotice: null,
    profileBadgeNominations: [],
    profileBadgeNominationsLoading: false,
    profileBadgeNominationsLoadedAt: null,
    profileBadgeNominationsError: null,
    profileBadgeBusy: false,
    profileBadgeNotice: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("adminbot-badges data", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "sess-tok", expiresAt: "later" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads the catalog with the member bearer token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        badges: [
          {
            id: "b1",
            category: "Team Contributor",
            name: "Infra Builder",
            description: "Built the pipeline.",
            family_key: "team_contributor_infra_builder",
            sort_order: 10,
            created_at: "2026-07-01T10:00:00.000Z",
            updated_at: "2026-07-01T10:00:00.000Z",
          },
        ],
      }),
    );
    const h = host();
    await loadBadgeDefinitions(h);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8765/badges");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sess-tok");
    expect(h.adminBotBadgeDefinitions).toHaveLength(1);
    expect(h.adminBotBadgeDefinitionsError).toBeNull();
    expect(h.adminBotBadgeDefinitionsLoadedAt).not.toBeNull();
  });

  // A service deployed before the badge system answers 404 on /badges. That is version skew, not
  // a credentials problem, and telling the admin their session expired sends them round a
  // sign-in loop that cannot fix it.
  it("maps a 404 to not-deployed rather than an expired session", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { message: "not found" } }, 404),
    );
    const h = host();
    await loadBadgeDefinitions(h);

    expect(h.adminBotBadgeDefinitionsError).toBe("not-deployed");
    expect(h.adminBotBadgeDefinitions).toEqual([]);
    expect(h.adminBotBadgeDefinitionsLoadedAt).toBeNull();
  });

  it("maps a 404 on the nomination queue to not-deployed too", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 404));
    const h = host();
    await loadAdminBadgeNominations(h);

    expect(h.adminBotBadgeNominationsError).toBe("not-deployed");
  });

  it("still reports a 401 as an expired session", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 401));
    const h = host();
    await loadBadgeDefinitions(h);

    expect(h.adminBotBadgeDefinitionsError).toBe("expired");
  });

  it("maps a 403 to forbidden and a network failure to unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 403));
    const forbidden = host();
    await loadBadgeDefinitions(forbidden);
    expect(forbidden.adminBotBadgeDefinitionsError).toBe("forbidden");

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    const unreachable = host();
    await loadBadgeDefinitions(unreachable);
    expect(unreachable.adminBotBadgeDefinitionsError).toBe("unreachable");
  });

  // The render pass asks these before every fetch. A failed load leaves loadedAt null and
  // loading false, so without the error term the tab re-fetches on every paint forever.
  it("stops asking for a load once one has failed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 404));
    const h = host();
    expect(shouldLoadBadgeDefinitions(h)).toBe(true);
    expect(shouldLoadAdminBadgeNominations(h)).toBe(true);
    expect(shouldLoadProfileBadgeNominations(h)).toBe(true);

    await loadBadgeDefinitions(h);
    await loadAdminBadgeNominations(h);

    expect(shouldLoadBadgeDefinitions(h)).toBe(false);
    expect(shouldLoadAdminBadgeNominations(h)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops asking for a load once one has succeeded", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ badges: [] }));
    const h = host();
    await loadBadgeDefinitions(h);

    expect(h.adminBotBadgeDefinitionsError).toBeNull();
    expect(shouldLoadBadgeDefinitions(h)).toBe(false);
  });

  it("does not call the service without a stored member session", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    vi.stubGlobal("localStorage", createStorageMock());
    const h = host();
    await loadBadgeDefinitions(h);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.adminBotBadgeDefinitionsError).toBe("no-session");
    expect(shouldLoadBadgeDefinitions(h)).toBe(false);
  });
});

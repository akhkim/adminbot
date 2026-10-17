/* @vitest-environment jsdom */
// The burden rules for "Use my precise location", one test each. Synthetic positions only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRECISE_LOCATION_OPTIONS,
  type PreciseLocationDeps,
  refreshPreciseLocationSilently,
  SILENT_REFRESH_EVERY_MS,
  SILENT_REFRESH_KEY,
  sharePreciseLocation,
  useAdminBotPreciseLocation,
} from "./precise-location.ts";

vi.mock("../auth/session.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/session.ts")>()),
  loadStoredMemberSession: () => ({ sessionToken: "synthetic-token", expiresAt: "2099-01-01" }),
  resolveAdminBotBaseUrl: () => "http://adminbot.test",
}));

const FIX = { coords: { latitude: 44.7, longitude: 10.63, accuracy: 900 } } as GeolocationPosition;

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

function deps(
  overrides: Partial<PreciseLocationDeps> & { permission?: string } = {},
): PreciseLocationDeps & {
  getCurrentPosition: ReturnType<typeof vi.fn>;
  report: ReturnType<typeof vi.fn>;
} {
  const getCurrentPosition = vi.fn((ok: PositionCallback) => ok(FIX));
  const report = vi.fn(async () => ({
    ok: true as const,
    value: { recorded: true, city: "Reggio Emilia", region: "Emilia-Romagna", country: "IT" },
  }));
  return {
    geolocation: { getCurrentPosition },
    permissions: { query: async () => ({ state: overrides.permission ?? "granted" }) },
    isSecureContext: true,
    storage: memoryStorage(),
    now: () => Date.parse("2026-10-16T12:00:00Z"),
    ...overrides,
    getCurrentPosition,
    report: (overrides.report as ReturnType<typeof vi.fn>) ?? report,
  };
}

describe("silent refresh", () => {
  it("asks every time it is told to while location is not allowed, and never once refused", async () => {
    for (const permissions of [
      { query: async () => ({ state: "prompt" }) },
      undefined, // No Permissions API: unknown until asked, so treated as "prompt".
    ]) {
      const d = deps({ permissions });
      expect(await refreshPreciseLocationSilently(d, "auto", { ask: true })).toEqual({
        city: "Reggio Emilia",
        region: "Emilia-Romagna",
        country: "IT",
      });
      // Dismissed: the next sign-in or dashboard visit, even a minute later, asks again.
      await refreshPreciseLocationSilently(d, "auto", { ask: true });
      await refreshPreciseLocationSilently(d, "auto", { ask: true });
      expect(d.getCurrentPosition).toHaveBeenCalledTimes(3);
      // Without `ask`, an unanswered permission is left alone.
      expect(await refreshPreciseLocationSilently(d, "auto")).toBeUndefined();
      expect(d.getCurrentPosition).toHaveBeenCalledTimes(3);
    }
    const denied = deps({ permission: "denied" });
    expect(await refreshPreciseLocationSilently(denied, "auto", { ask: true })).toBeUndefined();
    expect(denied.getCurrentPosition).not.toHaveBeenCalled();
  });

  it("reads city-level when granted and sends only the two numbers", async () => {
    const d = deps();
    expect(await refreshPreciseLocationSilently(d, "auto")).toEqual({
      city: "Reggio Emilia",
      region: "Emilia-Romagna",
      country: "IT",
    });
    expect(d.getCurrentPosition.mock.calls[0]![2]).toEqual(PRECISE_LOCATION_OPTIONS);
    expect(d.report).toHaveBeenCalledWith({ lat: 44.7, lon: 10.63 });
    // The throttle keeps a time, never a position.
    expect([...(d.storage as ReturnType<typeof memoryStorage>).data.values()]).toEqual([
      String(Date.parse("2026-10-16T12:00:00Z")),
    ]);
  });

  it("reads at most once an hour per device", async () => {
    const storage = memoryStorage();
    let now = Date.parse("2026-10-16T12:00:00Z");
    const d = deps({ storage, now: () => now });
    await refreshPreciseLocationSilently(d, "auto");
    now += SILENT_REFRESH_EVERY_MS - 1;
    await refreshPreciseLocationSilently(d, "auto");
    expect(d.getCurrentPosition).toHaveBeenCalledTimes(1);
    now += 1;
    await refreshPreciseLocationSilently(d, "auto");
    expect(d.getCurrentPosition).toHaveBeenCalledTimes(2);
    expect(storage.data.has(SILENT_REFRESH_KEY)).toBe(true);
  });

  it("never asks or reads a member who is hidden or shown by their stated city", async () => {
    for (const visibility of ["hidden", "stated", null] as const) {
      const d = deps({ permission: "prompt" });
      expect(await refreshPreciseLocationSilently(d, visibility, { ask: true })).toBeUndefined();
      expect(d.getCurrentPosition).not.toHaveBeenCalled();
    }
  });

  it("swallows every failure and shows nothing", async () => {
    const failing = [
      deps({
        geolocation: {
          getCurrentPosition: (_ok, fail) => fail?.({ code: 3 } as GeolocationPositionError),
        },
      }),
      deps({
        report: vi.fn(async () => {
          throw new Error("offline");
        }),
      }),
      deps({ report: vi.fn(async () => ({ ok: false as const, kind: "unreachable" })) as never }),
      deps({
        permissions: {
          query: async () => {
            throw new Error("unsupported");
          },
        },
      }),
      deps({
        storage: {
          getItem: () => {
            throw new Error("blocked");
          },
          setItem: () => {
            throw new Error("blocked");
          },
        },
      }),
    ];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const d of failing.slice(0, 4)) {
      await expect(refreshPreciseLocationSilently(d, "auto")).resolves.toBeUndefined();
    }
    // Blocked storage still reads (the service writes at most daily) and still resolves quietly.
    await expect(refreshPreciseLocationSilently(failing[4]!, "auto")).resolves.toMatchObject({
      city: "Reggio Emilia",
    });
    expect(errors).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
    errors.mockRestore();
    warns.mockRestore();
  });
});

describe("the browser's answer", () => {
  function refusing(after: string) {
    let state = "prompt";
    return {
      geolocation: {
        getCurrentPosition: (_ok: PositionCallback, fail?: PositionErrorCallback | null) => {
          state = after;
          fail?.({ code: 1 } as GeolocationPositionError);
        },
      },
      permissions: { query: async () => ({ state }) },
    };
  }

  it("reports allowed, blocked, or closed without an answer", async () => {
    const allowed = vi.fn();
    await refreshPreciseLocationSilently(
      deps({ permission: "prompt", reportPermission: allowed }),
      "auto",
      { ask: true },
    );
    expect(allowed).toHaveBeenCalledWith("granted");

    // Chrome gives the same error code for Block and for closing the prompt; only Block sticks.
    for (const [after, answer] of [
      ["denied", "denied"],
      ["prompt", "dismissed"],
    ] as const) {
      const reportPermission = vi.fn();
      const d = deps({ ...refusing(after), reportPermission });
      expect(await refreshPreciseLocationSilently(d, "auto", { ask: true })).toBeUndefined();
      expect(reportPermission).toHaveBeenCalledWith(answer);
      const pressed = vi.fn();
      expect(
        await sharePreciseLocation({ ...deps({ ...refusing(after) }), reportPermission: pressed }),
      ).toEqual({ note: "denied" });
      expect(pressed).toHaveBeenCalledWith(answer);
    }
  });

  it("reports an existing block or grant without asking, and nothing for a hidden member", async () => {
    const blocked = vi.fn();
    const d = deps({ permission: "denied", reportPermission: blocked });
    await refreshPreciseLocationSilently(d, "auto");
    expect(blocked).toHaveBeenCalledWith("denied");
    expect(d.getCurrentPosition).not.toHaveBeenCalled();

    const granted = vi.fn();
    const g = deps({ reportPermission: granted });
    await refreshPreciseLocationSilently(g, "auto");
    await refreshPreciseLocationSilently(g, "auto"); // Throttled read, still reported.
    expect(granted).toHaveBeenCalledWith("granted");
    expect(g.getCurrentPosition).toHaveBeenCalledTimes(1);

    const hidden = vi.fn();
    await refreshPreciseLocationSilently(
      deps({ permission: "denied", reportPermission: hidden }),
      "hidden",
    );
    expect(hidden).not.toHaveBeenCalled();
  });
});

describe("the button", () => {
  it("reads on a press, whatever the permission says", async () => {
    const d = deps({ permission: "prompt" });
    expect(await sharePreciseLocation(d)).toEqual({
      place: { city: "Reggio Emilia", region: "Emilia-Romagna", country: "IT" },
    });
    expect(d.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(d.getCurrentPosition.mock.calls[0]![2]).toMatchObject({
      enableHighAccuracy: false,
      timeout: 10_000,
    });
  });

  it("says why when the browser refuses or no city comes back", async () => {
    const denied = deps({
      geolocation: {
        getCurrentPosition: (_ok, fail) => fail?.({ code: 1 } as GeolocationPositionError),
      },
    });
    expect(await sharePreciseLocation(denied)).toEqual({ note: "denied" });
    const unplaced = deps({
      report: vi.fn(async () => ({ ok: true as const, value: { recorded: false } })) as never,
    });
    expect(await sharePreciseLocation(unplaced)).toEqual({ note: "unavailable" });
    expect(await sharePreciseLocation(deps({ isSecureContext: false }))).toEqual({
      note: "unavailable",
    });
  });
});

describe("useAdminBotPreciseLocation", () => {
  let host: Parameters<typeof useAdminBotPreciseLocation>[0];
  beforeEach(() => {
    host = {
      memberId: "m_synthetic",
      settings: {} as never,
      adminBotData: { members: [{ id: "m_synthetic" }] },
    };
  });

  it("keeps the city in host state and nothing positional", async () => {
    await useAdminBotPreciseLocation(host, () => {}, deps());
    expect(host.adminBotPreciseLocation).toEqual({
      place: { city: "Reggio Emilia", region: "Emilia-Romagna", country: "IT" },
      busy: false,
      note: null,
    });
    expect(JSON.stringify(host)).not.toMatch(/44\.7|10\.63/u);
  });

  it("does nothing for a hidden member, or before their record has loaded", async () => {
    const d = deps();
    host.adminBotData = { members: [{ id: "m_synthetic", map_visibility: "hidden" }] };
    await useAdminBotPreciseLocation(host, () => {}, d);
    host.adminBotData = { members: [] };
    await useAdminBotPreciseLocation(host, () => {}, d);
    expect(d.getCurrentPosition).not.toHaveBeenCalled();
    expect(host.adminBotPreciseLocation).toBeUndefined();
  });
});

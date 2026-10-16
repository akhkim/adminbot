/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerLocationCheckin,
  declineLocationCheckin,
  loadAdminBotLocationPrompt,
  prepareProfileLocationPrompt,
  snoozeLocationCheckin,
  useDeviceForLocationCheckin,
} from "./location-prompt.ts";

it("defers blocked reads and retries an earlier rejected read after unlocking", () => {
  const host: Parameters<typeof prepareProfileLocationPrompt>[0] = { adminBotLocationDrift: null };
  expect(prepareProfileLocationPrompt(host, true)).toBe(false);
  expect(host.adminBotLocationDrift).toBeUndefined();
  expect(prepareProfileLocationPrompt(host, true)).toBe(false);
  expect(prepareProfileLocationPrompt(host, false)).toBe(true);
  host.adminBotLocationDrift = null;
  expect(prepareProfileLocationPrompt(host, false)).toBe(false);
});

// --- the check-in -------------------------------------------------------------------------------

const api = vi.hoisted(() => ({
  respondToLocationCheckin: vi.fn(),
  fetchLocationPlaces: vi.fn(),
  fetchLocationPrompt: vi.fn(),
  loadAdminBot: vi.fn(),
}));

vi.mock("../api/profile.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/profile.ts")>()),
  respondToLocationCheckin: api.respondToLocationCheckin,
  fetchLocationPlaces: api.fetchLocationPlaces,
  fetchLocationPrompt: api.fetchLocationPrompt,
}));
vi.mock("../auth/session.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/session.ts")>()),
  loadStoredMemberSession: () => ({ sessionToken: "synthetic-token", expiresAt: "2099-01-01" }),
  resolveAdminBotBaseUrl: () => "http://adminbot.test",
}));
vi.mock("./admin.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./admin.ts")>()),
  loadAdminBot: api.loadAdminBot,
}));

type Host = Parameters<typeof answerLocationCheckin>[0];

function checkinHost(): Host {
  return {
    memberId: "m_synthetic",
    settings: {},
    adminBotLocationCheckin: {
      checkin: { due: true, reason: "no_guess", suggestion: { city: "Toronto", source: "login" } },
      mode: "confirm",
    },
  } as unknown as Host;
}

describe("location check-in controller", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) {
      fn.mockReset();
    }
    api.respondToLocationCheckin.mockResolvedValue({
      ok: true,
      value: { due: false, reason: "answered" },
    });
    api.loadAdminBot.mockResolvedValue(undefined);
  });

  it("one-tap Yes sends the guessed city as the answer and closes the banner", async () => {
    const host = checkinHost();
    await answerLocationCheckin(host, "Toronto", "picker");
    expect(api.respondToLocationCheckin).toHaveBeenCalledWith(
      { action: "answer", city: "Toronto", via: "picker" },
      "synthetic-token",
      "http://adminbot.test",
    );
    expect(host.adminBotLocationCheckin).toBeNull();
    expect(api.loadAdminBot).toHaveBeenCalledOnce();
  });

  it("dismissing snoozes, and does not reload the roster", async () => {
    const host = checkinHost();
    await snoozeLocationCheckin(host);
    expect(api.respondToLocationCheckin.mock.calls[0]?.[0]).toEqual({ action: "snooze" });
    expect(host.adminBotLocationCheckin).toBeNull();
    expect(api.loadAdminBot).not.toHaveBeenCalled();
  });

  it("keeps the banner open with the error when saving fails", async () => {
    api.respondToLocationCheckin.mockResolvedValue({ ok: false, kind: "http", message: "Nope" });
    const host = checkinHost();
    await declineLocationCheckin(host);
    expect(host.adminBotLocationCheckin).toMatchObject({ error: "Nope" });
    expect(host.adminBotLocationCheckin?.busy).toBeUndefined();
  });

  it("device location sends only the nearest city's name, never the position", async () => {
    api.fetchLocationPlaces.mockResolvedValue({
      ok: true,
      value: [{ key: "berlin", label: "Berlin", country: "Germany", lat: 52.52, lon: 13.4 }],
    });
    const geolocation = {
      getCurrentPosition: vi.fn((success: PositionCallback) =>
        success({ coords: { latitude: 52.5, longitude: 13.38 } } as GeolocationPosition),
      ),
    };
    const host = checkinHost();
    await useDeviceForLocationCheckin(host, geolocation);
    expect(geolocation.getCurrentPosition).toHaveBeenCalledOnce();
    const sent = api.respondToLocationCheckin.mock.calls[0]?.[0];
    expect(sent).toEqual({ action: "answer", city: "Berlin", via: "device" });
    expect(JSON.stringify(sent)).not.toMatch(/52\.|13\./);
  });

  it("says so, and sends nothing, when permission is declined", async () => {
    api.fetchLocationPlaces.mockResolvedValue({ ok: true, value: [] });
    const geolocation = {
      getCurrentPosition: vi.fn((_ok: PositionCallback, fail?: PositionErrorCallback | null) =>
        fail?.({ code: 1 } as GeolocationPositionError),
      ),
    };
    const host = checkinHost();
    await useDeviceForLocationCheckin(host, geolocation);
    expect(api.respondToLocationCheckin).not.toHaveBeenCalled();
    expect(host.adminBotLocationCheckin?.error).toMatch(/declined/);
  });

  it("shows the banner at most once per session", async () => {
    sessionStorage.clear();
    api.fetchLocationPrompt.mockResolvedValue({
      ok: true,
      value: {
        drift: null,
        checkin: {
          due: true,
          reason: "no_guess",
          suggestion: { city: "Toronto", source: "stored" },
        },
      },
    });
    const first = { memberId: "m_synthetic", settings: {} } as unknown as Host;
    await loadAdminBotLocationPrompt(first);
    expect(first.adminBotLocationCheckin?.mode).toBe("confirm");
    const reload = { memberId: "m_synthetic", settings: {} } as unknown as Host;
    await loadAdminBotLocationPrompt(reload);
    expect(reload.adminBotLocationCheckin).toBeNull();
  });
});

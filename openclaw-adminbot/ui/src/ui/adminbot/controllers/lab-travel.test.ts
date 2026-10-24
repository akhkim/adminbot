/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoredMemberSession, saveStoredMemberSession } from "../auth/session.ts";
import {
  clearLabTravel,
  disableSharing,
  enableSharing,
  stopLocationTracking,
  syncLocationTracking,
  type LabTravelHost,
} from "./lab-travel.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function host(overrides: Partial<LabTravelHost> = {}): LabTravelHost {
  return {
    settings: { adminBotUrl: "http://adminbot.test" } as LabTravelHost["settings"],
    memberId: "ada",
    memberPrivilegeLevel: "member",
    ...overrides,
  };
}

const geolocation = {
  watchPosition: vi.fn(() => 3),
  clearWatch: vi.fn(),
  getCurrentPosition: vi.fn(),
};
let permission = "granted";

beforeEach(() => {
  Object.defineProperty(navigator, "geolocation", { value: geolocation, configurable: true });
  Object.defineProperty(navigator, "permissions", {
    value: { query: async () => ({ state: permission }) },
    configurable: true,
  });
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  saveStoredMemberSession({ sessionToken: "session-ada", expiresAt: "2099-01-01T00:00:00Z" });
  permission = "granted";
});

afterEach(() => {
  stopLocationTracking();
  clearStoredMemberSession();
  vi.restoreAllMocks();
  geolocation.watchPosition.mockClear();
  geolocation.clearWatch.mockClear();
});

const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("location tracking across the session", () => {
  it("reads the opt-in once, then watches for a sharing member whose browser allows it", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(200, { sharing: { enabled: true } }));
    const h = host();
    const update = vi.fn();
    syncLocationTracking(h, update);
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://adminbot.test/travel/sharing");
    expect(h.labTravelSharing).toEqual({ enabled: true });
    syncLocationTracking(h, update);
    await settle();
    expect(geolocation.watchPosition).toHaveBeenCalledOnce();
    // Rendering again does not start a second watch or re-read the opt-in.
    syncLocationTracking(h, update);
    await settle();
    expect(geolocation.watchPosition).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();

    // Signing out stops it.
    clearStoredMemberSession();
    syncLocationTracking(h, update);
    expect(geolocation.clearWatch).toHaveBeenCalledWith(3);
  });

  it("does not prompt on load when this browser has not granted permission", async () => {
    permission = "prompt";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(200, { sharing: { enabled: true } }));
    const h = host();
    syncLocationTracking(h, vi.fn());
    await settle();
    syncLocationTracking(h, vi.fn());
    await settle();
    expect(geolocation.watchPosition).not.toHaveBeenCalled();
    expect(h.labTravelDevice?.status).toBe("needs-permission");
  });

  it("never asks on behalf of a trial member or external collaborator", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const level of ["trial", "external_collaborator"]) {
      syncLocationTracking(host({ memberPrivilegeLevel: level }), vi.fn());
    }
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opts in and starts watching from the press, and stops before opting out", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/travel/sharing") && init?.method === "PUT") {
        const enabled = JSON.parse(String(init.body)).enabled as boolean;
        return json(200, { sharing: { enabled } });
      }
      if (url.endsWith("/travel")) {
        return json(200, {
          today: "2026-10-13",
          conferences: [],
          sharing: { enabled: true },
          plans: [],
          matches: [],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const h = host();
    await enableSharing(h, vi.fn());
    await settle();
    expect(h.labTravelSharing?.enabled).toBe(true);
    expect(geolocation.watchPosition).toHaveBeenCalledOnce();
    expect(h.labTravelNotice?.kind).toBe("success");

    await disableSharing(h);
    expect(geolocation.clearWatch).toHaveBeenCalledWith(3);
    const order = fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(order).toContain("PUT");
    expect(h.labTravelDevice?.status).toBe("idle");
  });

  it("forgets everything, and stops watching, on clear", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(200, { sharing: { enabled: true } }));
    const h = host();
    syncLocationTracking(h, vi.fn());
    await settle();
    syncLocationTracking(h, vi.fn());
    await settle();
    expect(geolocation.watchPosition).toHaveBeenCalledOnce();
    clearLabTravel(h);
    expect(geolocation.clearWatch).toHaveBeenCalled();
    expect(h.labTravelSharing).toBeNull();
    expect(h.labTravelSharingCheckedFor).toBeNull();
  });
});

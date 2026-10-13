/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoredMemberSession, saveStoredMemberSession } from "../auth/session.ts";
import type { TravelConference } from "../data/lab-travel.ts";
import {
  clearLabTravel,
  disableSharing,
  editRsvpDraft,
  enableSharing,
  rsvpDraftError,
  rsvpDraftFrom,
  savePlans,
  stopLocationTracking,
  syncLocationTracking,
  type LabTravelHost,
} from "./lab-travel.ts";

const SITE: TravelConference = {
  key: "emnlp:2026",
  group_key: "emnlp:2026",
  label: "EMNLP 2026",
  conference_label: "EMNLP 2026",
  family: "EMNLP",
  year: 2026,
  multi_site: false,
  starts: "2026-10-24",
  ends: "2026-10-29",
  going: [],
  undecided_count: 0,
  airbnb_count: 0,
};

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

describe("RSVP drafts", () => {
  it("start blank for a new conference and prefill from an earlier answer", () => {
    expect(rsvpDraftFrom(SITE).intent).toBe("");
    expect(rsvpDraftError(rsvpDraftFrom(SITE))).toMatch(/Going or Maybe/u);
    const answered = rsvpDraftFrom({
      ...SITE,
      unsited_rsvp: {
        conference_key: "emnlp:2026",
        member_id: "ada",
        intent: "going",
        funding: "flight_only",
        needs_lodging: true,
        needs_visa_letter: true,
        updated_at: "x",
      },
    });
    expect(answered).toMatchObject({ intent: "going", airbnb: true, funding: "flight_only" });
  });

  it("fill the Airbnb nights from the conference days, never over an edited night", () => {
    const h = host();
    editRsvpDraft(h, SITE, { intent: "going" });
    editRsvpDraft(h, SITE, { airbnb: true });
    expect(h.labTravelRsvpDrafts?.[SITE.key]).toMatchObject({
      arrival_on: "2026-10-24",
      departure_on: "2026-10-29",
    });
    editRsvpDraft(h, SITE, { airbnb: false });
    editRsvpDraft(h, SITE, { arrival_on: "2026-10-22" });
    editRsvpDraft(h, SITE, { airbnb: true });
    expect(h.labTravelRsvpDrafts?.[SITE.key]?.arrival_on).toBe("2026-10-22");
  });
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

describe("saving plans", () => {
  it("writes the schedule's trips and keeps the roster copy in step", async () => {
    const trips = [{ start: "2026-11-01", end: "2026-11-05", city: "Berlin" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/lab/members/ada") && init?.method === "PUT") {
        return json(200, { id: "ada", name: "Ada", trips });
      }
      return json(200, {
        today: "2026-10-13",
        conferences: [],
        sharing: { enabled: false },
        plans: trips,
        matches: [],
      });
    });
    const h = host({ adminBotData: { members: [{ id: "ada", trips: [] }, { id: "bob" }] } });
    expect(await savePlans(h, trips)).toBe(true);
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({ trips });
    expect(h.adminBotData?.members[0]?.trips).toEqual(trips);
    expect(h.labTravel?.plans).toEqual(trips);
  });
});

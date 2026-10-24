import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiSettings } from "../../storage.ts";
import {
  invalidateMemberMap,
  loadMemberMap,
  MEMBER_MAP_REFRESH_MS,
  needsMemberMap,
  parseMemberMap,
  type MemberMapHost,
} from "./member-map.ts";

afterEach(() => vi.restoreAllMocks());

function mapResponse(label: string): Response {
  return new Response(
    JSON.stringify({
      mode: "summary",
      places: [{ key: label, label, country: "Canada", lat: 43, lon: -79, count: 1 }],
      counts: { placed: 1, unplaced: 0, unknown: 0 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("Dashboard member map loading", () => {
  it("requests the map only on a signed-in Dashboard or Collaborate that has not requested it", () => {
    expect(needsMemberMap("dashboard", true, undefined, false)).toBe(true);
    // Collaborate (tab id labSharing) shows the same card, so opening it directly -- without a
    // Dashboard visit first -- has to start the load too.
    expect(needsMemberMap("labSharing", true, undefined, false)).toBe(true);
    expect(needsMemberMap("labSharing", false, undefined, false)).toBe(false);
    expect(needsMemberMap("profile", true, undefined, false)).toBe(false);
    expect(needsMemberMap("myWork", true, undefined, false)).toBe(false);
    expect(needsMemberMap("dashboard", false, undefined, false)).toBe(false);
    expect(needsMemberMap("dashboard", true, undefined, true)).toBe(false);
    expect(needsMemberMap("dashboard", true, null, false)).toBe(false);
  });

  it("reads the map again when its tab is opened and every 5 minutes while it is visible", () => {
    const map = parseMemberMap({
      mode: "summary",
      places: [{ key: "toronto", label: "Toronto", lat: 43, lon: -79, count: 1 }],
      counts: { placed: 1, unplaced: 0, unknown: 0 },
    });
    const now = Date.parse("2026-10-15T12:00:00Z");
    const fresh = { now, checkedAt: now - 60_000, visible: true };
    // Already on the tab, read a minute ago: nothing to do.
    expect(
      needsMemberMap("dashboard", true, map, false, { ...fresh, previousTab: "dashboard" }),
    ).toBe(false);
    // Arriving from another tab reads it again, whichever map tab it is.
    expect(
      needsMemberMap("labSharing", true, map, false, { ...fresh, previousTab: "dashboard" }),
    ).toBe(true);
    expect(
      needsMemberMap("dashboard", true, map, false, { ...fresh, previousTab: "profile" }),
    ).toBe(true);
    // Five minutes on, while the page is visible -- and not while it sits in a background tab.
    const due = { now, checkedAt: now - MEMBER_MAP_REFRESH_MS, previousTab: "dashboard" };
    expect(needsMemberMap("dashboard", true, map, false, { ...due, visible: true })).toBe(true);
    expect(needsMemberMap("dashboard", true, map, false, { ...due, visible: false })).toBe(false);
    // Never while a read is in flight, and never off the map tabs.
    expect(needsMemberMap("dashboard", true, map, true, { ...due, visible: true })).toBe(false);
    expect(needsMemberMap("profile", true, map, false, { ...due, visible: true })).toBe(false);
  });

  it("stamps when the map was read, and keeps the last good map when a refresh fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mapResponse("toronto"));
    const host: MemberMapHost = {
      settings: { adminBotUrl: "http://127.0.0.1:8765" } as UiSettings,
      adminBotMemberMap: undefined,
      adminBotMemberMapLoading: false,
    };
    const before = Date.now();
    await loadMemberMap(host);
    expect(host.adminBotMemberMap?.loadedAt).toBeGreaterThanOrEqual(before);
    expect(host.adminBotMemberMapCheckedAt).toBeGreaterThanOrEqual(before);

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));
    await loadMemberMap(host);
    expect(host.adminBotMemberMap?.places[0].label).toBe("toronto");
    expect(host.adminBotMemberMapLoading).toBe(false);
  });

  it.each(["old first", "new first"])(
    "ignores a superseded map response after profile refresh (%s)",
    async (order) => {
      const resolveFetch: Array<(response: Response) => void> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch.push(resolve);
          }),
      );
      const host: MemberMapHost = {
        settings: { adminBotUrl: "http://127.0.0.1:8765" } as UiSettings,
        adminBotMemberMap: undefined,
        adminBotMemberMapLoading: false,
      };
      const oldRead = loadMemberMap(host);
      invalidateMemberMap(host); // a profile edit or Dashboard refresh
      expect(host.adminBotMemberMapLoading).toBe(false);
      const newRead = loadMemberMap(host);

      if (order === "old first") {
        resolveFetch[0](mapResponse("old"));
        await oldRead;
        expect(host.adminBotMemberMap).toBeUndefined();
        expect(host.adminBotMemberMapLoading).toBe(true);
        resolveFetch[1](mapResponse("new"));
        await newRead;
      } else {
        resolveFetch[1](mapResponse("new"));
        await newRead;
        resolveFetch[0](mapResponse("old"));
        await oldRead;
      }
      expect(host.adminBotMemberMap?.places[0].label).toBe("new");
      expect(host.adminBotMemberMapLoading).toBe(false);
    },
  );
});

describe("parseMemberMap", () => {
  it("keeps who is not on the map, name and reason only, and only on the full map", () => {
    const notOnMap = [
      { name: "Hal", reason: "hidden", member_id: "h", city: "Berlin" },
      { name: "Ivo", reason: "ip_off" },
      { name: "Jo", reason: "teleported" },
      { name: "   ", reason: "no_location" },
      { reason: "no_location" },
    ];
    const full = parseMemberMap({ mode: "full", places: [], not_on_map: notOnMap });
    expect(full?.notOnMap).toEqual([
      { name: "Hal", reason: "hidden" },
      { name: "Ivo", reason: "ip_off" },
    ]);
    const summary = parseMemberMap({ mode: "summary", places: [], not_on_map: notOnMap });
    expect(summary?.notOnMap).toBeUndefined();
    expect(parseMemberMap({ mode: "full", places: [] })?.notOnMap).toBeUndefined();
  });

  it("marks country-level places as approximate and nothing else", () => {
    const map = parseMemberMap({
      mode: "summary",
      places: [
        { key: "toronto", label: "Toronto", country: "Canada", lat: 43.65, lon: -79.38, count: 2 },
        { key: "country:france", label: "France", country: "France", lat: 46, lon: 2, count: 1 },
      ],
      counts: { placed: 3, unplaced: 0, unknown: 0 },
    });
    expect(map?.places.map((place) => [place.key, place.approximate])).toEqual([
      ["toronto", false],
      ["country:france", true],
    ]);
  });

  it("keeps each member's source and precision, and drops values it does not know", () => {
    const map = parseMemberMap({
      mode: "full",
      places: [
        {
          key: "toronto",
          label: "Toronto",
          country: "Canada",
          lat: 43.65,
          lon: -79.38,
          members: [
            { member_id: "a", name: "Ada", source: "login", precision: "city" },
            { member_id: "b", name: "Bo", source: "gps", precision: "street" },
          ],
        },
      ],
    });
    expect(map?.places[0]?.members).toEqual([
      { member_id: "a", name: "Ada", source: "login", precision: "city" },
      { member_id: "b", name: "Bo" },
    ]);
  });

  it("keeps a check-in source, its date, and a well-formed time zone mismatch", () => {
    const map = parseMemberMap({
      mode: "full",
      places: [
        {
          key: "toronto",
          label: "Toronto",
          country: "Canada",
          lat: 43.65,
          lon: -79.38,
          members: [
            {
              member_id: "a",
              name: "Ada",
              source: "checkin",
              precision: "city",
              located_at: "2026-07-12T10:00:00.000Z",
              tz_mismatch: { slack_tz: "Europe/Berlin", place_tz: "America/Toronto", hours: 6 },
            },
            { member_id: "b", name: "Bo", located_at: "not a date", tz_mismatch: { hours: "x" } },
          ],
        },
      ],
    });
    expect(map?.places[0]?.members).toEqual([
      {
        member_id: "a",
        name: "Ada",
        source: "checkin",
        precision: "city",
        located_at: "2026-07-12T10:00:00.000Z",
        tz_mismatch: { slack_tz: "Europe/Berlin", place_tz: "America/Toronto", hours: 6 },
      },
      { member_id: "b", name: "Bo" },
    ]);
  });

  it("never turns a null or blank member name into a printed name", () => {
    const map = parseMemberMap({
      mode: "full",
      places: [
        {
          key: "toronto",
          label: "Toronto",
          country: "Canada",
          lat: 43.65,
          lon: -79.38,
          count: 4,
          members: [
            { member_id: "a", name: "Ada" },
            { member_id: "b", name: null },
            { member_id: "c", name: "  " },
            { member_id: "d", name: "Null" },
          ],
        },
      ],
      counts: { placed: 4, unplaced: 0, unknown: 0 },
    });
    expect(map?.places[0]?.members?.map((member) => member.name)).toEqual(["Ada"]);
  });

  it("keeps the service's own phrase for where a pin came from, and the daily IP reading", () => {
    const place = (members: unknown[]) =>
      parseMemberMap({
        mode: "full",
        places: [
          { key: "toronto", label: "Toronto", country: "Canada", lat: 43, lon: -79, members },
        ],
        counts: { placed: members.length, unplaced: 0, unknown: 0 },
      })?.places[0]?.members;
    const [device, vpn, junk] = place([
      {
        member_id: "a",
        name: "Ada",
        source: "device",
        precision: "timezone",
        source_label: "  device time zone  ",
      },
      {
        member_id: "b",
        name: "Bo",
        source: "roster",
        source_label: "profile · IP ignored (VPN?)",
        ip_ignored: "suspected_vpn",
        ip_observed_at: "2026-10-15T08:00:00.000Z",
      },
      {
        member_id: "c",
        name: "Cy",
        source_label: "x".repeat(200),
        ip_ignored: "maybe",
        ip_observed_at: "yesterday",
      },
    ])!;
    expect(device).toMatchObject({ source: "device", source_label: "device time zone" });
    expect(vpn).toMatchObject({
      source_label: "profile · IP ignored (VPN?)",
      ip_ignored: "suspected_vpn",
      ip_observed_at: "2026-10-15T08:00:00.000Z",
    });
    // Bounded, and nothing it does not understand.
    expect(junk?.source_label).toHaveLength(80);
    expect(junk).not.toHaveProperty("ip_ignored");
    expect(junk).not.toHaveProperty("ip_observed_at");
  });
});

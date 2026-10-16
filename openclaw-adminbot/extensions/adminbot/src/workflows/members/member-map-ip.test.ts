// The daily IP reading and its VPN check, as the map sees them. Synthetic members only.
import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  ADMINBOT_MAP_LOGIN_FRESH_DAYS,
  buildMemberMap,
  ipCityState,
  ipReadingSetAside,
  ipReadingVerdict,
  usableDeviceZone,
} from "./member-map.js";

const now = new Date("2026-07-15T12:00:00.000Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

function member(overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id: "m_ip",
    name: "Test Person",
    privilege_level: "member",
    access: [],
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const ipFrom = (city: string, region: string, country: string) => ({
  last_login_city: city,
  last_login_region: region,
  last_login_country: country,
});

function placeOf(overrides: Partial<AdminBotLabMember>, loginCity = true) {
  const map = buildMemberMap([member(overrides)], new Map(), { loginCity, now });
  const place = map.places[0];
  return place ? { label: place.label, ...place.members[0] } : undefined;
}

describe("freshness window", () => {
  it("is seven days", () => {
    expect(ADMINBOT_MAP_LOGIN_FRESH_DAYS).toBe(7);
  });
});

describe("the IP city on the map", () => {
  it("dates the city by the latest daily reading, not the weeks-old sign-in", () => {
    const placed = placeOf({
      ...ipFrom("Toronto", "Ontario", "CA"),
      current_city: "Zurich",
      last_login_at: ago(40),
      last_ip_observed_at: ago(0),
    });
    expect(placed).toMatchObject({
      label: "Toronto",
      source: "login",
      ip_observed_at: ago(0),
      last_login_at: ago(0),
      located_at: ago(0),
      source_label: "IP today",
    });
  });

  it("labels the reading's age by UTC day", () => {
    expect(
      placeOf({ ...ipFrom("Toronto", "Ontario", "CA"), last_ip_observed_at: ago(1) })?.source_label,
    ).toBe("IP yesterday");
    expect(
      placeOf({ ...ipFrom("Toronto", "Ontario", "CA"), last_ip_observed_at: ago(2) })?.source_label,
    ).toBe("IP 2d ago");
  });

  it("uses an IP city that agrees with the device zone", () => {
    const placed = placeOf({
      ...ipFrom("Toronto", "Ontario", "CA"),
      last_ip_observed_at: ago(0),
      last_device_tz: "America/Toronto",
      last_device_tz_at: ago(0),
      current_city: "Zurich",
    });
    expect(placed).toMatchObject({ label: "Toronto", source: "login" });
    expect(placed?.ip_ignored).toBeUndefined();
  });

  it("ignores a reading flagged as a VPN and falls back to the stated city", () => {
    const placed = placeOf({
      ...ipFrom("Toronto", "Ontario", "CA"),
      last_ip_observed_at: ago(0),
      last_ip_suspected_vpn: true,
      current_city: "Zurich",
    });
    expect(placed).toMatchObject({
      label: "Zürich",
      source: "roster",
      ip_ignored: "suspected_vpn",
      source_label: "profile · IP ignored (VPN?)",
    });
    expect(placed?.ip_observed_at).toBeUndefined();
  });

  it("falls back to the device zone's city, then the Slack zone's, when nothing is stated", () => {
    const vpn = {
      ...ipFrom("Toronto", "Ontario", "CA"),
      last_ip_observed_at: ago(0),
      last_ip_suspected_vpn: true,
    };
    expect(
      placeOf({
        ...vpn,
        last_device_tz: "Europe/Zurich",
        last_device_tz_at: ago(0),
        slack_tz: "Europe/Berlin",
        slack_tz_observed_at: ago(1),
      }),
    ).toMatchObject({
      label: "Zürich",
      source: "device",
      precision: "timezone",
      source_label: "device time zone · IP ignored (VPN?)",
    });
    expect(
      placeOf({ ...vpn, slack_tz: "Europe/Berlin", slack_tz_observed_at: ago(1) }),
    ).toMatchObject({ label: "Berlin", source: "slack", ip_ignored: "suspected_vpn" });
  });

  it("does not let a VPN exit's country place the member either", () => {
    const placed = placeOf({
      ...ipFrom("Toronto", "Ontario", "CA"),
      last_ip_observed_at: ago(0),
      last_ip_suspected_vpn: true,
    });
    expect(placed).toBeUndefined();
  });

  it("judges an unflagged legacy reading against the device zone at map time", () => {
    expect(
      ipCityState(
        member({
          ...ipFrom("Toronto", "Ontario", "CA"),
          last_ip_observed_at: ago(1),
          last_device_tz: "Europe/Zurich",
          last_device_tz_at: ago(0),
        }),
        now,
      ),
    ).toEqual({ ignored: "suspected_vpn" });
  });

  it("says nothing about an ignored IP to a caller who may not see IP cities", () => {
    const placed = placeOf(
      {
        ...ipFrom("Toronto", "Ontario", "CA"),
        last_ip_observed_at: ago(0),
        last_ip_suspected_vpn: true,
        current_city: "Zurich",
      },
      false,
    );
    expect(placed?.ip_ignored).toBeUndefined();
    expect(placed?.source_label).toBe("profile");
  });

  it("forgets a VPN flag once the reading itself is stale", () => {
    expect(
      ipCityState(
        member({
          ...ipFrom("Toronto", "Ontario", "CA"),
          last_ip_observed_at: ago(8),
          last_ip_suspected_vpn: true,
        }),
        now,
      ),
    ).toEqual({});
  });
});

describe("ipReadingVerdict", () => {
  const toronto = { city: "Toronto", region: "Ontario", country: "CA" };

  it("flags an IP city more than two hours from the device zone", () => {
    expect(
      ipReadingVerdict({ location: toronto, deviceTz: "Europe/Zurich", at: now }),
    ).toMatchObject({ suspected_vpn: true, hours: 6, against: "device" });
  });

  it("trusts an IP city that keeps the device's clock", () => {
    expect(
      ipReadingVerdict({ location: toronto, deviceTz: "America/New_York", at: now }),
    ).toMatchObject({ suspected_vpn: false, hours: 0 });
  });

  it("falls back to the Slack zone when the device sent none", () => {
    expect(
      ipReadingVerdict({ location: toronto, slackTz: "Europe/Berlin", at: now }),
    ).toMatchObject({ suspected_vpn: true, against: "slack" });
    expect(
      ipReadingVerdict({ location: toronto, slackTz: "America/Toronto", at: now }),
    ).toMatchObject({ suspected_vpn: false, against: "slack" });
  });

  it("prefers the device zone over a disagreeing Slack zone", () => {
    expect(
      ipReadingVerdict({
        location: toronto,
        deviceTz: "America/Toronto",
        slackTz: "Europe/Berlin",
        at: now,
      }),
    ).toMatchObject({ suspected_vpn: false, against: "device" });
  });

  it("uses a bare device offset when no zone name came with it", () => {
    expect(
      ipReadingVerdict({ location: toronto, deviceOffsetMinutes: 120, at: now }),
    ).toMatchObject({ suspected_vpn: true, against: "device" });
    expect(
      ipReadingVerdict({ location: toronto, deviceOffsetMinutes: -240, at: now }),
    ).toMatchObject({ suspected_vpn: false });
  });

  it("falls back to the stored device zone before Slack when the request sent no clock", () => {
    expect(
      ipReadingVerdict({
        location: toronto,
        storedDeviceTz: "Europe/Zurich",
        slackTz: "America/Toronto",
        at: now,
      }),
    ).toMatchObject({ suspected_vpn: true, against: "device" });
    // The request's own clock still wins over the stored one.
    expect(
      ipReadingVerdict({
        location: toronto,
        deviceTz: "America/Toronto",
        storedDeviceTz: "Europe/Zurich",
        at: now,
      }),
    ).toMatchObject({ suspected_vpn: false, against: "device" });
  });

  it("finds no evidence with nothing to compare against", () => {
    expect(ipReadingVerdict({ location: toronto, at: now })).toEqual({ suspected_vpn: false });
    expect(ipReadingVerdict({ location: {}, deviceTz: "Europe/Zurich", at: now })).toEqual({
      suspected_vpn: false,
    });
  });

  describe("daylight saving", () => {
    // New York moves between UTC-5 and UTC-4; Phoenix stays at UTC-7. Two hours apart in winter
    // (not more than two: trusted), three in summer (flagged).
    const newYork = { city: "New York", country: "US", timezone: "America/New_York" };
    const verdict = (at: string) =>
      ipReadingVerdict({ location: newYork, deviceTz: "America/Phoenix", at: new Date(at) })
        .suspected_vpn;

    it("trusts the pair in winter and flags it in summer", () => {
      expect(verdict("2026-01-15T12:00:00.000Z")).toBe(false);
      expect(verdict("2026-07-15T12:00:00.000Z")).toBe(true);
    });

    it("changes its answer at the instant the clocks change, not a day either side", () => {
      // US clocks went forward at 02:00 EST on 2026-03-08, which is 07:00 UTC.
      expect(verdict("2026-03-08T06:59:00.000Z")).toBe(false);
      expect(verdict("2026-03-08T07:01:00.000Z")).toBe(true);
    });

    it("handles the southern hemisphere's opposite season", () => {
      // Sydney is UTC+11 in January and UTC+10 in July; Singapore stays at UTC+8.
      const sydney = { city: "Sydney", country: "AU", timezone: "Australia/Sydney" };
      const at = (iso: string) =>
        ipReadingVerdict({ location: sydney, deviceTz: "Asia/Singapore", at: new Date(iso) });
      expect(at("2026-01-15T00:00:00.000Z")).toMatchObject({ suspected_vpn: true, hours: 3 });
      expect(at("2026-07-15T00:00:00.000Z")).toMatchObject({ suspected_vpn: false, hours: 2 });
    });
  });
});

describe("usableDeviceZone", () => {
  it("accepts a regional IANA zone and refuses UTC, Etc and junk", () => {
    expect(usableDeviceZone("Europe/Zurich")).toBe("Europe/Zurich");
    expect(usableDeviceZone("UTC")).toBeUndefined();
    expect(usableDeviceZone("Etc/GMT+5")).toBeUndefined();
    expect(usableDeviceZone("Not/AZone")).toBeUndefined();
    expect(usableDeviceZone(undefined)).toBeUndefined();
  });
});

describe("ipReadingSetAside", () => {
  // A town the gazetteer does not list, with the zone the IP database gave it.
  const unlisted = {
    last_login_city: "Smallbrook Junction",
    last_login_region: "Ontario",
    last_login_country: "CA",
    last_login_timezone: "America/Toronto",
    last_ip_observed_at: ago(0),
  };

  it("checks an unlisted city by the zone the IP database gave it", () => {
    expect(
      ipReadingSetAside(
        member({ ...unlisted, last_device_tz: "Europe/Zurich", last_device_tz_at: ago(0) }),
        now,
      ),
    ).toBe(true);
    expect(
      ipReadingSetAside(
        member({ ...unlisted, last_device_tz: "America/Toronto", last_device_tz_at: ago(0) }),
        now,
      ),
    ).toBe(false);
  });

  it("falls back to the country's zone when the reading came without one", () => {
    const noZone = { ...unlisted, last_login_country: "DE", last_login_region: "Bavaria", last_login_timezone: "" };
    expect(
      ipReadingSetAside(
        member({ ...noZone, last_device_tz: "Europe/Berlin", last_device_tz_at: ago(0) }),
        now,
      ),
    ).toBe(false);
    expect(
      ipReadingSetAside(
        member({ ...noZone, last_device_tz: "America/Toronto", last_device_tz_at: ago(0) }),
        now,
      ),
    ).toBe(true);
  });

  it("does not set an unlisted city aside with no zone to check it against", () => {
    expect(ipReadingSetAside(member(unlisted), now)).toBe(false);
  });
});

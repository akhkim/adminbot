// The admin coverage panel's counts and stale list. Synthetic members only.
import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import { buildMapCoverage, lastSeenInAdminBot } from "./map-coverage.js";

const now = new Date("2026-07-15T12:00:00.000Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

function member(id: string, overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id,
    name: `Person ${id.toUpperCase()}`,
    privilege_level: "member",
    access: [],
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const roster = [
  // A fresh IP reading that agrees with the device clock.
  member("a", {
    last_login_city: "Toronto",
    last_login_region: "Ontario",
    last_login_country: "CA",
    last_ip_observed_at: ago(0),
    last_device_tz: "America/Toronto",
    last_device_tz_at: ago(0),
  }),
  // A recent check-in.
  member("b", { location_checkin_city: "Berlin", location_checkin_at: ago(10) }),
  // Only a stored city, last here three weeks ago.
  member("c", { current_city: "Zurich", last_seen_at: ago(21) }),
  // Only a Slack zone, never seen in AdminBot.
  member("d", { slack_tz: "Asia/Tokyo", slack_tz_observed_at: ago(1) }),
  // Nothing at all.
  member("e"),
  // A VPN reading set aside; placed by the stated city instead.
  member("f", {
    last_login_city: "Toronto",
    last_login_region: "Ontario",
    last_login_country: "CA",
    last_ip_observed_at: ago(0),
    last_ip_suspected_vpn: true,
    current_city: "Zurich",
  }),
  // Chose to be left off the map.
  member("g", { map_visibility: "hidden", current_city: "Zurich" }),
  // Departed: not counted at all.
  member("h", { status: "alumni", current_city: "Zurich" }),
];

describe("buildMapCoverage", () => {
  const coverage = buildMapCoverage(roster, { now });

  it("puts every active member in exactly one bucket", () => {
    expect(coverage.active).toBe(7);
    expect(coverage.counts).toEqual({
      ip: 1,
      checkin: 1,
      stored_city: 2,
      timezone: 1,
      country: 0,
      unplaced: 1,
      hidden: 1,
      suspected_vpn: 1,
    });
    const { suspected_vpn: _overlay, ...buckets } = coverage.counts;
    expect(Object.values(buckets).reduce((sum, n) => sum + n, 0)).toBe(coverage.active);
  });

  it("lists only members without a fresh IP or recent check-in, never-seen first", () => {
    expect(coverage.stale.map((entry) => entry.member_id)).toEqual(["d", "e", "c", "f"]);
    expect(coverage.stale.find((entry) => entry.member_id === "c")).toMatchObject({
      placed_by: "stored_city",
      place_label: "Zürich",
      last_seen_at: ago(21),
    });
    expect(coverage.stale.find((entry) => entry.member_id === "d")).toMatchObject({
      placed_by: "timezone",
      place_label: "Tokyo",
    });
    expect(coverage.stale.find((entry) => entry.member_id === "d")?.last_seen_at).toBeUndefined();
    expect(coverage.stale.find((entry) => entry.member_id === "e")).toMatchObject({
      placed_by: "unplaced",
    });
    expect(coverage.stale.find((entry) => entry.member_id === "f")).toMatchObject({
      placed_by: "stored_city",
      suspected_vpn: true,
      last_seen_at: ago(0),
    });
  });

  it("never lists a hidden or departed member", () => {
    const ids = coverage.stale.map((entry) => entry.member_id);
    expect(ids).not.toContain("g");
    expect(ids).not.toContain("h");
  });

  it("drops an IP reading out of the IP bucket once it is past the freshness window", () => {
    const stale = buildMapCoverage(
      [
        member("x", {
          last_login_city: "Toronto",
          last_login_region: "Ontario",
          last_login_country: "CA",
          last_ip_observed_at: ago(8),
        }),
      ],
      { now },
    );
    // The country from that reading still places them, as a country.
    expect(stale.counts).toMatchObject({ ip: 0, country: 1 });
    expect(stale.stale[0]).toMatchObject({
      member_id: "x",
      placed_by: "country",
      last_seen_at: ago(8),
    });
  });
});

describe("lastSeenInAdminBot", () => {
  it("takes the newest of the stamps a member's own use leaves", () => {
    expect(
      lastSeenInAdminBot(
        member("z", { last_login_at: ago(30), last_ip_observed_at: ago(3), last_seen_at: ago(1) }),
      ),
    ).toBe(ago(1));
    expect(lastSeenInAdminBot(member("z", { last_login_at: ago(30) }))).toBe(ago(30));
    expect(lastSeenInAdminBot(member("z"))).toBeUndefined();
  });
});

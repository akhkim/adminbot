// The daily IP reading on authenticated requests, and its VPN check. Synthetic members only.
import { describe, expect, it, vi } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import { AdminBotMemoryStore, AdminBotService } from "../../kernel/service.js";
import { AdminBotAuthService, type AdminBotMemberPrincipal } from "./auth.js";

type Located = { country?: string; continent?: string; city?: string; region?: string };

const TORONTO: Located = {
  country: "CA",
  continent: "North America",
  city: "Toronto",
  region: "Ontario",
};

function setup(options: {
  geolocateIp: (ip: string) => Promise<Located | undefined>;
  store?: AdminBotMemoryStore;
  member?: Partial<AdminBotLabMember>;
}) {
  let clock = new Date("2026-07-15T09:00:00.000Z");
  const store = options.store ?? new AdminBotMemoryStore();
  const service = new AdminBotService(store);
  const warn = vi.fn();
  const auth = new AdminBotAuthService({
    store,
    prepareMember: (input) => {
      const result = service.prepareLabMember(input);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.payload;
    },
    geolocateIp: options.geolocateIp,
    warn,
    now: () => clock,
  });
  if (!options.store) {
    store.saveLabMember({
      id: "m_daily",
      name: "Test Person",
      email: "test.person@example.test",
      privilege_level: "member",
      access: [],
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      ...options.member,
    });
  }
  const principal = (): AdminBotMemberPrincipal => ({
    kind: "member",
    member: store.getLabMember("m_daily")!,
    session: {} as AdminBotMemberPrincipal["session"],
  });
  return {
    store,
    auth,
    warn,
    principal,
    setNow: (iso: string) => {
      clock = new Date(iso);
    },
    ipRows: () =>
      store.listMemberLocations("m_daily", 50).filter((entry) => entry.source === "login_ip"),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe("daily IP observation", () => {
  it("looks a member up once per day across many requests, and again the next day", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const { auth, store, principal, setNow, ipRows } = setup({ geolocateIp });

    for (let i = 0; i < 25; i += 1) {
      auth.noteAccountUse(principal(), "198.51.100.7");
    }
    await vi.waitFor(() => expect(ipRows()).toHaveLength(1));
    expect(geolocateIp).toHaveBeenCalledTimes(1);
    expect(store.getLabMember("m_daily")).toMatchObject({
      last_login_city: "Toronto",
      last_ip_observed_at: "2026-07-15T09:00:00.000Z",
      last_ip_suspected_vpn: false,
    });

    setNow("2026-07-15T23:59:00.000Z");
    auth.noteAccountUse(principal(), "198.51.100.7");
    await settle();
    expect(geolocateIp).toHaveBeenCalledTimes(1);

    // A new UTC day: a new lookup, and a new row even though the place is the same, so the
    // history shows they were still there.
    setNow("2026-07-16T00:01:00.000Z");
    for (let i = 0; i < 5; i += 1) {
      auth.noteAccountUse(principal(), "198.51.100.7");
    }
    await vi.waitFor(() => expect(ipRows()).toHaveLength(2));
    expect(geolocateIp).toHaveBeenCalledTimes(2);
    expect(store.getLabMember("m_daily")?.last_ip_observed_at).toBe("2026-07-16T00:01:00.000Z");
  });

  it("looks again the same day when the address changes", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const { auth, principal } = setup({ geolocateIp });
    auth.noteAccountUse(principal(), "198.51.100.7");
    auth.noteAccountUse(principal(), "203.0.113.9");
    await settle();
    expect(geolocateIp).toHaveBeenCalledTimes(2);
  });

  it("does not look again after a restart when today's reading is already stored", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const first = setup({ geolocateIp });
    first.auth.noteAccountUse(first.principal(), "198.51.100.7");
    await vi.waitFor(() =>
      expect(first.store.getLabMember("m_daily")?.last_ip_observed_at).toBeDefined(),
    );

    const restarted = setup({ geolocateIp, store: first.store });
    restarted.auth.noteAccountUse(restarted.principal(), "198.51.100.7");
    await settle();
    expect(geolocateIp).toHaveBeenCalledTimes(1);
  });

  it("never lets a geolocator failure reach the request, and logs it", async () => {
    const geolocateIp = vi.fn(async () => {
      throw new Error("database unreadable");
    });
    const { auth, warn, principal, store } = setup({ geolocateIp });
    expect(() => auth.noteAccountUse(principal(), "198.51.100.7")).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0]?.[0]).toContain("database unreadable");
    // The address is never in the log line.
    expect(warn.mock.calls[0]?.[0]).not.toContain("198.51.100.7");
    expect(store.getLabMember("m_daily")?.last_ip_observed_at).toBeUndefined();
  });

  it("never lets a synchronous geolocator throw reach the request", async () => {
    const geolocateIp = vi.fn(() => {
      throw new Error("boom");
    }) as unknown as (ip: string) => Promise<Located | undefined>;
    const { auth, warn, principal } = setup({ geolocateIp });
    expect(() => auth.noteAccountUse(principal(), "198.51.100.7")).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });

  it.each(["stated", "hidden"] as const)("skips a member whose map visibility is %s", async (v) => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const { auth, principal, store } = setup({ geolocateIp, member: { map_visibility: v } });
    auth.noteAccountUse(principal(), "198.51.100.7");
    await settle();
    expect(geolocateIp).not.toHaveBeenCalled();
    expect(store.listMemberLocations("m_daily", 10)).toHaveLength(0);
  });

  it("skips an impersonated session", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const { auth, principal } = setup({ geolocateIp });
    auth.noteAccountUse({ ...principal(), impersonator: principal().member }, "198.51.100.7");
    await settle();
    expect(geolocateIp).not.toHaveBeenCalled();
  });
});

describe("VPN check on the daily reading", () => {
  it("logs a reading whose city disagrees with the device zone, but does not place the member", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const { auth, principal, store, ipRows } = setup({
      geolocateIp,
      member: { last_login_city: "Zurich", last_login_country: "CH" },
    });
    auth.noteAccountUse(principal(), "198.51.100.7", { tz: "Europe/Zurich", offsetMinutes: 120 });
    await vi.waitFor(() => expect(ipRows()).toHaveLength(1));
    expect(ipRows()[0]).toMatchObject({ suspected_vpn: true, place_label: "Canada" });
    expect(store.getLabMember("m_daily")).toMatchObject({
      // The last trusted city stays.
      last_login_city: "Zurich",
      last_login_country: "CH",
      last_ip_suspected_vpn: true,
      last_ip_observed_at: "2026-07-15T09:00:00.000Z",
      last_device_tz: "Europe/Zurich",
    });
    const deviceRows = store
      .listMemberLocations("m_daily", 10)
      .filter((entry) => entry.source === "device_timezone");
    expect(deviceRows).toHaveLength(1);
    expect(deviceRows[0]).toMatchObject({ raw: "Europe/Zurich" });
    expect(deviceRows[0]?.place_key).toBeUndefined();
  });

  it("uses a reading whose city agrees with the device zone", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const { auth, principal, store } = setup({ geolocateIp });
    auth.noteAccountUse(principal(), "198.51.100.7", { tz: "America/Toronto" });
    await vi.waitFor(() => expect(store.getLabMember("m_daily")?.last_login_city).toBe("Toronto"));
    expect(store.getLabMember("m_daily")?.last_ip_suspected_vpn).toBe(false);
  });

  it("checks against the Slack zone when the browser sent none", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const { auth, principal, store } = setup({
      geolocateIp,
      member: { slack_tz: "Europe/Berlin", slack_tz_observed_at: "2026-07-14T00:00:00.000Z" },
    });
    auth.noteAccountUse(principal(), "198.51.100.7");
    await vi.waitFor(() => expect(store.getLabMember("m_daily")?.last_ip_suspected_vpn).toBe(true));
    expect(store.getLabMember("m_daily")?.last_login_city).toBeUndefined();
  });

  it("ignores a UTC device zone, which privacy browsers report whatever the clock", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const { auth, principal, store } = setup({ geolocateIp });
    auth.noteAccountUse(principal(), "198.51.100.7", { tz: "UTC" });
    await vi.waitFor(() => expect(store.getLabMember("m_daily")?.last_login_city).toBe("Toronto"));
    expect(store.getLabMember("m_daily")?.last_device_tz).toBeUndefined();
  });
});

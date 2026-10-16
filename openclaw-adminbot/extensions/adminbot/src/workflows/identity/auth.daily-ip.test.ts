// The daily IP reading on authenticated requests, and its VPN check. Synthetic members only.
import { describe, expect, it, vi } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import { AdminBotMemoryStore, AdminBotService } from "../../kernel/service.js";
import { buildMemberMap, introIpPlace, liveIpPlace } from "../members/member-map.js";
import { AdminBotAuthService, type AdminBotMemberPrincipal } from "./auth.js";

type Located = { country?: string; continent?: string; city?: string; region?: string };

const ZURICH: Located = {
  country: "CH",
  continent: "Europe",
  city: "Zürich",
  region: "Zurich",
};

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
  afterLoginLocated?: (memberId: string) => void;
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
    ...(options.afterLoginLocated ? { afterLoginLocated: options.afterLoginLocated } : {}),
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

  it("after a restart looks once more but writes nothing when the city is unchanged", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const first = setup({ geolocateIp });
    first.auth.noteAccountUse(first.principal(), "198.51.100.7");
    await vi.waitFor(() => expect(first.ipRows()).toHaveLength(1));
    const before = first.store.getLabMember("m_daily");

    const restarted = setup({ geolocateIp, store: first.store });
    restarted.setNow("2026-07-15T15:00:00.000Z");
    restarted.auth.noteAccountUse(restarted.principal(), "198.51.100.7");
    await vi.waitFor(() => expect(geolocateIp).toHaveBeenCalledTimes(2));
    await settle();
    // Same city, same UTC day: no write, no new timeline row.
    expect(first.store.getLabMember("m_daily")).toEqual(before);
    expect(first.ipRows()).toHaveLength(1);
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

  it("stamps last_seen_at once a day for every member, stated and hidden included", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const { auth, principal, store, setNow } = setup({
      geolocateIp,
      member: { map_visibility: "hidden" },
    });
    auth.noteAccountUse(principal(), "198.51.100.7");
    await vi.waitFor(() =>
      expect(store.getLabMember("m_daily")?.last_seen_at).toBe("2026-07-15T09:00:00.000Z"),
    );
    setNow("2026-07-15T18:00:00.000Z");
    auth.noteAccountUse(principal(), "198.51.100.7");
    await settle();
    expect(store.getLabMember("m_daily")?.last_seen_at).toBe("2026-07-15T09:00:00.000Z");
    setNow("2026-07-16T08:00:00.000Z");
    auth.noteAccountUse(principal(), undefined);
    await vi.waitFor(() =>
      expect(store.getLabMember("m_daily")?.last_seen_at).toBe("2026-07-16T08:00:00.000Z"),
    );
    // Hidden: still no IP lookup.
    expect(geolocateIp).not.toHaveBeenCalled();
  });

  it("skips an impersonated session", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const { auth, principal, store } = setup({ geolocateIp });
    auth.noteAccountUse({ ...principal(), impersonator: principal().member }, "198.51.100.7");
    await settle();
    expect(geolocateIp).not.toHaveBeenCalled();
    expect(store.getLabMember("m_daily")?.last_seen_at).toBeUndefined();
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

  it("wakes the meetup hook for a trusted reading and never for a likely VPN exit", async () => {
    const trustedHook = vi.fn();
    const trusted = setup({
      geolocateIp: vi.fn(async () => TORONTO),
      afterLoginLocated: trustedHook,
    });
    trusted.auth.noteAccountUse(trusted.principal(), "198.51.100.7", { tz: "America/Toronto" });
    await vi.waitFor(() => expect(trustedHook).toHaveBeenCalledWith("m_daily"));

    const vpnHook = vi.fn();
    const vpn = setup({ geolocateIp: vi.fn(async () => TORONTO), afterLoginLocated: vpnHook });
    vpn.auth.noteAccountUse(vpn.principal(), "198.51.100.7", { tz: "Europe/Zurich" });
    await vi.waitFor(() => expect(vpn.ipRows()).toHaveLength(1));
    await settle();
    expect(vpn.store.getLabMember("m_daily")?.last_ip_suspected_vpn).toBe(true);
    expect(vpnHook).not.toHaveBeenCalled();
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

describe("the live IP, not the sign-in IP", () => {
  // What the sign-in stamp writes for somebody who signed in in Toronto this morning.
  const signedInToronto: Partial<AdminBotLabMember> = {
    last_login_at: "2026-07-15T06:00:00.000Z",
    last_login_city: "Toronto",
    last_login_region: "Ontario",
    last_login_country: "CA",
    last_ip_observed_at: "2026-07-15T06:00:00.000Z",
    last_ip_suspected_vpn: false,
  };
  const zurichIps = new Set(["192.0.2.10", "192.0.2.11", "192.0.2.12"]);
  const geolocateIp = (ip: string) => Promise.resolve(zurichIps.has(ip) ? ZURICH : TORONTO);

  it("places somebody who signed in in Toronto in Zürich on their first request from there", async () => {
    const hook = vi.fn();
    const { auth, principal, store, setNow } = setup({
      geolocateIp: vi.fn(geolocateIp),
      member: signedInToronto,
      afterLoginLocated: hook,
    });
    setNow("2026-07-15T14:00:00.000Z");
    auth.noteAccountUse(principal(), "192.0.2.10", { tz: "Europe/Zurich" });
    await vi.waitFor(() => expect(store.getLabMember("m_daily")?.last_login_city).toBe("Zürich"));
    const member = store.getLabMember("m_daily")!;
    expect(member).toMatchObject({
      last_login_country: "CH",
      last_ip_observed_at: "2026-07-15T14:00:00.000Z",
      last_ip_suspected_vpn: false,
      // The sign-in itself is untouched: it is a fact about signing in, not about where.
      last_login_at: "2026-07-15T06:00:00.000Z",
    });
    // The map and the intros read the same helper, and it says Zürich the same day.
    expect(liveIpPlace(member, new Date("2026-07-15T14:00:00.000Z"))).toMatchObject({
      city: "Zürich",
      country: "CH",
    });
    const map = buildMemberMap([member], new Map(), {
      loginCity: true,
      now: new Date("2026-07-15T14:00:00.000Z"),
    });
    expect(map.places[0]).toMatchObject({ label: "Zürich", members: [{ source: "login" }] });
    // The city changed, so the intro work wakes -- once. More requests from Zürich, even from
    // other addresses there, are the same city and wake nothing.
    expect(hook).toHaveBeenCalledTimes(1);
    setNow("2026-07-15T16:00:00.000Z");
    auth.noteAccountUse(principal(), "192.0.2.11", { tz: "Europe/Zurich" });
    auth.noteAccountUse(principal(), "192.0.2.12", { tz: "Europe/Zurich" });
    await settle();
    await settle();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(store.getLabMember("m_daily")?.last_ip_observed_at).toBe("2026-07-15T14:00:00.000Z");
  });

  it("never moves them or wakes intros for a VPN-flagged reading", async () => {
    const hook = vi.fn();
    const { auth, principal, store, setNow, ipRows } = setup({
      geolocateIp: vi.fn(geolocateIp),
      member: { ...signedInToronto, last_device_tz: "America/Toronto" },
      afterLoginLocated: hook,
    });
    const before = store.getLabMember("m_daily")!;
    setNow("2026-07-15T14:00:00.000Z");
    // A Zürich exit while the browser keeps Toronto's clock: a VPN.
    auth.noteAccountUse(principal(), "192.0.2.10", { tz: "America/Toronto" });
    await vi.waitFor(() => expect(ipRows().some((row) => row.suspected_vpn)).toBe(true));
    await settle();
    const after = store.getLabMember("m_daily")!;
    expect(after).toMatchObject({
      last_login_city: "Toronto",
      last_login_country: "CA",
      last_ip_observed_at: before.last_ip_observed_at,
      last_ip_suspected_vpn: false,
    });
    expect(liveIpPlace(after, new Date("2026-07-15T14:00:00.000Z"))?.city).toBe("Toronto");
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("privacy browsers that report UTC", () => {
  it("does not flag a Toronto reading from a browser that sends UTC with offset 0", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const { auth, principal, store, ipRows } = setup({ geolocateIp });
    auth.noteAccountUse(principal(), "198.51.100.7", { tz: "UTC", offsetMinutes: 0 });
    await vi.waitFor(() => expect(ipRows()).toHaveLength(1));
    expect(ipRows()[0]?.suspected_vpn).toBeFalsy();
    expect(store.getLabMember("m_daily")).toMatchObject({
      last_login_city: "Toronto",
      last_ip_suspected_vpn: false,
    });
  });

  it("checks a UTC browser against the stored device zone instead", async () => {
    const geolocateIp = vi.fn(async () => ZURICH);
    const { auth, principal, store, ipRows } = setup({
      geolocateIp,
      member: { last_device_tz: "America/Toronto", last_device_tz_at: "2026-07-15T06:00:00.000Z" },
    });
    auth.noteAccountUse(principal(), "192.0.2.10", { tz: "Etc/UTC", offsetMinutes: 0 });
    await vi.waitFor(() => expect(ipRows()).toHaveLength(1));
    expect(ipRows()[0]?.suspected_vpn).toBe(true);
    expect(store.getLabMember("m_daily")?.last_login_city).toBeUndefined();
  });
});

describe("the throttle on requests with and without device headers", () => {
  it("writes nothing after the first request, whichever headers and addresses follow", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const { auth, principal, store, ipRows } = setup({ geolocateIp });
    const patch = vi.spyOn(store, "patchLabMemberAuthFields");
    const append = vi.spyOn(store, "appendMemberLocation");
    const clock = { tz: "America/Toronto", offsetMinutes: -240 };

    auth.noteAccountUse(principal(), "198.51.100.7", clock);
    await vi.waitFor(() => expect(ipRows()).toHaveLength(1));
    await settle();
    const writes = { patch: patch.mock.calls.length, append: append.mock.calls.length };
    expect(writes.patch).toBeGreaterThan(0);

    // Most UI fetches send no device headers, and a dual-stack client alternates addresses.
    for (let i = 0; i < 12; i += 1) {
      const ip = i % 3 === 0 ? "2001:db8::7" : "198.51.100.7";
      auth.noteAccountUse(principal(), ip, i % 2 === 0 ? undefined : clock);
      await settle();
    }
    await settle();
    expect(patch.mock.calls.length).toBe(writes.patch);
    expect(append.mock.calls.length).toBe(writes.append);
    // One lookup per address per day.
    expect(geolocateIp).toHaveBeenCalledTimes(2);
  });

  it("restamps an unchanged device zone only after a day, and never touches updated_at", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const first = setup({ geolocateIp });
    const clock = { tz: "America/Toronto" };
    first.auth.noteAccountUse(first.principal(), "198.51.100.7", clock);
    await vi.waitFor(() =>
      expect(first.store.getLabMember("m_daily")?.last_device_tz).toBe("America/Toronto"),
    );
    await settle();
    const before = first.store.getLabMember("m_daily")!;

    // A restart forgets the throttle, so the request is checked again: same zone, same day, so
    // the device zone is not rewritten.
    const restarted = setup({ geolocateIp, store: first.store });
    const patch = vi.spyOn(first.store, "patchLabMemberAuthFields");
    restarted.setNow("2026-07-15T15:00:00.000Z");
    restarted.auth.noteAccountUse(restarted.principal(), "198.51.100.7", clock);
    await vi.waitFor(() => expect(geolocateIp).toHaveBeenCalledTimes(2));
    await settle();
    expect(patch).not.toHaveBeenCalled();
    expect(first.store.getLabMember("m_daily")).toEqual(before);

    // A day on, the zone is stamped again so it stays fresh, and that patch carries no updated_at
    // (the day's IP reading is a separate write).
    restarted.setNow("2026-07-16T10:00:00.000Z");
    restarted.auth.noteAccountUse(restarted.principal(), "198.51.100.7", clock);
    await vi.waitFor(() =>
      expect(first.store.getLabMember("m_daily")?.last_device_tz_at).toBe(
        "2026-07-16T10:00:00.000Z",
      ),
    );
    const zonePatches = patch.mock.calls
      .map(([, fields]) => fields)
      .filter((fields) => "last_device_tz" in fields);
    expect(zonePatches).toEqual([
      { last_device_tz: "America/Toronto", last_device_tz_at: "2026-07-16T10:00:00.000Z" },
    ]);
  });

  it("never moves updated_at when stamping last_seen_at from a stale session copy", async () => {
    const geolocateIp = vi.fn(async () => TORONTO);
    const { auth, principal, store } = setup({
      geolocateIp,
      member: { updated_at: "2026-07-01T00:00:00.000Z", map_visibility: "hidden" },
    });
    // The session loaded the member before a later edit.
    const stale = principal();
    stale.member = { ...stale.member, updated_at: "2026-06-01T00:00:00.000Z" };
    auth.noteAccountUse(stale, "198.51.100.7");
    await vi.waitFor(() =>
      expect(store.getLabMember("m_daily")?.last_seen_at).toBe("2026-07-15T09:00:00.000Z"),
    );
    expect(store.getLabMember("m_daily")?.updated_at).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("requests that send no device headers", () => {
  it("checks a header-less reading against the stored device zone: no move, no intros", async () => {
    const hook = vi.fn();
    const { auth, principal, store, setNow, ipRows } = setup({
      geolocateIp: vi.fn(async () => ZURICH),
      member: {
        last_login_city: "Toronto",
        last_login_region: "Ontario",
        last_login_country: "CA",
        last_ip_observed_at: "2026-07-15T06:00:00.000Z",
        last_ip_suspected_vpn: false,
        last_device_tz: "America/Toronto",
        last_device_tz_at: "2026-07-15T06:00:00.000Z",
      },
      afterLoginLocated: hook,
    });
    setNow("2026-07-15T14:00:00.000Z");
    // A Zürich VPN exit, and this fetch sent no clock.
    auth.noteAccountUse(principal(), "192.0.2.10");
    await vi.waitFor(() => expect(ipRows().some((row) => row.suspected_vpn)).toBe(true));
    await settle();
    expect(store.getLabMember("m_daily")).toMatchObject({
      last_login_city: "Toronto",
      last_ip_observed_at: "2026-07-15T06:00:00.000Z",
    });
    expect(hook).not.toHaveBeenCalled();
  });

  it("starts no intros from a reading with no zone at all to check it against", async () => {
    const hook = vi.fn();
    const { auth, principal, store } = setup({
      geolocateIp: vi.fn(async () => TORONTO),
      afterLoginLocated: hook,
    });
    auth.noteAccountUse(principal(), "198.51.100.7");
    await vi.waitFor(() => expect(store.getLabMember("m_daily")?.last_login_city).toBe("Toronto"));
    await settle();
    expect(hook).not.toHaveBeenCalled();
    // The map may show it; the intros never read it.
    const member = store.getLabMember("m_daily")!;
    const at = new Date("2026-07-15T09:00:00.000Z");
    expect(liveIpPlace(member, at)?.city).toBe("Toronto");
    expect(introIpPlace(member, at)).toBeUndefined();
  });
});

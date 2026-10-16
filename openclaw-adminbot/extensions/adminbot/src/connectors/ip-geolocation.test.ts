import { describe, expect, it, vi } from "vitest";
import {
  createIpinfoGeolocator,
  createMmdbGeolocator,
  mmdbRecordToGeolocation,
  selectIpGeolocator,
} from "./ip-geolocation.js";
import { buildCityMmdb } from "./mmdb-fixture.test-helpers.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createIpinfoGeolocator", () => {
  it("asks the core endpoint first, and keeps the city and zone it answers with", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        country: "Switzerland",
        continent: "Europe",
        city: "Zurich",
        timezone: "Europe/Zurich",
      }),
    );
    const geolocate = createIpinfoGeolocator("test-token", fetchImpl as unknown as typeof fetch);

    const result = await geolocate("8.8.8.8");

    expect(result).toEqual({
      country: "Switzerland",
      continent: "Europe",
      city: "Zurich",
      timezone: "Europe/Zurich",
    });
    // One call: a usable core answer means the Lite fallback is never spent.
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://ipinfo.io/8.8.8.8/json?token=test-token",
    );
  });

  // Losing the city is much better than losing the country stamp this has always written.
  it("falls back to Lite when the core endpoint refuses", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 403))
      .mockResolvedValueOnce(jsonResponse({ country: "Switzerland", continent: "Europe" }));
    const geolocate = createIpinfoGeolocator("test-token", fetchImpl as unknown as typeof fetch);

    await expect(geolocate("8.8.8.8")).resolves.toEqual({
      country: "Switzerland",
      continent: "Europe",
    });
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
      "https://api.ipinfo.io/lite/8.8.8.8?token=test-token",
    );
  });

  // A rate-limited core response comes back as a 200 carrying an error, not as a 429.
  it("treats a 200 carrying an error as a refusal and falls back", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { title: "Rate limit exceeded" } }))
      .mockResolvedValueOnce(jsonResponse({ country_code: "CH" }));
    const geolocate = createIpinfoGeolocator("test-token", fetchImpl as unknown as typeof fetch);

    await expect(geolocate("8.8.8.8")).resolves.toEqual({ country: "CH" });
  });

  // Intl rejects a bare offset, so a clock derived from one would read "unknown" everywhere.
  it("keeps only an IANA zone name, never an offset", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ country: "Canada", city: "Toronto", timezone: "UTC-5" }),
    );
    const geolocate = createIpinfoGeolocator("test-token", fetchImpl as unknown as typeof fetch);

    await expect(geolocate("8.8.8.8")).resolves.toEqual({ country: "Canada", city: "Toronto" });
  });

  // The region is what separates London, Ontario from London, England on the map.
  it("keeps the region the core endpoint reports alongside a city, and never without one", async () => {
    const withCity = vi.fn(async () =>
      jsonResponse({
        country: "CA",
        city: "London",
        region: "Ontario",
        timezone: "America/Toronto",
      }),
    );
    await expect(
      createIpinfoGeolocator("test-token", withCity as unknown as typeof fetch)("8.8.8.8"),
    ).resolves.toEqual({
      country: "CA",
      city: "London",
      region: "Ontario",
      timezone: "America/Toronto",
    });
    const regionOnly = vi.fn(async () => jsonResponse({ country: "CA", region: "Ontario" }));
    await expect(
      createIpinfoGeolocator("test-token", regionOnly as unknown as typeof fetch)("8.8.8.8"),
    ).resolves.toEqual({ country: "CA" });
  });

  it("falls back to the country/continent codes when the full names are absent", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ country_code: "CH", continent_code: "EU" }));
    const geolocate = createIpinfoGeolocator("test-token", fetchImpl as unknown as typeof fetch);

    await expect(geolocate("8.8.8.8")).resolves.toEqual({ country: "CH", continent: "EU" });
  });

  it("never calls out for private/loopback/local addresses", async () => {
    const fetchImpl = vi.fn();
    const geolocate = createIpinfoGeolocator("test-token", fetchImpl as unknown as typeof fetch);

    // One address per branch of isPubliclyRoutable, so a break in any single branch fails this
    // test rather than passing on the strength of the others.
    const addresses = [
      "127.0.0.1", // IPv4 loopback
      "10.0.0.5", // IPv4 RFC 1918, 10.0.0.0/8
      "192.168.1.20", // IPv4 RFC 1918, 192.168.0.0/16
      "172.20.0.4", // IPv4 RFC 1918, 172.16.0.0/12 (mid-range)
      "::1", // IPv6 loopback
      "fe80::1", // IPv6 link-local
      "fc00::1", // IPv6 unique local, fc00::/7 (the "fc" half)
      "fd12::1", // IPv6 unique local, fc00::/7 (the "fd" half)
    ];
    for (const ip of addresses) {
      await expect(geolocate(ip)).resolves.toBeUndefined();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats the 172.16.0.0/12 boundary correctly", async () => {
    const inside = ["172.16.0.1", "172.31.255.255"];
    const outside = ["172.15.255.255", "172.32.0.1"];

    const skipped = vi.fn();
    const geolocateSkipped = createIpinfoGeolocator(
      "test-token",
      skipped as unknown as typeof fetch,
    );
    for (const ip of inside) {
      await expect(geolocateSkipped(ip)).resolves.toBeUndefined();
    }
    expect(skipped).not.toHaveBeenCalled();

    // Just outside the RFC 1918 block on either side is a real public address, and must not get
    // caught by an off-by-one in the boundary check.
    const called = vi.fn(async () => jsonResponse({}, 500));
    const geolocateCalled = createIpinfoGeolocator("test-token", called as unknown as typeof fetch);
    for (const ip of outside) {
      await geolocateCalled(ip);
    }
    // Two calls per address: the core endpoint, then the Lite fallback once it 500s.
    expect(called).toHaveBeenCalledTimes(outside.length * 2);
  });

  it("resolves to undefined rather than throwing on a network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const geolocate = createIpinfoGeolocator("test-token", fetchImpl as unknown as typeof fetch);

    await expect(geolocate("8.8.8.8")).resolves.toBeUndefined();
  });

  it("resolves to undefined on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "bad token" }, 403));
    const geolocate = createIpinfoGeolocator("test-token", fetchImpl as unknown as typeof fetch);

    await expect(geolocate("8.8.8.8")).resolves.toBeUndefined();
  });
});

// Synthetic networks from the documentation ranges (RFC 5737) plus one ordinary-looking block;
// the places are invented for the test and no real database is read.
const FIXTURE = buildCityMmdb({
  "203.0.113.0/24": {
    city: "Toronto",
    region: "Ontario",
    country: "CA",
    continent: "NA",
    timeZone: "America/Toronto",
    latitude: 43.7,
    longitude: -79.4,
  },
  "198.51.100.0/24": { city: "London", region: "England", country: "GB", continent: "EU" },
  "192.0.2.0/24": { country: "FR", continent: "EU" },
});

function fixtureFs(files: Record<string, { bytes: Buffer; mtimeMs: number }>) {
  return {
    stat: vi.fn(async (path: string) => {
      const file = files[path];
      if (!file) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return { mtimeMs: file.mtimeMs, size: file.bytes.length };
    }),
    readFile: vi.fn(async (path: string) => files[path]!.bytes),
    warn: vi.fn(),
  };
}

describe("createMmdbGeolocator", () => {
  it("answers with city, region, ISO country, continent and zone, and never coordinates", async () => {
    const fs = fixtureFs({ "/geo/city.mmdb": { bytes: FIXTURE, mtimeMs: 1 } });
    const geolocate = createMmdbGeolocator("/geo/city.mmdb", fs);

    const toronto = await geolocate("203.0.113.9");
    expect(toronto).toEqual({
      country: "CA",
      continent: "NA",
      city: "Toronto",
      region: "Ontario",
      timezone: "America/Toronto",
    });
    // The database holds a latitude and longitude; nothing downstream may receive one.
    expect(JSON.stringify(toronto)).not.toMatch(/43\.7|79\.4|latitude|longitude/);
    // DB-IP Lite carries no zone; the stamp simply omits it.
    await expect(geolocate("198.51.100.20")).resolves.toEqual({
      country: "GB",
      continent: "EU",
      city: "London",
      region: "England",
    });
    // A network located only to a country comes back as a country, with no invented city.
    await expect(geolocate("192.0.2.1")).resolves.toEqual({ country: "FR", continent: "EU" });
    // Not in the database at all.
    await expect(geolocate("8.8.8.8")).resolves.toBeUndefined();
    // Loaded once, not per lookup.
    expect(fs.readFile).toHaveBeenCalledTimes(1);
  });

  it("skips private, loopback, link-local and CGNAT addresses without opening the file", async () => {
    const fs = fixtureFs({ "/geo/city.mmdb": { bytes: FIXTURE, mtimeMs: 1 } });
    const geolocate = createMmdbGeolocator("/geo/city.mmdb", fs);
    for (const ip of [
      "10.1.2.3",
      "127.0.0.1",
      "100.64.0.1", // CGNAT, 100.64.0.0/10
      "100.127.255.254",
      "169.254.1.1",
      "::ffff:192.168.1.1",
      "::1",
      "",
    ]) {
      await expect(geolocate(ip)).resolves.toBeUndefined();
    }
    expect(fs.stat).not.toHaveBeenCalled();
  });

  it("reloads when the file's mtime changes, and keeps the last good database if it breaks", async () => {
    const files = { "/geo/city.mmdb": { bytes: FIXTURE, mtimeMs: 1 } };
    const fs = fixtureFs(files);
    const geolocate = createMmdbGeolocator("/geo/city.mmdb", fs);
    await expect(geolocate("192.0.2.1")).resolves.toEqual({ country: "FR", continent: "EU" });

    // The monthly refresh renames a new database into place.
    files["/geo/city.mmdb"] = {
      bytes: buildCityMmdb({ "192.0.2.0/24": { city: "Paris", country: "FR", continent: "EU" } }),
      mtimeMs: 2,
    };
    await expect(geolocate("192.0.2.1")).resolves.toEqual({
      country: "FR",
      continent: "EU",
      city: "Paris",
    });
    expect(fs.readFile).toHaveBeenCalledTimes(2);

    // A corrupt replacement must not lose the database that was working.
    files["/geo/city.mmdb"] = { bytes: Buffer.from("not a database"), mtimeMs: 3 };
    await expect(geolocate("192.0.2.1")).resolves.toMatchObject({ city: "Paris" });
    await expect(geolocate("192.0.2.1")).resolves.toMatchObject({ city: "Paris" });
    expect(fs.warn).toHaveBeenCalledTimes(1);
  });

  it("returns nothing, and warns once, when the file is missing", async () => {
    const fs = fixtureFs({});
    const geolocate = createMmdbGeolocator("/geo/missing.mmdb", fs);
    await expect(geolocate("203.0.113.9")).resolves.toBeUndefined();
    await expect(geolocate("203.0.113.9")).resolves.toBeUndefined();
    expect(fs.warn).toHaveBeenCalledTimes(1);
  });
});

describe("mmdbRecordToGeolocation", () => {
  it("drops a region that arrives without a city, and an offset posing as a zone", () => {
    expect(
      mmdbRecordToGeolocation({
        country: { iso_code: "CA" },
        subdivisions: [{ names: { en: "Ontario" } }],
        location: { time_zone: "UTC-5" },
      } as never),
    ).toEqual({ country: "CA" });
    expect(mmdbRecordToGeolocation(null)).toBeUndefined();
    expect(mmdbRecordToGeolocation({} as never)).toBeUndefined();
  });

  it("falls back to the registered country when the located one is absent", () => {
    expect(mmdbRecordToGeolocation({ registered_country: { iso_code: "CH" } } as never)).toEqual({
      country: "CH",
    });
  });
});

describe("selectIpGeolocator", () => {
  it("prefers the local database when a path is configured, even with an IPinfo token", async () => {
    const fetchImpl = vi.fn();
    const fs = fixtureFs({ "/geo/city.mmdb": { bytes: FIXTURE, mtimeMs: 1 } });
    const selection = selectIpGeolocator(
      { mmdbPath: " /geo/city.mmdb ", ipinfoToken: "test-token" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, mmdb: fs },
    );
    expect(selection.provider).toBe("mmdb");
    await expect(selection.geolocate?.("203.0.113.9")).resolves.toMatchObject({ city: "Toronto" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses IPinfo when only a token is configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ country: "Switzerland" }));
    const selection = selectIpGeolocator(
      { ipinfoToken: "test-token" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(selection.provider).toBe("ipinfo");
    await expect(selection.geolocate?.("8.8.8.8")).resolves.toEqual({ country: "Switzerland" });
  });

  it("is off, with no geolocator, when neither is configured", () => {
    const selection = selectIpGeolocator({ mmdbPath: "  ", ipinfoToken: "" });
    expect(selection.provider).toBe("off");
    expect(selection.geolocate).toBeUndefined();
    expect(selection.summary).toContain("ADMINBOT_GEOIP_MMDB_PATH");
    expect(selection.attribution).toBeUndefined();
  });

  it("names the credit each provider's licence asks for", () => {
    expect(selectIpGeolocator({ mmdbPath: "/geo/dbip-city-lite.mmdb" }).attribution).toEqual({
      text: "IP geolocation by DB-IP",
      url: "https://db-ip.com",
    });
    expect(selectIpGeolocator({ mmdbPath: "/geo/GeoLite2-City.mmdb" }).attribution?.text).toContain(
      "MaxMind GeoLite2",
    );
    expect(selectIpGeolocator({ ipinfoToken: "test-token" }).attribution?.text).toContain("IPinfo");
  });
});

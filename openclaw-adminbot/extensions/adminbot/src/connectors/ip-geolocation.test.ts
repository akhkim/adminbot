import { describe, expect, it, vi } from "vitest";
import { createIpinfoGeolocator } from "./ip-geolocation.js";

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

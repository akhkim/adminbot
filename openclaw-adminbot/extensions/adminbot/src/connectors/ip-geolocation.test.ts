import { describe, expect, it, vi } from "vitest";
import { createIpinfoLiteGeolocator } from "./ip-geolocation.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createIpinfoLiteGeolocator", () => {
  it("looks up a public IP against the IPinfo Lite endpoint with the token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        country: "Switzerland",
        country_code: "CH",
        continent: "Europe",
        continent_code: "EU",
      }),
    );
    const geolocate = createIpinfoLiteGeolocator(
      "test-token",
      fetchImpl as unknown as typeof fetch,
    );

    const result = await geolocate("8.8.8.8");

    expect(result).toEqual({ country: "Switzerland", continent: "Europe" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.ipinfo.io/lite/8.8.8.8?token=test-token");
  });

  it("falls back to the country/continent codes when the full names are absent", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ country_code: "CH", continent_code: "EU" }));
    const geolocate = createIpinfoLiteGeolocator(
      "test-token",
      fetchImpl as unknown as typeof fetch,
    );

    await expect(geolocate("8.8.8.8")).resolves.toEqual({ country: "CH", continent: "EU" });
  });

  it("never calls out for private/loopback/local addresses", async () => {
    const fetchImpl = vi.fn();
    const geolocate = createIpinfoLiteGeolocator(
      "test-token",
      fetchImpl as unknown as typeof fetch,
    );

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
    const geolocateSkipped = createIpinfoLiteGeolocator(
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
    const geolocateCalled = createIpinfoLiteGeolocator(
      "test-token",
      called as unknown as typeof fetch,
    );
    for (const ip of outside) {
      await geolocateCalled(ip);
    }
    expect(called).toHaveBeenCalledTimes(outside.length);
  });

  it("resolves to undefined rather than throwing on a network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const geolocate = createIpinfoLiteGeolocator(
      "test-token",
      fetchImpl as unknown as typeof fetch,
    );

    await expect(geolocate("8.8.8.8")).resolves.toBeUndefined();
  });

  it("resolves to undefined on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "bad token" }, 403));
    const geolocate = createIpinfoLiteGeolocator(
      "test-token",
      fetchImpl as unknown as typeof fetch,
    );

    await expect(geolocate("8.8.8.8")).resolves.toBeUndefined();
  });
});

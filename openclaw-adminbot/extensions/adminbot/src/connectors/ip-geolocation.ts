// Turns a login's source IP into a coarse, country-level location via IPinfo's free "Lite" API
// (https://api.ipinfo.io/lite/<ip>) — country + continent only, no city/coordinates, which is
// the right amount of precision for "where did this account last sign in from" and avoids the
// privacy weight of anything finer-grained. Requires a free IPinfo account token even on the
// unlimited Lite tier; see auth.ts's use of this for what happens with no token configured.

export type IpGeolocation = { country?: string; continent?: string };
export type IpGeolocator = (ip: string) => Promise<IpGeolocation | undefined>;

const REQUEST_TIMEOUT_MS = 4_000;

// RFC 1918 / loopback / link-local ranges: always present in local dev and behind most
// reverse proxies that don't forward the real client IP, and never resolve to anything — skip
// the network call rather than spend it on an answer we already know is "nowhere".
function isPubliclyRoutable(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [, a, b] = v4.map(Number) as unknown as [number, number, number];
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return false;
    }
    return true;
  }
  const lower = ip.toLowerCase();
  if (
    lower === "::1" ||
    lower.startsWith("fe80:") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd")
  ) {
    return false;
  }
  return true;
}

export function createIpinfoLiteGeolocator(
  token: string,
  fetchImpl: typeof fetch = fetch,
): IpGeolocator {
  const trimmedToken = token.trim();
  return async (ip: string) => {
    const trimmedIp = ip.trim();
    if (!trimmedIp || !isPubliclyRoutable(trimmedIp)) {
      return undefined;
    }
    try {
      const response = await fetchImpl(
        `https://api.ipinfo.io/lite/${encodeURIComponent(trimmedIp)}?token=${encodeURIComponent(trimmedToken)}`,
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
      if (!response.ok) {
        return undefined;
      }
      const body = (await response.json()) as {
        country?: string;
        country_code?: string;
        continent?: string;
        continent_code?: string;
      };
      const country = body.country || body.country_code;
      const continent = body.continent || body.continent_code;
      if (!country && !continent) {
        return undefined;
      }
      return { ...(country ? { country } : {}), ...(continent ? { continent } : {}) };
    } catch {
      // Network failure, timeout, or malformed response: the caller treats this the same as "no
      // token configured" — login must never fail or slow down because a third party is unreachable.
      return undefined;
    }
  };
}

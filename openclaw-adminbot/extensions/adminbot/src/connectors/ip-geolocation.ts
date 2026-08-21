// Turns a login's source IP into a location via IPinfo, for the "where did this account last sign
// in from" stamp on a member record.
//
// Two endpoints, tried in that order. The core API (https://ipinfo.io/<ip>/json) answers with a
// city and an IANA timezone; the free "Lite" API (https://api.ipinfo.io/lite/<ip>) answers with
// country and continent only. The city is what makes this useful for scheduling -- a country is
// not a timezone, and half the countries the lab spans have several -- so it is asked for first
// and the coarser answer is the fallback rather than the target.
//
// Everything here is *inferred*. It is written only to the `last_login_*` fields and never to
// `location`, `current_city` or `timezone`, which are the member's own statements; see the
// location-source contract in contracts/actions.ts. Requires a free IPinfo account token; see
// auth.ts's use of this for what happens with no token configured.

export type IpGeolocation = {
  country?: string;
  continent?: string;
  /** City and IANA zone, when the account's plan returns them. Absent on the Lite tier. */
  city?: string;
  timezone?: string;
};
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

export function createIpinfoGeolocator(
  token: string,
  fetchImpl: typeof fetch = fetch,
): IpGeolocator {
  const trimmedToken = token.trim();
  return async (ip: string) => {
    const trimmedIp = ip.trim();
    if (!trimmedIp || !isPubliclyRoutable(trimmedIp)) {
      return undefined;
    }
    // The core endpoint first, because it is the only one that answers with a city and an IANA
    // zone, which is what scheduling needs. Falling back to Lite rather than failing: the core
    // API is rate-limited and plan-gated where Lite is not, and losing the city is much better
    // than losing the country stamp this has always written.
    return (
      (await readIpinfo(core(trimmedIp, trimmedToken), fetchImpl)) ??
      (await readIpinfo(lite(trimmedIp, trimmedToken), fetchImpl))
    );
  };
}

function core(ip: string, token: string): string {
  return `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`;
}

function lite(ip: string, token: string): string {
  return `https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${encodeURIComponent(token)}`;
}

/**
 * Reads one IPinfo response into the shape above, or undefined for anything unusable.
 *
 * Both endpoints are parsed by the same function: Lite simply omits `city` and `timezone`, so a
 * Lite answer comes back as the country-only record this connector has always produced.
 */
async function readIpinfo(
  url: string,
  fetchImpl: typeof fetch,
): Promise<IpGeolocation | undefined> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as {
      country?: string;
      country_code?: string;
      continent?: string;
      continent_code?: string;
      city?: string;
      timezone?: string;
      // The core endpoint reports a rate-limit refusal as a 200 with this set, rather than a 429.
      bogon?: boolean;
      error?: unknown;
    };
    if (body.error || body.bogon) {
      return undefined;
    }
    const country = body.country || body.country_code;
    const continent = body.continent || body.continent_code;
    const city = body.city?.trim();
    // Only an IANA name is kept. A provider that answers with an offset ("UTC-5") would otherwise
    // be handed to Intl, which rejects it, and every clock derived from it would read "unknown".
    const timezone = body.timezone?.trim();
    const zone = timezone && timezone.includes("/") ? timezone : undefined;
    if (!country && !continent && !city) {
      return undefined;
    }
    return {
      ...(country ? { country } : {}),
      ...(continent ? { continent } : {}),
      ...(city ? { city } : {}),
      ...(zone ? { timezone: zone } : {}),
    };
  } catch {
    // Network failure, timeout, or malformed response: the caller treats this the same as "no
    // token configured" — login must never fail or slow down because a third party is unreachable.
    return undefined;
  }
}

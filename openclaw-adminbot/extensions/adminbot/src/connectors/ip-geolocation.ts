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
//
// A second provider reads a local MaxMind-format (.mmdb) city database instead of calling out:
// DB-IP "IP to City Lite" (CC BY 4.0, no account) or MaxMind GeoLite2-City (free account). It is
// the preferred one -- city-level for free, and a sign-in never leaves the host to be located.
// selectIpGeolocator below picks between the two from the environment.

import { readFile, stat } from "node:fs/promises";
import { Reader, type CityResponse } from "mmdb-lib";

export type IpGeolocation = {
  country?: string;
  continent?: string;
  /** City and IANA zone, when the account's plan returns them. Absent on the Lite tier. */
  city?: string;
  /**
   * The first-level subdivision the city is in ("Ontario", "England"). Only ever sent with a city,
   * to tell apart cities that share a name; it is never a location on its own.
   */
  region?: string;
  timezone?: string;
};
export type IpGeolocator = (ip: string) => Promise<IpGeolocation | undefined>;

const REQUEST_TIMEOUT_MS = 4_000;

// RFC 1918 / loopback / link-local / CGNAT ranges: always present in local dev and behind most
// reverse proxies that don't forward the real client IP, and never resolve to anything — skip
// the lookup rather than spend it on an answer we already know is "nowhere".
export function isPubliclyRoutable(ip: string): boolean {
  const lowered = ip.toLowerCase();
  // An IPv4 address carried in IPv6 form (what a dual-stack socket reports) is judged as IPv4.
  const mapped = lowered.startsWith("::ffff:") ? lowered.slice("::ffff:".length) : lowered;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped);
  if (v4) {
    const [, a, b] = v4.map(Number) as unknown as [number, number, number];
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) {
      return false;
    }
    return true;
  }
  if (
    mapped === "::" ||
    mapped === "::1" ||
    mapped.startsWith("fe80:") ||
    mapped.startsWith("fc") ||
    mapped.startsWith("fd")
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
      region?: string;
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
    const region = city ? body.region?.trim() : undefined;
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
      ...(region ? { region } : {}),
      ...(zone ? { timezone: zone } : {}),
    };
  } catch {
    // Network failure, timeout, or malformed response: the caller treats this the same as "no
    // token configured" — login must never fail or slow down because a third party is unreachable.
    return undefined;
  }
}

/**
 * File-system access for the .mmdb provider, injectable so tests never need a real database.
 */
export type MmdbGeolocatorDeps = {
  stat?: (path: string) => Promise<{ mtimeMs: number; size: number }>;
  readFile?: (path: string) => Promise<Buffer>;
  warn?: (message: string) => void;
};

/**
 * Locates an IP from a local MaxMind-format city database (DB-IP City Lite or GeoLite2-City).
 *
 * Loaded once and reloaded when the file's mtime or size changes, so the monthly refresh script
 * (scripts/adminbot-geoip-refresh.sh) takes effect without a restart. The refresh renames the new
 * file into place, so a lookup reads either the old database or the new one, never half of each.
 *
 * Reads the record's names and codes only. The database also carries a latitude and longitude per
 * network; they are deliberately never read, because nothing downstream may store one -- the map
 * places people at city centroids it already knows, not at an IP's coordinates.
 */
export function createMmdbGeolocator(path: string, deps: MmdbGeolocatorDeps = {}): IpGeolocator {
  const statFile = deps.stat ?? stat;
  const read = deps.readFile ?? ((file: string) => readFile(file));
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  let loaded: { mtimeMs: number; size: number; reader: Reader<CityResponse> } | undefined;
  let warnedFor: string | undefined;
  const warnOnce = (message: string) => {
    if (warnedFor !== message) {
      warnedFor = message;
      warn(message);
    }
  };

  async function currentReader(): Promise<Reader<CityResponse> | undefined> {
    try {
      const info = await statFile(path);
      if (!loaded || loaded.mtimeMs !== info.mtimeMs || loaded.size !== info.size) {
        loaded = { mtimeMs: info.mtimeMs, size: info.size, reader: new Reader(await read(path)) };
        warnedFor = undefined;
      }
      return loaded.reader;
    } catch (error) {
      // A missing or corrupt file must not fail a sign-in. Keep serving the last good database if
      // there was one -- a botched refresh should cost nothing -- and say so once, not per login.
      warnOnce(
        `AdminBot IP geolocation: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return loaded?.reader;
    }
  }

  return async (ip: string) => {
    const trimmedIp = ip.trim();
    if (!trimmedIp || !isPubliclyRoutable(trimmedIp)) {
      return undefined;
    }
    const reader = await currentReader();
    if (!reader) {
      return undefined;
    }
    try {
      return mmdbRecordToGeolocation(reader.get(trimmedIp));
    } catch {
      // mmdb-lib throws on a string that is not an IP at all; that is "nowhere", not an outage.
      return undefined;
    }
  };
}

/**
 * Maps one GeoIP2-shaped city record (both DB-IP and MaxMind use this layout) onto the stamp.
 *
 * The country is the ISO alpha-2 code, the same form the IPinfo core endpoint answers with, so the
 * rest of the system sees one shape whichever provider is configured. Exported for tests.
 */
export function mmdbRecordToGeolocation(
  record: CityResponse | null | undefined,
): IpGeolocation | undefined {
  if (!record) {
    return undefined;
  }
  const english = (names: { en?: string } | undefined) => names?.en?.trim() || undefined;
  const country = record.country?.iso_code?.trim() || record.registered_country?.iso_code?.trim();
  const continent = record.continent?.code?.trim();
  const city = english(record.city?.names);
  const region = city ? english(record.subdivisions?.[0]?.names) : undefined;
  const zone = record.location?.time_zone?.trim();
  const timezone = zone && zone.includes("/") ? zone : undefined;
  if (!country && !continent && !city) {
    return undefined;
  }
  return {
    ...(country ? { country } : {}),
    ...(continent ? { continent } : {}),
    ...(city ? { city } : {}),
    ...(region ? { region } : {}),
    ...(timezone ? { timezone } : {}),
  };
}

export type IpGeolocationProvider = "mmdb" | "ipinfo" | "off";

/** The credit a provider's licence asks for wherever its data is shown. */
export type IpGeolocationAttribution = { text: string; url: string };

export type IpGeolocationSelection = {
  provider: IpGeolocationProvider;
  geolocate?: IpGeolocator;
  /**
   * Shown with the member map. DB-IP Lite is CC BY 4.0 and GeoLite2 is under MaxMind's EULA, and
   * both require the credit next to anything drawn from them; IPinfo's free tier asks for it too.
   */
  attribution?: IpGeolocationAttribution;
  /** One line for the startup log: which provider, and what it can answer. */
  summary: string;
};

/**
 * Picks the provider from configuration: a local .mmdb database when ADMINBOT_GEOIP_MMDB_PATH is
 * set, otherwise IPinfo when IPINFO_TOKEN is set, otherwise none at all.
 *
 * The database wins over IPinfo when both are configured: it answers with a city for free and
 * without sending a member's address to a third party, where an IPinfo Lite token answers with a
 * country only.
 */
/**
 * Which credit a local database needs, by its file name: the refresh script writes DB-IP's as
 * dbip-city-lite.mmdb, and MaxMind ships GeoLite2-City.mmdb. DB-IP is the default because it is
 * what the script installs.
 */
export function mmdbAttribution(path: string): IpGeolocationAttribution {
  const file = path.split("/").pop()?.toLowerCase() ?? "";
  return file.includes("geolite")
    ? { text: "IP geolocation by MaxMind GeoLite2", url: "https://www.maxmind.com" }
    : { text: "IP geolocation by DB-IP", url: "https://db-ip.com" };
}

export function selectIpGeolocator(
  config: { mmdbPath?: string; ipinfoToken?: string },
  deps: { fetchImpl?: typeof fetch; mmdb?: MmdbGeolocatorDeps } = {},
): IpGeolocationSelection {
  const mmdbPath = config.mmdbPath?.trim();
  if (mmdbPath) {
    return {
      provider: "mmdb",
      geolocate: createMmdbGeolocator(mmdbPath, deps.mmdb),
      attribution: mmdbAttribution(mmdbPath),
      summary: `local city database at ${mmdbPath} (city-level)`,
    };
  }
  const token = config.ipinfoToken?.trim();
  if (token) {
    return {
      provider: "ipinfo",
      geolocate: createIpinfoGeolocator(token, deps.fetchImpl),
      attribution: { text: "IP address data powered by IPinfo", url: "https://ipinfo.io" },
      summary: "IPinfo (city-level on a paid plan; country only on the free Lite tier)",
    };
  }
  return {
    provider: "off",
    summary:
      "off -- set ADMINBOT_GEOIP_MMDB_PATH (see scripts/adminbot-geoip-refresh.sh) or IPINFO_TOKEN",
  };
}

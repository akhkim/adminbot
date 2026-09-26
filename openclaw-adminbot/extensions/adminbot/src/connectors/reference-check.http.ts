import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { XMLValidator } from "fast-xml-parser";

export type LookupContext = {
  signal: AbortSignal;
  requestIntervalMs?: number;
  failures: Set<string>;
  available?: Set<string>;
  lastRequest: Map<string, number>;
  fetch: typeof globalThis.fetch;
  /** Without a key OpenAlex shares a small daily budget across the host's IP. */
  openAlexApiKey?: string;
  /**
   * Host -> epoch ms until which it is left alone. Shared across checks by the unattended sweep:
   * DBLP blocked Aurora outright after the first sweep kept asking through its 429s.
   */
  cooldowns?: Map<string, number>;
  /**
   * Wait out a required database's cooldown this long or shorter, rather than failing the lookup.
   * For the unattended sweep: a 429 usually asks for a minute, and failing instead left every
   * remaining reference of the paper "not fully checked". Unset (the interactive page) never waits.
   */
  maxCooldownWaitMs?: number;
  /**
   * Sent on every lookup. DBLP answers a generic client (node, curl, python-requests) with a
   * "Making sure you're not a bot" challenge page instead of results, and an identified one --
   * a name and a contact address -- with the API. Crossref asks for the same.
   */
  userAgent?: string;
};

/** The client name, with a contact address when a valid one is configured. */
export function referenceUserAgent(contactEmail: string | undefined): string {
  const email = contactEmail?.trim() ?? "";
  const valid = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u.test(email);
  return `JinesisAdminBot/1.0 (reference checker${valid ? `; mailto:${email}` : ""})`;
}

/**
 * The two databases a "not found" depends on (see reference-check.ts). Only these are waited for:
 * the others are optional, and OpenAlex's cooldown after its daily budget runs out lasts hours.
 */
export const REQUIRED_SOURCES = new Set(["api.crossref.org", "dblp.org"]);

const DEFAULT_COOLDOWN_MS = 15 * 60_000;
// A reset connection from anyone but DBLP is a network blip, not a ban: Crossref dropped one
// connection in fifty-odd on Aurora, and fifteen minutes of cooldown on a required database
// failed the rest of that paper.
const BLIP_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 6 * 60 * 60_000;

/** Retry-After as seconds or an HTTP date, bounded; absent or unreadable means the default. */
export function cooldownFor(retryAfter: string | null, now = Date.now()): number {
  const seconds = Number(retryAfter);
  const ms =
    Number.isFinite(seconds) && retryAfter?.trim()
      ? seconds * 1000
      : retryAfter && Number.isFinite(Date.parse(retryAfter))
        ? Date.parse(retryAfter) - now
        : DEFAULT_COOLDOWN_MS;
  return Math.min(MAX_COOLDOWN_MS, Math.max(60_000, ms));
}
export const lookupContext = new AsyncLocalStorage<LookupContext>();
/**
 * DBLP's hosts, in the order they are tried. The mirror at Trier sits on a different network from
 * dblp.org (and dblp.dagstuhl.de, which shares its block): when dblp.org rate-limits Aurora and
 * then resets every connection -- as it did the night before the ICLR 2027 deadline, leaving each
 * paper with a dozen references "not fully checked" -- Trier still answers the same API.
 *
 * Lookups are still recorded under "dblp.org": DBLP is one database however it is reached, and the
 * rule that a "not found" needs DBLP to have answered is unchanged.
 */
export const DBLP_HOSTS = ["dblp.org", "dblp.uni-trier.de"] as const;
const DBLP = "dblp.org";

const hosts = new Set([
  "api.crossref.org",
  "api.semanticscholar.org",
  "api.openalex.org",
  ...DBLP_HOSTS,
  "export.arxiv.org",
]);

/** When a source can next be asked. For DBLP, the soonest of its hosts. */
export function sourceCooldownUntil(cooldowns: Map<string, number>, source: string): number {
  return source === DBLP
    ? Math.min(...DBLP_HOSTS.map((host) => cooldowns.get(host) ?? 0))
    : (cooldowns.get(source) ?? 0);
}

// Imported only by the vendored engine: no global fetch patch, proxy or arbitrary citation URL.
export async function referenceFetch(input: string, init?: RequestInit): Promise<Response> {
  const context = lookupContext.getStore();
  if (!context) {
    throw new Error("Reference lookup context is required");
  }
  const url = new URL(input);
  if (url.hostname !== DBLP) {
    return fetchFromHost(context, url, init, url.hostname);
  }
  // DBLP: each host in turn, the one free soonest first. A host that fails puts itself on
  // cooldown inside fetchFromHost, so the next lookup goes straight to the one that answers; a
  // host cooling down for longer than the context will wait is skipped.
  let lastError: unknown = new Error("Reference database is cooling down");
  const order = [...DBLP_HOSTS].toSorted(
    (a, b) => (context.cooldowns?.get(a) ?? 0) - (context.cooldowns?.get(b) ?? 0),
  );
  for (const host of order) {
    const remaining = (context.cooldowns?.get(host) ?? 0) - Date.now();
    if (remaining > 0 && remaining > (context.maxCooldownWaitMs ?? 0)) {
      continue;
    }
    const mirrored = new URL(url);
    mirrored.hostname = host;
    try {
      return await fetchFromHost(context, mirrored, init, DBLP);
    } catch (error) {
      lastError = error;
      if (context.signal.aborted) {
        break;
      }
    }
  }
  context.failures.add(DBLP);
  throw lastError;
}

/**
 * One request to one host. `source` is the database it counts as -- the host itself, except for
 * a DBLP mirror, which counts as DBLP -- while cooldowns and request spacing stay per host.
 */
async function fetchFromHost(
  context: LookupContext,
  url: URL,
  init: RequestInit | undefined,
  source: string,
): Promise<Response> {
  if (
    url.protocol !== "https:" ||
    !hosts.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error("Unsupported reference database");
  }
  if (url.hostname === "api.openalex.org" && context.openAlexApiKey) {
    url.searchParams.set("api_key", context.openAlexApiKey);
  }
  const host = url.hostname;
  const remaining = (context.cooldowns?.get(host) ?? 0) - Date.now();
  if (remaining > 0) {
    if (REQUIRED_SOURCES.has(source) && remaining <= (context.maxCooldownWaitMs ?? 0)) {
      await delay(remaining, undefined, { signal: context.signal });
    } else {
      if (source !== DBLP) {
        context.failures.add(source);
      }
      throw new Error("Reference database is cooling down");
    }
  }
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(12_000)]);
  try {
    const wait =
      (context.requestIntervalMs ?? 3_000) - (Date.now() - (context.lastRequest.get(host) ?? 0));
    if (wait > 0) {
      await delay(wait, undefined, { signal });
    }
    context.lastRequest.set(host, Date.now());
    const response = await context.fetch(url, {
      ...init,
      ...(context.userAgent
        ? {
            headers: {
              ...Object.fromEntries(new Headers(init?.headers).entries()),
              "User-Agent": context.userAgent,
            },
          }
        : {}),
      method: "GET",
      redirect: "error",
      signal,
    });
    // A missing DOI is a legitimate empty result; rate limits and server errors are not.
    if (
      !response.ok &&
      !(
        response.status === 404 &&
        source === "api.crossref.org" &&
        url.pathname.startsWith("/works/")
      )
    ) {
      await response.body?.cancel();
      if (response.status === 429 || response.status === 503) {
        context.cooldowns?.set(host, Date.now() + cooldownFor(response.headers.get("retry-after")));
      }
      throw new Error("Database unavailable");
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        if (!reader) {
          break;
        }
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) {
          throw new Error("Database response too large");
        }
        chunks.push(value);
      }
    } finally {
      await reader?.cancel();
    }
    const body = Buffer.concat(chunks).toString("utf8");
    if (response.ok) {
      // Upstream catches parsing errors; detect malformed responses here before they disappear.
      if (source !== "export.arxiv.org") {
        const data = JSON.parse(body);
        const valid =
          source === "api.crossref.org"
            ? url.pathname === "/works"
              ? Array.isArray(data.message?.items)
              : Array.isArray(data.message?.title)
            : source === "api.semanticscholar.org"
              ? Array.isArray(data.data) || data.total === 0
              : source === "api.openalex.org"
                ? Array.isArray(data.results)
                : Boolean(data.result?.hits);
        if (!valid) {
          throw new Error("Invalid database response");
        }
      } else if (!body.includes("<feed") || XMLValidator.validate(body) !== true) {
        throw new Error("Invalid database response");
      }
    }
    context.available?.add(source);
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (error) {
    // A DBLP host that fails is not yet DBLP failing: referenceFetch tries the next one first.
    if (source !== DBLP) {
      context.failures.add(source);
    }
    // A refused or reset connection (not our own cancellation) is how DBLP says "too many".
    if (error instanceof TypeError && !context.signal.aborted) {
      context.cooldowns?.set(
        host,
        Date.now() + (source === DBLP ? DEFAULT_COOLDOWN_MS : BLIP_COOLDOWN_MS),
      );
    }
    // The engine swallows this, so the cause never reaches an API response.
    throw new Error("Reference database request failed", { cause: error });
  }
}

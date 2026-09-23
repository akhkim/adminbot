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
};

const DEFAULT_COOLDOWN_MS = 15 * 60_000;
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
const hosts = new Set([
  "api.crossref.org",
  "api.semanticscholar.org",
  "api.openalex.org",
  "dblp.org",
  "export.arxiv.org",
]);

// Imported only by the vendored engine: no global fetch patch, proxy or arbitrary citation URL.
export async function referenceFetch(input: string, init?: RequestInit): Promise<Response> {
  const context = lookupContext.getStore();
  if (!context) {
    throw new Error("Reference lookup context is required");
  }
  const url = new URL(input);
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
  const source = url.hostname;
  if ((context.cooldowns?.get(source) ?? 0) > Date.now()) {
    context.failures.add(source);
    throw new Error("Reference database is cooling down");
  }
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(12_000)]);
  try {
    const wait =
      (context.requestIntervalMs ?? 3_000) - (Date.now() - (context.lastRequest.get(source) ?? 0));
    if (wait > 0) {
      await delay(wait, undefined, { signal });
    }
    context.lastRequest.set(source, Date.now());
    const response = await context.fetch(url, {
      ...init,
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
        context.cooldowns?.set(
          source,
          Date.now() + cooldownFor(response.headers.get("retry-after")),
        );
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
    context.failures.add(source);
    // A refused or reset connection (not our own cancellation) is how DBLP says "too many".
    if (error instanceof TypeError && !context.signal.aborted) {
      context.cooldowns?.set(source, Date.now() + DEFAULT_COOLDOWN_MS);
    }
    // The engine swallows this, so the cause never reaches an API response.
    throw new Error("Reference database request failed", { cause: error });
  }
}

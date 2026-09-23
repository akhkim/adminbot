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
};
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
  const source = url.hostname;
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
  } catch {
    context.failures.add(source);
    throw new Error("Reference database request failed");
  }
}

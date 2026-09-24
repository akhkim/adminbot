import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../../../../public/sw.js", import.meta.url)),
  "utf8",
);
function worker(fetcher = vi.fn()) {
  const handlers = new Map<string, (event: any) => void>();
  const shell = new Response("saved shell");
  const cache = { match: vi.fn(async () => shell), put: vi.fn() };
  runInNewContext(source, {
    URL,
    Response,
    fetch: fetcher,
    caches: { open: async () => cache, match: cache.match },
    self: {
      location: { href: "https://portal.test/sw.js", origin: "https://portal.test" },
      registration: { scope: "https://portal.test/" },
      navigator: { onLine: true },
      addEventListener: (type: string, handler: (event: any) => void) =>
        handlers.set(type, handler),
    },
  });
  const dispatch = (url: string, mode = "navigate") => {
    const respondWith = vi.fn();
    handlers.get("fetch")!({
      request: { url, mode, method: "GET" },
      respondWith,
      waitUntil: vi.fn(),
    });
    return respondWith.mock.calls[0]?.[0] as Promise<Response> | undefined;
  };
  return { dispatch, fetcher, cache };
}

describe("offline navigation boundaries", () => {
  it("reopens on a failed network request even when onLine reports true", async () => {
    const { dispatch } = worker(vi.fn().mockRejectedValue(new TypeError("unreachable")));
    expect(await (await dispatch("https://portal.test/rec-letters"))!.text()).toBe("saved shell");
  });
  it("preserves authentication challenges through one browser-managed navigation", async () => {
    const { dispatch, fetcher, cache } = worker(
      vi.fn().mockResolvedValue(
        new Response("", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="test"' },
        }),
      ),
    );
    const response = await dispatch("https://portal.test/rec-letters");
    expect(response?.status).toBe(302);
    expect(response?.headers.get("Location")).toBe(
      "https://portal.test/rec-letters?__adminbot_native_auth=1",
    );
    expect(dispatch(response!.headers.get("Location")!)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.match).not.toHaveBeenCalled();
  });
  it("does not substitute cached data for a forbidden response", async () => {
    const { dispatch, cache } = worker(
      vi.fn().mockResolvedValue(new Response("", { status: 403 })),
    );
    expect((await dispatch("https://portal.test/"))?.status).toBe(403);
    expect(cache.match).not.toHaveBeenCalled();
  });
  it("does not cache same-origin authenticated endpoints", () => {
    const { dispatch, fetcher, cache } = worker();
    expect(dispatch("https://portal.test/lab/members", "cors")).toBeUndefined();
    expect(dispatch("https://portal.test/member-drafts/book-meeting", "cors")).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });
});

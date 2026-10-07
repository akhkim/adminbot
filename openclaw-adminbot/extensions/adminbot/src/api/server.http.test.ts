// JSON responses: gzip when the client asks for it and the body is worth compressing.
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { sendHtml, sendJson } from "./server.http.js";

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

type Raw = { status: number; headers: Record<string, unknown>; raw: Buffer };

async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
  server = createServer(handler);
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function get(port: number, headers: Record<string, string> = {}): Promise<Raw> {
  return await new Promise((resolve, reject) => {
    const req = request({ port, host: "127.0.0.1", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function fetchRaw(body: unknown, acceptEncoding?: string): Promise<Raw> {
  const port = await serve((_req, res) => sendJson(res, 200, body));
  return await get(port, acceptEncoding ? { "accept-encoding": acceptEncoding } : {});
}

const large = { members: Array.from({ length: 200 }, (_unused, index) => ({ id: `m${index}` })) };

describe("sendJson compression", () => {
  it("gzips a large body for a client that accepts gzip", async () => {
    const { headers, raw } = await fetchRaw(large, "gzip, deflate, br");
    expect(headers["content-encoding"]).toBe("gzip");
    expect(headers.vary).toBe("Accept-Encoding");
    expect(JSON.parse(gunzipSync(raw).toString("utf8"))).toEqual(large);
  });

  it("sends plain JSON when the client does not accept gzip", async () => {
    for (const acceptEncoding of [undefined, "identity", "gzip;q=0"]) {
      const { headers, raw } = await fetchRaw(large, acceptEncoding);
      expect(headers["content-encoding"]).toBeUndefined();
      expect(JSON.parse(raw.toString("utf8"))).toEqual(large);
    }
  });

  it("leaves small bodies uncompressed", async () => {
    const { headers, raw } = await fetchRaw({ ok: true }, "gzip");
    expect(headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(raw.toString("utf8"))).toEqual({ ok: true });
  });
});

// The console, venue picker and member map are fixed per build: rendered once, gzipped once, and
// revalidated by ETag, so a reload costs a 304 rather than 150KB.
describe("sendHtml", () => {
  it("renders a page once, gzips it, and answers a matching revalidation with 304", async () => {
    let renders = 0;
    const page = () => {
      renders += 1;
      return `<!doctype html><p>${"console ".repeat(400)}</p>`;
    };
    const port = await serve((_req, res) => sendHtml(res, page));

    const first = await get(port, { "accept-encoding": "gzip" });
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(first.headers["content-encoding"]).toBe("gzip");
    expect(first.headers["cache-control"]).toBe("no-cache");
    expect(gunzipSync(first.raw).toString("utf8")).toBe(page());
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^"[0-9a-f]+"$/);

    const plain = await get(port);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.raw.toString("utf8")).toBe(page());

    const again = await get(port, { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(again.raw.length).toBe(0);

    // Two requests above plus the two comparisons: one render served all three requests.
    expect(renders).toBe(3);
  });
});

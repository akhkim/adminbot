// JSON responses: gzip when the client asks for it and the body is worth compressing.
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { sendJson } from "./server.http.js";

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function fetchRaw(
  body: unknown,
  acceptEncoding?: string,
): Promise<{ headers: Record<string, unknown>; raw: Buffer }> {
  server = createServer((_req, res) => sendJson(res, 200, body));
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        port,
        host: "127.0.0.1",
        headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ headers: res.headers, raw: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
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

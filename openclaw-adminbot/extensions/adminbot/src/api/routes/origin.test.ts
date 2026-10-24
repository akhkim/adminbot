import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { remoteIp } from "./origin.js";

// Documentation-range addresses only (RFC 5737).
function request(headers: Record<string, string | string[]>, peer = "127.0.0.1"): IncomingMessage {
  return { headers, socket: { remoteAddress: peer } } as unknown as IncomingMessage;
}

describe("remoteIp", () => {
  it("uses the socket peer when proxy headers are not trusted", () => {
    const req = request({ "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.9" });
    expect(remoteIp(req, false)).toBe("127.0.0.1");
  });

  it("prefers the address Cloudflare set", () => {
    const req = request({
      "cf-connecting-ip": "198.51.100.7",
      "x-forwarded-for": "203.0.113.9, 198.51.100.7",
    });
    expect(remoteIp(req, true)).toBe("198.51.100.7");
  });

  it("ignores a client-chosen first X-Forwarded-For entry and takes the one the proxy appended", () => {
    const req = request({ "x-forwarded-for": "203.0.113.9, 192.0.2.44" });
    expect(remoteIp(req, true)).toBe("192.0.2.44");
  });

  it("reads repeated X-Forwarded-For headers in order", () => {
    const req = request({ "x-forwarded-for": ["203.0.113.9", "192.0.2.44"] });
    expect(remoteIp(req, true)).toBe("192.0.2.44");
  });

  it("falls back to the socket peer when the trusted headers are empty", () => {
    expect(remoteIp(request({ "x-forwarded-for": " , " }), true)).toBe("127.0.0.1");
  });
});

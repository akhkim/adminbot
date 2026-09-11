import { describe, expect, it } from "vitest";
import { createPublicDeadlineLimiter } from "./server.public-deadline-proposals.js";

describe("public deadline rate limit", () => {
  it("expires per-address windows and keeps other addresses independent", () => {
    let time = 0;
    const limiter = createPublicDeadlineLimiter(() => time);
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("192.0.2.1")).toBe(0);
    }
    expect(limiter.check("192.0.2.1")).toBe(3600);
    expect(limiter.check("192.0.2.2")).toBe(0);
    time = 3600000;
    expect(limiter.check("192.0.2.1")).toBe(0);
  });
  it("does not impose a shared quota on different addresses", () => {
    const limiter = createPublicDeadlineLimiter(() => 0);
    for (let i = 0; i < 101; i++) {
      expect(limiter.check(`address-${i}`)).toBe(0);
    }
  });
});

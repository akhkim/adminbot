import { describe, expect, it } from "vitest";
import {
  DEVICE_TZ_HEADER,
  DEVICE_TZ_OFFSET_HEADER,
  deviceClockHeaders,
  memberAuthHeaders,
} from "./device-clock.ts";

describe("deviceClockHeaders", () => {
  it("sends the browser's zone name and its offset east of UTC", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const headers = deviceClockHeaders(now);
    expect(headers[DEVICE_TZ_HEADER]).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(headers[DEVICE_TZ_OFFSET_HEADER]).toBe(String(-now.getTimezoneOffset()));
  });
});

describe("memberAuthHeaders", () => {
  it("sends the bearer token together with the browser's clock", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    expect(memberAuthHeaders("tok_example", now)).toEqual({
      Authorization: "Bearer tok_example",
      ...deviceClockHeaders(now),
    });
  });

  it("sends nothing without a token", () => {
    expect(memberAuthHeaders(undefined)).toEqual({});
    expect(memberAuthHeaders(null)).toEqual({});
    expect(memberAuthHeaders("")).toEqual({});
  });

  it("is the only place an AdminBot call builds its bearer header", () => {
    // A call that builds its own header forgets the clock, and the server then reads the request
    // as zone-less. Every authenticated fetch goes through memberAuthHeaders instead.
    const sources = import.meta.glob(["../**/*.ts", "!../**/*.test.ts", "!./device-clock.ts"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const offenders = Object.entries(sources)
      .filter(([, text]) => text.includes("Bearer ${"))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

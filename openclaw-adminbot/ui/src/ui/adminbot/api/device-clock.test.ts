import { describe, expect, it } from "vitest";
import { DEVICE_TZ_HEADER, DEVICE_TZ_OFFSET_HEADER, deviceClockHeaders } from "./device-clock.ts";

describe("deviceClockHeaders", () => {
  it("sends the browser's zone name and its offset east of UTC", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const headers = deviceClockHeaders(now);
    expect(headers[DEVICE_TZ_HEADER]).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(headers[DEVICE_TZ_OFFSET_HEADER]).toBe(String(-now.getTimezoneOffset()));
  });
});

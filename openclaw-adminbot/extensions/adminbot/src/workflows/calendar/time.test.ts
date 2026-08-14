import { describe, expect, it } from "vitest";
import { toAbsoluteRfc3339 } from "./time.js";

describe("toAbsoluteRfc3339", () => {
  // The failure this exists for: the drafting model returns a zoneless wall-clock time, and the
  // Calendar API answered `400 badRequest` for every write until it was resolved to an instant.
  it("resolves a zoneless wall-clock time against the calendar's zone", () => {
    // 1 September 2026 is EDT (UTC-4), so 13:00 in Toronto is 17:00Z.
    expect(toAbsoluteRfc3339("2026-09-01T13:00", "America/Toronto")).toBe(
      "2026-09-01T17:00:00.000Z",
    );
  });

  it("handles the same wall clock in a different zone", () => {
    expect(toAbsoluteRfc3339("2026-09-01T13:00", "Europe/Zurich")).toBe("2026-09-01T11:00:00.000Z");
    expect(toAbsoluteRfc3339("2026-09-01T13:00", "UTC")).toBe("2026-09-01T13:00:00.000Z");
  });

  // Winter and summer differ by an hour, which is the whole reason this is not a fixed offset.
  it("uses the offset in force on that date, not a fixed one", () => {
    // January is EST (UTC-5).
    expect(toAbsoluteRfc3339("2026-01-15T13:00", "America/Toronto")).toBe(
      "2026-01-15T18:00:00.000Z",
    );
    // July is EDT (UTC-4).
    expect(toAbsoluteRfc3339("2026-07-15T13:00", "America/Toronto")).toBe(
      "2026-07-15T17:00:00.000Z",
    );
  });

  // Times on the day the clocks change are where a single-pass conversion lands an hour out.
  it("is correct on both sides of a daylight-saving change", () => {
    // Clocks go forward 08 March 2026 at 02:00 EST. 01:00 is still EST (UTC-5).
    expect(toAbsoluteRfc3339("2026-03-08T01:00", "America/Toronto")).toBe(
      "2026-03-08T06:00:00.000Z",
    );
    // 03:00 the same morning is EDT (UTC-4).
    expect(toAbsoluteRfc3339("2026-03-08T03:00", "America/Toronto")).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    // Clocks go back 01 November 2026; the afternoon is EST again.
    expect(toAbsoluteRfc3339("2026-11-01T13:00", "America/Toronto")).toBe(
      "2026-11-01T18:00:00.000Z",
    );
  });

  it("accepts seconds when the model includes them", () => {
    expect(toAbsoluteRfc3339("2026-09-01T13:00:30", "America/Toronto")).toBe(
      "2026-09-01T17:00:30.000Z",
    );
  });

  // An unambiguous value is already correct; rewriting it could only introduce error.
  it.each([
    ["a UTC instant", "2026-09-01T17:00:00Z"],
    ["an offset time", "2026-09-01T13:00:00-04:00"],
  ])("leaves %s untouched", (_label, value) => {
    expect(toAbsoluteRfc3339(value, "America/Toronto")).toBe(value);
  });

  // An all-day date belongs in Google's date field; turning it into midnight would move it.
  it("leaves a bare date alone", () => {
    expect(toAbsoluteRfc3339("2026-09-01", "America/Toronto")).toBe("2026-09-01");
  });

  it.each([
    ["prose", "next Tuesday"],
    ["empty", "   "],
    ["a partial time", "2026-09-01T13"],
  ])("returns nothing for %s", (_label, value) => {
    expect(toAbsoluteRfc3339(value, "America/Toronto")).toBeUndefined();
  });
});

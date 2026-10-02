import { describe, expect, it } from "vitest";
import { rangeStart } from "./travel.ts";

describe("rangeStart", () => {
  it("asks for the whole log when the range is all time", () => {
    expect(rangeStart("all")).toBeUndefined();
  });

  it("starts a 12-month window at the first of the month, not the current hour", () => {
    // Pinned so two loads a minute apart cannot return different stays.
    expect(rangeStart("12m", new Date("2026-09-06T17:42:11.000Z"))).toBe(
      "2025-09-01T00:00:00.000Z",
    );
  });

  it("crosses the year boundary correctly for a 24-month window", () => {
    expect(rangeStart("24m", new Date("2026-02-14T00:00:00.000Z"))).toBe(
      "2024-02-01T00:00:00.000Z",
    );
  });
});

// The deadline board re-renders every second, and each row formats several labels. Building an
// Intl.DateTimeFormat costs ~15x formatting with one, so equal requests share an instance.
import { describe, expect, it } from "vitest";
import { dateTimeFormat } from "./date-format.ts";

describe("dateTimeFormat", () => {
  it("reuses one formatter per locale and options", () => {
    const a = dateTimeFormat("en-US", { timeZone: "UTC", hour: "2-digit" });
    expect(dateTimeFormat("en-US", { timeZone: "UTC", hour: "2-digit" })).toBe(a);
    expect(dateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "2-digit" })).not.toBe(a);
    expect(dateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit" })).not.toBe(a);
    expect(a.format(0)).toBe(
      new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "2-digit" }).format(0),
    );
  });

  it("throws for an unknown zone, as the constructor does", () => {
    expect(() => dateTimeFormat("en", { timeZone: "Not/AZone" })).toThrow(RangeError);
  });
});

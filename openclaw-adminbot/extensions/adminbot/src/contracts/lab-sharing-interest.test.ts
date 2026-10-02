import { describe, expect, it } from "vitest";
import { validateHelpInterest } from "./lab-sharing-interest.js";

describe("help interest input", () => {
  it("accepts availability while dropping spoofed identity and lifecycle fields", () => {
    expect(
      validateHelpInterest({
        hours_per_week: 0.5,
        note: "  I can review  ",
        member_id: "other",
        status: "withdrawn",
        created_at: "fake",
      }),
    ).toEqual({ hours_per_week: 0.5, note: "I can review" });
    expect(validateHelpInterest({ hours_per_week: 168 })).toEqual({
      hours_per_week: 168,
      note: "",
    });
  });
  it.each([
    null,
    [],
    "text",
    {},
    { hours_per_week: "2" },
    { hours_per_week: 0 },
    { hours_per_week: -1 },
    { hours_per_week: 169 },
    { hours_per_week: Infinity },
    { hours_per_week: NaN },
    { hours_per_week: 2, note: null },
    { hours_per_week: 2, note: "x".repeat(1001) },
  ])("rejects invalid payload %j", (input) => {
    expect(typeof validateHelpInterest(input)).toBe("string");
  });
  it("applies the note limit after trimming", () => {
    expect(validateHelpInterest({ hours_per_week: 1, note: ` ${"x".repeat(1000)} ` })).toEqual({
      hours_per_week: 1,
      note: "x".repeat(1000),
    });
  });
});

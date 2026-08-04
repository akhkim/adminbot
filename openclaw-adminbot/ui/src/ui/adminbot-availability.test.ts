import { describe, expect, it } from "vitest";
import { availabilityRows, timeOffRows, todayIso } from "./adminbot-availability.js";

const ROWS = [
  { start: "2026-08-03", end: "2026-08-30", project: "Rebuttals", hours_per_week: 18 },
  { start: "2026-08-03", end: "2026-09-03", hours_per_week: 12, note: "term baseline" },
  { start: "2026-08-03", end: "2026-08-30", project: "__open__", hours_per_week: 5 },
];

describe("availabilityRows", () => {
  it("keeps well-formed rows and drops anything malformed", () => {
    expect(
      availabilityRows([...ROWS, { start: "2026-08-03" }, { end: "2026-08-30" }, null, "nope", 42]),
    ).toEqual(ROWS);
  });

  it("reads a missing or non-numeric hours figure as zero rather than NaN", () => {
    expect(
      availabilityRows([{ start: "2026-08-03", end: "2026-08-30", hours_per_week: "ten" }]),
    ).toEqual([{ start: "2026-08-03", end: "2026-08-30", hours_per_week: 0 }]);
  });

  it("returns nothing for a payload that is not a list", () => {
    expect(availabilityRows(undefined)).toEqual([]);
    expect(availabilityRows({ start: "2026-08-03" })).toEqual([]);
  });
});

describe("timeOffRows", () => {
  it("keeps the kind and note, and preserves partial vs full absence", () => {
    expect(
      timeOffRows([
        { start: "2026-08-01", end: "2026-12-31", kind: "internship", availability: "none" },
        { start: "2026-09-01", end: "2026-09-30", kind: "course_load", availability: "partial" },
      ]),
    ).toEqual([
      { start: "2026-08-01", end: "2026-12-31", kind: "internship", availability: "none" },
      { start: "2026-09-01", end: "2026-09-30", kind: "course_load", availability: "partial" },
    ]);
  });

  // "partial" still counts toward capacity, so anything that is not explicitly partial has to
  // read as a full absence rather than being guessed at.
  it("treats an unrecognised availability value as fully away", () => {
    expect(
      timeOffRows([{ start: "2026-08-01", end: "2026-08-07", availability: "sometimes" }]),
    ).toEqual([{ start: "2026-08-01", end: "2026-08-07", availability: "none" }]);
  });
});

describe("todayIso", () => {
  it("reads the viewer's calendar day, not a UTC instant", () => {
    expect(todayIso(new Date(2026, 7, 6, 23, 30))).toBe("2026-08-06");
  });
});

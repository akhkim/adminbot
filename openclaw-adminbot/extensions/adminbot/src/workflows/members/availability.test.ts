import { describe, expect, it } from "vitest";
import type { AdminBotTimeOffRow } from "../../contracts/actions.js";
import { fullyAwayOn } from "./availability.js";

const internship: AdminBotTimeOffRow = {
  start: "2026-08-01",
  end: "2026-12-31",
  kind: "internship",
  availability: "none",
  note: "internship at DeepMind",
};

const heavyTerm: AdminBotTimeOffRow = {
  start: "2026-08-01",
  end: "2026-12-31",
  kind: "course_load",
  availability: "partial",
};

describe("fullyAwayOn", () => {
  it("reports the entry that has the member away on the day asked about", () => {
    expect(fullyAwayOn({ time_off: [internship] }, "2026-08-06")).toEqual(internship);
  });

  it("treats partly away as present — they are around, just with less time", () => {
    expect(fullyAwayOn({ time_off: [heavyTerm] }, "2026-08-06")).toBeUndefined();
  });

  it("reports nothing outside the recorded range, or with nothing recorded", () => {
    expect(fullyAwayOn({ time_off: [internship] }, "2026-07-31")).toBeUndefined();
    expect(fullyAwayOn({ time_off: [internship] }, "2027-01-01")).toBeUndefined();
    expect(fullyAwayOn({}, "2026-08-06")).toBeUndefined();
  });

  it("ignores a row missing either end of its range rather than guessing one", () => {
    expect(
      fullyAwayOn(
        { time_off: [{ start: "2026-08-01", end: "", kind: "other", availability: "none" }] },
        "2026-08-06",
      ),
    ).toBeUndefined();
  });
});

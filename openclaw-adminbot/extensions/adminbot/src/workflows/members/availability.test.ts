import { describe, expect, it } from "vitest";
import type { AdminBotTimeOffRow } from "../../contracts/actions.js";
import { fullyAwayOn, tripOn } from "./availability.js";

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

describe("tripOn", () => {
  const traveller = {
    trips: [
      { start: "2026-09-01", end: "2026-09-10", city: "Berlin" },
      { start: "2026-09-20", end: "2026-09-25", city: "Vancouver" },
    ],
  };

  it("finds the trip covering a day, inclusive of both ends", () => {
    expect(tripOn(traveller, "2026-09-01")?.city).toBe("Berlin");
    expect(tripOn(traveller, "2026-09-10")?.city).toBe("Berlin");
    expect(tripOn(traveller, "2026-09-22")?.city).toBe("Vancouver");
  });

  it("is undefined between trips and for a member with none", () => {
    expect(tripOn(traveller, "2026-09-15")).toBeUndefined();
    expect(tripOn({}, "2026-09-15")).toBeUndefined();
  });

  // Nobody is in two cities. Taking the most recently added row means a correction typed today
  // beats a stale row without the member having to delete it first.
  it("takes the last of two overlapping rows", () => {
    expect(
      tripOn(
        {
          trips: [
            { start: "2026-09-01", end: "2026-09-30", city: "Berlin" },
            { start: "2026-09-05", end: "2026-09-08", city: "Vancouver" },
          ],
        },
        "2026-09-06",
      )?.city,
    ).toBe("Vancouver");
  });
});

import { describe, expect, it } from "vitest";
import { tripOnDay, tripRows, whereBins, type TripRow } from "./availability.ts";

const DAY_MS = 86_400_000;

function monthBins(): Array<{ startMs: number; endMs: number; label: string }> {
  return [
    { startMs: Date.UTC(2026, 8, 1), endMs: Date.UTC(2026, 9, 1), label: "Sep" },
    { startMs: Date.UTC(2026, 9, 1), endMs: Date.UTC(2026, 10, 1), label: "Oct" },
  ];
}

const BERLIN: TripRow = { start: "2026-09-01", end: "2026-09-30", city: "Berlin" };

describe("whereBins", () => {
  it("names the trip for periods it covers and home for the rest", () => {
    expect(whereBins(monthBins(), [BERLIN], "Toronto")).toEqual([
      { label: "Sep", city: "Berlin", away: true, segments: [] },
      { label: "Oct", city: "Toronto", away: false, segments: [] },
    ]);
  });

  // "Vancouver*" said only "not the whole period" and left the reader to guess which part. The
  // segments are what answer from when to when, in which city.
  it("breaks a mixed period into dated stretches", () => {
    const short: TripRow = { start: "2026-09-10", end: "2026-09-12", city: "Vancouver" };
    expect(whereBins(monthBins(), [short], "Toronto")[0]).toEqual({
      label: "Sep",
      // Most of September is still spent at home, so that is what the cell says.
      city: "Toronto",
      away: false,
      segments: [
        { start: "2026-09-01", end: "2026-09-09", city: "Toronto", away: false },
        { start: "2026-09-10", end: "2026-09-12", city: "Vancouver", away: true },
        { start: "2026-09-13", end: "2026-09-30", city: "Toronto", away: false },
      ],
    });
  });

  // A period that is all one place needs no breakdown, and carrying one would put a single
  // redundant line in every hover on the strip.
  it("carries no segments for a period spent in one place", () => {
    expect(whereBins(monthBins(), [BERLIN], "Toronto")[0]?.segments).toEqual([]);
  });

  it("collapses two adjacent trips to the same city into one stretch", () => {
    const trips: TripRow[] = [
      { start: "2026-09-02", end: "2026-09-04", city: "Berlin" },
      { start: "2026-09-05", end: "2026-09-07", city: "Berlin" },
    ];
    const segments = whereBins(monthBins(), trips, "Toronto")[0]?.segments ?? [];
    expect(segments.filter((segment) => segment.away)).toEqual([
      { start: "2026-09-02", end: "2026-09-07", city: "Berlin", away: true },
    ]);
  });

  it("labels a period with whichever place covers most of it", () => {
    const trips: TripRow[] = [
      { start: "2026-09-01", end: "2026-09-05", city: "Vancouver" },
      { start: "2026-09-06", end: "2026-09-30", city: "Berlin" },
    ];
    const bin = whereBins(monthBins(), trips, "Toronto")[0];
    expect(bin?.city).toBe("Berlin");
    expect(bin?.segments.map((segment) => segment.city)).toEqual(["Vancouver", "Berlin"]);
  });

  // A trip ending on the 30th includes the 30th; an exclusive end would drop the last day and, for
  // a one-day trip, the whole thing.
  it("counts the end date as part of the trip", () => {
    const lastDay: TripRow = { start: "2026-09-30", end: "2026-09-30", city: "Vancouver" };
    const segments = whereBins(monthBins(), [lastDay], "Toronto")[0]?.segments ?? [];
    expect(segments.at(-1)).toEqual({
      start: "2026-09-30",
      end: "2026-09-30",
      city: "Vancouver",
      away: true,
    });
  });

  it("carries an empty city rather than inventing one when home is unknown", () => {
    expect(whereBins(monthBins(), [], null)).toEqual([
      { label: "Sep", city: "", away: false, segments: [] },
      { label: "Oct", city: "", away: false, segments: [] },
    ]);
  });

  it("ignores a row with unparseable dates instead of throwing", () => {
    const broken = { start: "soon", end: "later", city: "Nowhere" } as TripRow;
    expect(whereBins(monthBins(), [broken], "Toronto")[0]?.city).toBe("Toronto");
  });

  it("handles a daily binning, which is what the week range asks for", () => {
    const start = Date.UTC(2026, 8, 14);
    const daily = Array.from({ length: 3 }, (_, index) => ({
      startMs: start + index * DAY_MS,
      endMs: start + (index + 1) * DAY_MS,
      label: `d${index}`,
    }));
    const trip: TripRow = { start: "2026-09-15", end: "2026-09-15", city: "Berlin" };
    expect(whereBins(daily, [trip], "Toronto").map((bin) => bin.city)).toEqual([
      "Toronto",
      "Berlin",
      "Toronto",
    ]);
  });
});

describe("tripRows", () => {
  it("drops a row with no city, which is time off rather than a trip", () => {
    expect(tripRows([{ start: "2026-09-01", end: "2026-09-30" }])).toEqual([]);
    expect(tripRows([{ start: "2026-09-01", end: "2026-09-30", city: " " }])).toEqual([]);
  });

  it("keeps the optional fields it is given and nothing else", () => {
    expect(
      tripRows([{ start: "2026-09-01", end: "2026-09-30", city: "Berlin", nonsense: 1 }]),
    ).toEqual([{ start: "2026-09-01", end: "2026-09-30", city: "Berlin" }]);
  });

  it("is empty for anything that is not a list", () => {
    expect(tripRows(undefined)).toEqual([]);
    expect(tripRows("Berlin")).toEqual([]);
  });
});

describe("tripOnDay", () => {
  it("finds the trip covering a day, inclusive of both ends", () => {
    expect(tripOnDay([BERLIN], "2026-09-01")?.city).toBe("Berlin");
    expect(tripOnDay([BERLIN], "2026-09-30")?.city).toBe("Berlin");
    expect(tripOnDay([BERLIN], "2026-10-01")).toBeUndefined();
  });
});

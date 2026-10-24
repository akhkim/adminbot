// The offline reverse geocoder over a tiny synthetic GeoNames extract. No network, no real dump.
import { describe, expect, it, vi } from "vitest";
import {
  centroidInTable,
  createGeoNamesGeocoder,
  nearestInTable,
  parseGeoNames,
} from "./reverse-geocode.js";

/** One cities1000.txt line: the 19 tab-separated GeoNames columns, only the ones read filled in. */
function row(
  name: string,
  lat: number,
  lon: number,
  country: string,
  admin1: string,
  population: number,
  featureCode = "PPL",
): string {
  const cols = Array.from({ length: 19 }, () => "");
  cols[0] = String(Math.round(Math.abs(lat * lon * 1000)));
  cols[1] = name;
  cols[2] = name.normalize("NFD").replace(/[̀-ͯ]/gu, "");
  cols[4] = String(lat);
  cols[5] = String(lon);
  cols[6] = "P";
  cols[7] = featureCode;
  cols[8] = country;
  cols[10] = admin1;
  cols[14] = String(population);
  return cols.join("\t");
}

const CITIES = [
  row("Reggio Emilia", 44.698, 10.631, "IT", "05", 140_000, "PPLA2"),
  // A village 8 km out: a fix next to it still says the city, which is the coarser answer.
  row("Cavriago", 44.693, 10.527, "IT", "05", 9_000),
  // A neighbourhood row (PPLX) right on the fix: never returned.
  row("Ospizio", 44.705, 10.655, "IT", "05", 20_000, "PPLX"),
  row("Rome", 41.892, 12.511, "IT", "07", 2_300_000, "PPLC"),
  // A village with no town near it keeps its own name.
  row("Lonelyvale", 46.5, 8.5, "CH", "VS", 400),
  // Two same-named places in different regions.
  row("Springfield", 39.8, -89.64, "US", "IL", 114_000),
  row("Springfield", 42.1, -72.59, "US", "MA", 155_000),
  "malformed line",
].join("\n");

const ADMIN1 = [
  "IT.05\tEmilia-Romagna\tEmilia-Romagna\t3177401",
  "IT.07\tLazio\tLazio\t3174976",
  "CH.VS\tValais\tValais\t2658205",
  "US.IL\tIllinois\tIllinois\t4896861",
  "US.MA\tMassachusetts\tMassachusetts\t6254926",
].join("\n");

const table = parseGeoNames(CITIES, ADMIN1);

describe("nearestInTable", () => {
  it("names the city around a fix, with its region and ISO country", () => {
    expect(nearestInTable(table, 44.7, 10.63)).toEqual({
      city: "Reggio Emilia",
      region: "Emilia-Romagna",
      country: "IT",
    });
    expect(nearestInTable(table, 41.9, 12.5)).toMatchObject({ city: "Rome", region: "Lazio" });
  });

  it("prefers a town within 15 km over a nearer village, and never a neighbourhood", () => {
    expect(nearestInTable(table, 44.694, 10.53)?.city).toBe("Reggio Emilia");
    expect(nearestInTable(table, 44.705, 10.655)?.city).toBe("Reggio Emilia");
  });

  it("keeps a village when no town is near, and nothing past 30 km", () => {
    expect(nearestInTable(table, 46.51, 8.51)?.city).toBe("Lonelyvale");
    expect(nearestInTable(table, 0, -30)).toBeUndefined();
  });

  it("rejects positions that are not on the globe", () => {
    expect(nearestInTable(table, Number.NaN, 10)).toBeUndefined();
    expect(nearestInTable(table, 95, 10)).toBeUndefined();
    expect(nearestInTable(table, 44, 190)).toBeUndefined();
  });
});

describe("centroidInTable", () => {
  it("finds a city's centroid by name and country, the region breaking a tie", () => {
    expect(centroidInTable(table, "reggio emilia", undefined, "it")).toMatchObject({
      label: "Reggio Emilia",
      country: "IT",
    });
    expect(centroidInTable(table, "Springfield", "Illinois", "US")?.lat).toBeCloseTo(39.8);
    // No region: the most populous.
    expect(centroidInTable(table, "Springfield", undefined, "US")?.lat).toBeCloseTo(42.1);
    expect(centroidInTable(table, "Springfield", undefined, undefined)).toBeUndefined();
  });
});

describe("createGeoNamesGeocoder", () => {
  it("reads the directory once, and warns once, server-side, when the files are missing", async () => {
    const warn = vi.fn();
    const geocoder = createGeoNamesGeocoder("/synthetic/geonames", {
      stat: async () => {
        throw new Error("ENOENT");
      },
      readFile: async () => "",
      warn,
    });
    expect(await geocoder.nearest(44.7, 10.63)).toBeUndefined();
    expect(await geocoder.nearest(44.7, 10.63)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).not.toMatch(/44\.7|10\.63/u);
    expect(geocoder.version()).toBe(0);
  });

  it("loads the table, reloads when the file changes, and keeps the last good one", async () => {
    let mtimeMs = 1;
    let cities = CITIES;
    const readFile = vi.fn(async (file: string) =>
      file.endsWith("cities1000.txt") ? cities : ADMIN1,
    );
    const warn = vi.fn();
    const geocoder = createGeoNamesGeocoder("/synthetic/geonames", {
      stat: async () => ({ mtimeMs, size: cities.length }),
      readFile,
      warn,
    });
    expect((await geocoder.nearest(44.7, 10.63))?.city).toBe("Reggio Emilia");
    expect(geocoder.version()).toBe(1);
    expect(geocoder.centroid("Rome", undefined, "IT")?.label).toBe("Rome");
    expect(readFile).toHaveBeenCalledTimes(2);
    await geocoder.nearest(41.9, 12.5);
    expect(readFile).toHaveBeenCalledTimes(2);

    // A truncated download: the old table stays.
    mtimeMs = 2;
    cities = "";
    expect((await geocoder.nearest(44.7, 10.63))?.city).toBe("Reggio Emilia");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(geocoder.version()).toBe(1);
  });
});

// Turns a browser's position into a city name, on this host, from GeoNames "cities1000"
// (https://download.geonames.org/export/dump/, CC BY 4.0) -- for the profile's passive
// "Use my precise location" control and its silent refresh.
//
// Offline on purpose: a member's coordinates never leave the process that received them, and never
// reach a store, a log or an audit row. They are reduced to the nearest populated place here and
// dropped; only the city, its first-level region and the ISO country code survive the call.
//
// The same table answers the reverse question for the member map: where to draw a city the map's
// own gazetteer does not know ("Reggio Emilia"). That is the city's centroid from GeoNames, never
// anybody's position.
//
// Files, from ADMINBOT_GEONAMES_DIR (installed by deploy/aurora/install-geonames.sh, refreshed by
// scripts/adminbot-geonames-refresh.sh):
//   cities1000.txt        tab-separated, one populated place per line (population >= 1000)
//   admin1CodesASCII.txt  "IT.05<TAB>Emilia-Romagna<TAB>..." -- first-level region names
// Loaded once, reloaded when cities1000.txt's mtime or size changes, like the .mmdb provider.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Where a position is, at the grain the system is allowed to keep. Never coordinates. */
export type ReverseGeocodedPlace = {
  city: string;
  /** First-level subdivision ("Emilia-Romagna", "Ontario"), when GeoNames names one. */
  region?: string;
  /** ISO 3166-1 alpha-2, the same form the IP providers report. */
  country: string;
};

/** A city's centroid, for drawing it on the map. */
export type CityCentroid = { label: string; country: string; lat: number; lon: number };

export type ReverseGeocoder = {
  /**
   * The populated place nearest the position, within NEAREST_MAX_KM; undefined when the table is
   * not loaded, the position is invalid, or nothing is that close (open sea, a polar station).
   */
  nearest(lat: number, lon: number): Promise<ReverseGeocodedPlace | undefined>;
  /**
   * The centroid of a named city in a country (ISO code), preferring one in `region` and then the
   * most populous namesake. Synchronous over whatever is loaded; undefined before the first load.
   */
  centroid(city: string, region?: string, country?: string): CityCentroid | undefined;
  /** Changes whenever a different table is loaded, so a cached map built without it is rebuilt. */
  version(): number;
};

export const GEONAMES_ATTRIBUTION = { text: "Places by GeoNames", url: "https://www.geonames.org" };

/**
 * How far the nearest place may be. A browser fix without high accuracy is a Wi-Fi or cell
 * estimate, good to a few hundred metres in a city and a few kilometres outside one; 30 km is
 * generous for that and still refuses to name a city for somebody on a ferry.
 */
export const NEAREST_MAX_KM = 30;

/**
 * Below this population a place is a village or a suburb. The nearest town of at least this size
 * within TOWN_RADIUS_KM is preferred over it, so a fix in a city's outskirts says the city rather
 * than the hamlet -- coarser, which is the point -- and a member who lives in a village still gets
 * the village when no town is near.
 */
const TOWN_POPULATION = 15_000;
const TOWN_RADIUS_KM = 15;

// Feature codes that are not somewhere a person is: abandoned, historical, destroyed or a section
// of another populated place (a neighbourhood, which would say more than the city does).
const EXCLUDED_FEATURES = new Set(["PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH"]);

const EARTH_RADIUS_KM = 6371;

type Row = {
  name: string;
  lat: number;
  lon: number;
  country: string;
  admin1: string;
  population: number;
};

export type GeoNamesTable = {
  rows: Row[];
  /** 1-degree cells, "lat|lon" of the floor, to the rows inside. */
  grid: Map<string, Row[]>;
  /** folded name + "|" + country, to rows with that name, most populous first. */
  byName: Map<string, Row[]>;
  /** "CC.code" to the region's name. */
  regions: Map<string, string>;
};

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function cellKey(lat: number, lon: number): string {
  return `${Math.floor(lat)}|${Math.floor(lon)}`;
}

function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Parses the two GeoNames dumps. Malformed lines are skipped, not fatal. Exported for tests. */
export function parseGeoNames(citiesText: string, admin1Text = ""): GeoNamesTable {
  const regions = new Map<string, string>();
  for (const line of admin1Text.split("\n")) {
    const [code, name] = line.split("\t");
    if (code?.includes(".") && name?.trim()) {
      regions.set(code.trim(), name.trim());
    }
  }
  const rows: Row[] = [];
  const grid = new Map<string, Row[]>();
  const byName = new Map<string, Row[]>();
  for (const line of citiesText.split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 15) {
      continue;
    }
    const lat = Number(cols[4]);
    const lon = Number(cols[5]);
    const featureClass = cols[6];
    const featureCode = cols[7] ?? "";
    const country = cols[8]?.trim().toUpperCase() ?? "";
    const name = cols[1]?.trim() ?? "";
    if (
      !name ||
      country.length !== 2 ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      featureClass !== "P" ||
      EXCLUDED_FEATURES.has(featureCode)
    ) {
      continue;
    }
    const row: Row = {
      name,
      lat,
      lon,
      country,
      admin1: cols[10]?.trim() ?? "",
      population: Number(cols[14]) || 0,
    };
    rows.push(row);
    const cell = cellKey(lat, lon);
    const inCell = grid.get(cell);
    if (inCell) {
      inCell.push(row);
    } else {
      grid.set(cell, [row]);
    }
    // Indexed by the display name and the ASCII name, so "Zürich" and "Zurich" both find it.
    for (const alias of new Set([fold(name), fold(cols[2] ?? "")])) {
      if (!alias) {
        continue;
      }
      const key = `${alias}|${country}`;
      const named = byName.get(key);
      if (named) {
        named.push(row);
      } else {
        byName.set(key, [row]);
      }
    }
  }
  for (const named of byName.values()) {
    named.sort((left, right) => right.population - left.population);
  }
  return { rows, grid, byName, regions };
}

/** The nearest place in a parsed table, by the rules above. Pure; exported for tests. */
export function nearestInTable(
  table: GeoNamesTable,
  lat: number,
  lon: number,
): ReverseGeocodedPlace | undefined {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return undefined;
  }
  // The 3x3 cells around the position hold everything within ~55 km of it at any latitude a
  // person lives at; NEAREST_MAX_KM is well inside that.
  let nearest: { row: Row; km: number } | undefined;
  let town: { row: Row; km: number } | undefined;
  for (let dLat = -1; dLat <= 1; dLat += 1) {
    for (let dLon = -1; dLon <= 1; dLon += 1) {
      const wrapped = ((Math.floor(lon) + dLon + 180 + 360) % 360) - 180;
      for (const row of table.grid.get(`${Math.floor(lat) + dLat}|${wrapped}`) ?? []) {
        const km = distanceKm(lat, lon, row.lat, row.lon);
        if (km > NEAREST_MAX_KM) {
          continue;
        }
        if (!nearest || km < nearest.km) {
          nearest = { row, km };
        }
        if (row.population >= TOWN_POPULATION && km <= TOWN_RADIUS_KM && (!town || km < town.km)) {
          town = { row, km };
        }
      }
    }
  }
  const chosen =
    nearest && nearest.row.population < TOWN_POPULATION && town ? town.row : nearest?.row;
  if (!chosen) {
    return undefined;
  }
  const region = table.regions.get(`${chosen.country}.${chosen.admin1}`);
  return { city: chosen.name, ...(region ? { region } : {}), country: chosen.country };
}

/** The centroid lookup over a parsed table. Pure; exported for tests. */
export function centroidInTable(
  table: GeoNamesTable,
  city: string,
  region: string | undefined,
  country: string | undefined,
): CityCentroid | undefined {
  const code = country?.trim().toUpperCase();
  const name = fold(city);
  if (!name || !code || code.length !== 2) {
    return undefined;
  }
  const named = table.byName.get(`${name}|${code}`);
  if (!named?.length) {
    return undefined;
  }
  const wantedRegion = region ? fold(region) : undefined;
  const inRegion = wantedRegion
    ? named.find((row) => {
        const regionName = table.regions.get(`${row.country}.${row.admin1}`);
        return regionName !== undefined && fold(regionName) === wantedRegion;
      })
    : undefined;
  const row = inRegion ?? named[0]!;
  return { label: row.name, country: row.country, lat: row.lat, lon: row.lon };
}

export type GeoNamesGeocoderDeps = {
  stat?: (file: string) => Promise<{ mtimeMs: number; size: number }>;
  readFile?: (file: string) => Promise<string>;
  /** Server-side only: a member never sees a reverse-geocoding failure. */
  warn?: (message: string) => void;
};

/**
 * The geocoder over a GeoNames directory. Starts loading at once, so the map's centroid lookups
 * work soon after startup without waiting for somebody to share a position.
 */
export function createGeoNamesGeocoder(
  dir: string,
  deps: GeoNamesGeocoderDeps = {},
): ReverseGeocoder {
  const citiesPath = path.join(dir, "cities1000.txt");
  const admin1Path = path.join(dir, "admin1CodesASCII.txt");
  const statFile = deps.stat ?? stat;
  const read = deps.readFile ?? ((file: string) => readFile(file, "utf8"));
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  let loaded: { mtimeMs: number; size: number; table: GeoNamesTable } | undefined;
  let generation = 0;
  let inflight: Promise<GeoNamesTable | undefined> | undefined;
  let warnedFor: string | undefined;

  async function load(): Promise<GeoNamesTable | undefined> {
    try {
      const info = await statFile(citiesPath);
      if (!loaded || loaded.mtimeMs !== info.mtimeMs || loaded.size !== info.size) {
        const [cities, admin1] = await Promise.all([
          read(citiesPath),
          read(admin1Path).catch(() => ""),
        ]);
        const table = parseGeoNames(cities, admin1);
        if (table.rows.length === 0) {
          throw new Error("no populated places in cities1000.txt");
        }
        loaded = { mtimeMs: info.mtimeMs, size: info.size, table };
        generation += 1;
        warnedFor = undefined;
      }
      return loaded.table;
    } catch (error) {
      // A missing or corrupt file must never fail a request. Keep the last good table, and say so
      // once in the server log rather than per request.
      const message = `AdminBot GeoNames: cannot read ${citiesPath}: ${error instanceof Error ? error.message : String(error)}`;
      if (warnedFor !== message) {
        warnedFor = message;
        warn(message);
      }
      return loaded?.table;
    }
  }

  function current(): Promise<GeoNamesTable | undefined> {
    inflight ??= load().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  void current();

  return {
    async nearest(lat, lon) {
      const table = await current();
      return table ? nearestInTable(table, lat, lon) : undefined;
    },
    centroid(city, region, country) {
      return loaded ? centroidInTable(loaded.table, city, region, country) : undefined;
    },
    version: () => generation,
  };
}

/** A geocoder over an already-parsed table, for tests and fixtures. */
export function geocoderFromTable(table: GeoNamesTable): ReverseGeocoder {
  return {
    nearest: async (lat, lon) => nearestInTable(table, lat, lon),
    centroid: (city, region, country) => centroidInTable(table, city, region, country),
    version: () => 1,
  };
}

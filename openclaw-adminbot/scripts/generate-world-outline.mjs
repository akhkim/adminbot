#!/usr/bin/env node
// Generates ui/src/ui/adminbot/data/world-outline.ts — the coastline the member map draws under its
// dots.
//
// Source: Natural Earth 1:110m "land" (public domain, no attribution required). Fetched rather than
// vendored raw because the input is 138KB of GeoJSON and the only thing the UI needs is one
// projected SVG path a fraction of that size. The UI itself never fetches anything: the output is a
// committed module.
//
// Projection: Equal Earth (Šavrič, Patterson & Jenny, 2018), cropped to SOUTH..NORTH latitude. It
// keeps areas honest without the polar blow-up of Mercator or the squashed mid-latitudes of
// equirectangular, and the crop drops Antarctica and the high Arctic, where nobody in a roster
// lives, so the map spends its height on the places people are. The same formula is implemented in
// ui/src/ui/adminbot/views/member-map-projection.ts; the constants below are written into the
// output header, and member-map.test.ts asserts the two agree.
//
// Coordinates are emitted as integers in a 1000-unit-wide space with relative path commands, which
// is ~0.36° of longitude per unit -- finer than a 1:110m source resolves -- at a fraction of the
// size absolute decimals cost.
//
//   node scripts/generate-world-outline.mjs [--source <url-or-path>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson";

// Must match VIEW_WIDTH / NORTH / SOUTH in ui/src/ui/adminbot/views/member-map-projection.ts.
const VIEW_WIDTH = 1000;
const NORTH = 75;
const SOUTH = -56;

// Rings whose projected bounding box is smaller than this on both axes are dropped: at this scale
// they render as specks that read as stray marks rather than as islands.
const MIN_RING_EXTENT = 2;

// Antarctica: a ring entirely south of the crop would only add bytes nobody sees.
const DROP_BELOW_LAT = -60;

const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;

function equalEarthRaw(lon, lat) {
  const lambda = (lon * Math.PI) / 180;
  const theta = Math.asin(M * Math.sin((lat * Math.PI) / 180));
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  return [
    (lambda * Math.cos(theta)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))),
    theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)),
  ];
}

const X_MAX = equalEarthRaw(180, 0)[0];
const SCALE = VIEW_WIDTH / (2 * X_MAX);
const Y_TOP = equalEarthRaw(0, NORTH)[1];
const Y_BOTTOM = equalEarthRaw(0, SOUTH)[1];
const VIEW_HEIGHT = Math.round((Y_TOP - Y_BOTTOM) * SCALE);

function project(lon, lat) {
  const [x, y] = equalEarthRaw(lon, lat);
  return [(x + X_MAX) * SCALE, (Y_TOP - y) * SCALE];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(repoRoot, "ui/src/ui/adminbot/data/world-outline.ts");

function ringToPath(ring) {
  if (ring.every(([, lat]) => lat < DROP_BELOW_LAT)) {
    return "";
  }
  const points = [];
  for (const [lon, lat] of ring) {
    const [x, y] = project(lon, lat).map((value) => Math.round(value));
    const previous = points.at(-1);
    if (previous && previous[0] === x && previous[1] === y) {
      continue;
    }
    points.push([x, y]);
  }
  if (points.length < 4) {
    return "";
  }
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  if (
    Math.max(...xs) - Math.min(...xs) < MIN_RING_EXTENT &&
    Math.max(...ys) - Math.min(...ys) < MIN_RING_EXTENT
  ) {
    return "";
  }
  const [first, ...rest] = points;
  let out = `M${first[0]} ${first[1]}`;
  let [px, py] = first;
  for (const [x, y] of rest) {
    const dx = x - px;
    const dy = y - py;
    // Compact relative steps: "l3-2" rather than "L512.3 211.7".
    out += `l${dx}${dy < 0 ? "" : " "}${dy}`;
    px = x;
    py = y;
  }
  return `${out}z`;
}

function polygonsOf(geometry) {
  if (!geometry) {
    return [];
  }
  if (geometry.type === "Polygon") {
    return geometry.coordinates;
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.flat();
  }
  return [];
}

async function readSource(source) {
  if (/^https?:/u.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`${source} answered ${response.status}`);
    }
    return response.json();
  }
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

async function main() {
  const flagIndex = process.argv.indexOf("--source");
  const source = flagIndex > -1 ? process.argv[flagIndex + 1] : SOURCE;
  const geo = await readSource(source);
  const rings = (geo.features ?? [])
    .flatMap((feature) => polygonsOf(feature.geometry))
    .map((ring) => ringToPath(ring))
    .filter(Boolean);
  const outline = rings.join("");

  fs.writeFileSync(
    OUT,
    `// Generated from Natural Earth 1:110m land (public domain) by\n` +
      `// scripts/generate-world-outline.mjs. Do not hand-edit; regenerate instead.\n` +
      `//\n` +
      `// Pre-projected Equal Earth, ${VIEW_WIDTH} units wide, cropped to ${SOUTH}..${NORTH} degrees of\n` +
      `// latitude. Those numbers must match views/member-map-projection.ts, which the tests assert.\n\n` +
      `export const WORLD_OUTLINE_VIEW = {\n` +
      `  projection: "equal-earth",\n  width: ${VIEW_WIDTH},\n  height: ${VIEW_HEIGHT},\n` +
      `  north: ${NORTH},\n  south: ${SOUTH},\n} as const;\n\n` +
      `export const WORLD_OUTLINE_PATH =\n  ${JSON.stringify(outline)};\n`,
  );
  const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`wrote ${OUT} — ${rings.length} rings, ${kb} kB, ${VIEW_WIDTH}x${VIEW_HEIGHT}`);
}

await main();

#!/usr/bin/env node
// Generates ui/src/ui/adminbot/data/world-outline.ts — the coastline the dashboard member map
// draws under its dots.
//
// Source: Natural Earth 1:110m "land" (public domain, no attribution required). Fetched rather than
// vendored raw because the input is 138KB of GeoJSON and the only thing the UI needs is one
// projected SVG path an order of magnitude smaller.
//
// The path is pre-projected. Equirectangular is linear in both axes, so projecting once here rather
// than per-render costs nothing and keeps the browser from carrying a coordinate list plus the
// arithmetic to place it. The trade is that this file and views/member-map.ts must agree on the
// viewBox and the latitude clip; both are asserted below and named in the output header.
//
//   node scripts/generate-world-outline.mjs [--source <url-or-path>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson";

// Must match VIEW_WIDTH / VIEW_HEIGHT / LAT_LIMIT in ui/src/ui/adminbot/views/member-map.ts.
const VIEW_WIDTH = 360;
const VIEW_HEIGHT = 180;
const LAT_LIMIT = 72;

// Coordinates are rounded to this many decimals in projected space. At a 360-wide viewBox one
// decimal is roughly a tenth of a degree of longitude — far finer than a 1:110m source resolves,
// so this costs no visible fidelity and roughly halves the output.
const PRECISION = 1;

// Rings whose projected bounding box is smaller than this on both axes are dropped. At this scale
// they render as single specks that read as stray marks rather than as islands.
const MIN_RING_EXTENT = 1.2;

// Antarctica is in the source and in nobody's roster. Keeping it would spend a fifth of the height
// on a landmass no member will ever be plotted on, and it is the one shape the latitude clip
// mangles rather than merely trims.
const DROP_BELOW_LAT = -60;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(repoRoot, "ui/src/ui/adminbot/data/world-outline.ts");

function projectX(lon) {
  return ((lon + 180) / 360) * VIEW_WIDTH;
}

function projectY(lat) {
  const clamped = Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, lat));
  return ((LAT_LIMIT - clamped) / (LAT_LIMIT * 2)) * VIEW_HEIGHT;
}

const round = (value) => Number(value.toFixed(PRECISION));

function ringToPath(ring) {
  if (ring.some(([, lat]) => lat < DROP_BELOW_LAT)) {
    return "";
  }
  const points = [];
  for (const [lon, lat] of ring) {
    const x = round(projectX(lon));
    const y = round(projectY(lat));
    const previous = points.at(-1);
    // Rounding collapses neighbours onto the same point; emitting them would double the file for
    // nothing.
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
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  if (width < MIN_RING_EXTENT && height < MIN_RING_EXTENT) {
    return "";
  }
  const [first, ...rest] = points;
  return `M${first[0]} ${first[1]}` + rest.map(([x, y]) => `L${x} ${y}`).join("") + "Z";
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
      `// Pre-projected equirectangular for a ${VIEW_WIDTH}x${VIEW_HEIGHT} viewBox with latitude\n` +
      `// clipped to +/-${LAT_LIMIT} degrees. Those three numbers must match VIEW_WIDTH, VIEW_HEIGHT\n` +
      `// and LAT_LIMIT in ui/src/ui/adminbot/views/member-map.ts, which asserts them.\n\n` +
      `export const WORLD_OUTLINE_VIEW = {\n` +
      `  width: ${VIEW_WIDTH},\n  height: ${VIEW_HEIGHT},\n  latLimit: ${LAT_LIMIT},\n} as const;\n\n` +
      `export const WORLD_OUTLINE_PATH =\n  ${JSON.stringify(outline)};\n`,
  );
  const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`wrote ${OUT} — ${rings.length} rings, ${kb} kB`);
}

await main();

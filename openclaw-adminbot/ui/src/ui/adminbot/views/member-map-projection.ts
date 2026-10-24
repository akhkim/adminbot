// The member map's projection, and the viewport arithmetic that zooms and pans it.
//
// Equal Earth (Šavrič, Patterson & Jenny, 2018), cropped to SOUTH..NORTH latitude: areas stay
// honest, the poles do not balloon the way Mercator's do, and dropping Antarctica and the high
// Arctic leaves a map about 2.4:1 that fills a card's width instead of floating in it.
//
// data/world-outline.ts is the coastline pre-projected by scripts/generate-world-outline.mjs with
// the same formula and these same constants; the tests assert they agree, since a mismatch would
// slide every dot off the coast it belongs on. The constants are restated here rather than
// imported so the coastline chunk stays out of the console's first load.

export const VIEW_WIDTH = 1000;
export const NORTH = 75;
export const SOUTH = -56;

const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;

function equalEarthRaw(lon: number, lat: number): [number, number] {
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

export const VIEW_HEIGHT = Math.round((Y_TOP - Y_BOTTOM) * SCALE);

/** Longitude/latitude to map units (0..VIEW_WIDTH, 0..VIEW_HEIGHT; y grows southward). */
export function project(lon: number, lat: number): { x: number; y: number } {
  const [x, y] = equalEarthRaw(lon, lat);
  return { x: (x + X_MAX) * SCALE, y: (Y_TOP - y) * SCALE };
}

/**
 * Where the map sits in its box: map units times `k` plus (`x`, `y`) gives CSS pixels. `k` already
 * includes the fit, so zoom level is `k / fit(...).k`.
 */
export type Viewport = { k: number; x: number; y: number };

export type Size = { width: number; height: number };

export const MAX_ZOOM = 16;

/** The whole map, as large as fits, centred: the reset view. */
export function fitViewport(size: Size): Viewport {
  const k = Math.min(size.width / VIEW_WIDTH, size.height / VIEW_HEIGHT);
  return {
    k,
    x: (size.width - VIEW_WIDTH * k) / 2,
    y: (size.height - VIEW_HEIGHT * k) / 2,
  };
}

/**
 * Keeps the zoom within [fit, fit × MAX_ZOOM] and the map covering the box: once zoomed in there
 * is no panning off into empty space, and at the fit it stays centred.
 */
export function clampViewport(view: Viewport, size: Size): Viewport {
  const base = fitViewport(size);
  const k = Math.min(Math.max(view.k, base.k), base.k * MAX_ZOOM);
  const clampAxis = (offset: number, content: number, box: number) =>
    content <= box ? (box - content) / 2 : Math.min(0, Math.max(box - content, offset));
  return {
    k,
    x: clampAxis(view.x, VIEW_WIDTH * k, size.width),
    y: clampAxis(view.y, VIEW_HEIGHT * k, size.height),
  };
}

/** Zoom by `factor` keeping the map point under (`px`, `py`) where it is. */
export function zoomAt(view: Viewport, factor: number, px: number, py: number, size: Size) {
  const k = view.k * factor;
  return clampViewport(
    { k, x: px - ((px - view.x) / view.k) * k, y: py - ((py - view.y) / view.k) * k },
    size,
  );
}

/**
 * The view that shows map-unit box [x0..x1] × [y0..y1] with `pad` pixels to spare on every side,
 * capped at MAX_ZOOM. Used to open a cluster: zoom until its members have room to separate.
 */
export function viewportForBounds(
  bounds: { x0: number; y0: number; x1: number; y1: number },
  size: Size,
  pad: number,
): Viewport {
  const width = Math.max(bounds.x1 - bounds.x0, 1e-6);
  const height = Math.max(bounds.y1 - bounds.y0, 1e-6);
  // Capped here, not left to clampViewport: the offsets below centre the box at this k, and
  // clamping k afterwards would keep offsets meant for a far deeper zoom and fling the box off screen.
  const k = Math.min(
    (size.width - pad * 2) / width,
    (size.height - pad * 2) / height,
    fitViewport(size).k * MAX_ZOOM,
  );
  const cx = (bounds.x0 + bounds.x1) / 2;
  const cy = (bounds.y0 + bounds.y1) / 2;
  return clampViewport({ k, x: size.width / 2 - cx * k, y: size.height / 2 - cy * k }, size);
}

/** Interpolates between two views for an animated zoom. */
export function lerpViewport(from: Viewport, to: Viewport, t: number, size: Size): Viewport {
  // Scale moves geometrically so the zoom speed is even -- each doubling takes as long as the last
  // -- and the map point at the centre of the box travels in a straight line.
  const k = from.k * Math.pow(to.k / from.k, t);
  const cx = size.width / 2;
  const cy = size.height / 2;
  const fromX = (cx - from.x) / from.k;
  const fromY = (cy - from.y) / from.k;
  const toX = (cx - to.x) / to.k;
  const toY = (cy - to.y) / to.k;
  const mx = fromX + (toX - fromX) * t;
  const my = fromY + (toY - fromY) * t;
  return { k, x: cx - mx * k, y: cy - my * k };
}

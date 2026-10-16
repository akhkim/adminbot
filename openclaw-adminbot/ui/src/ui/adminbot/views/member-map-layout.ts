// What the member map draws at the current scale: which cities merge into a cluster, how big each
// marker is, and which labels fit.
//
// Everything here is in screen pixels, recomputed whenever the box resizes or the view zooms. That
// is the point: at world scale Zürich, Tübingen and Darmstadt are a few pixels apart and have to be
// one marker, while zoomed into central Europe they are a hand's width apart and each gets its own.
// A clustering done once in map units would be wrong at every scale but one.
//
// Pure functions, no DOM, so the guarantees -- no two markers overlap, the biggest places are
// labelled first, the same input gives the same output -- are unit-tested directly.

export type MapPoint = {
  key: string;
  label: string;
  count: number;
  /** Screen position, CSS pixels. */
  x: number;
  y: number;
};

export type Cluster = {
  /** Stable for a given membership: the lead place's key alone, or every member key joined. */
  key: string;
  /** Member place keys, biggest first. */
  keys: string[];
  /** The biggest place in it, which names it. */
  lead: string;
  count: number;
  x: number;
  y: number;
  r: number;
};

export type RadiusScale = {
  /** Radius of a one-person place. */
  min: number;
  /** Radius of the busiest single place. */
  max: number;
  /** The busiest single place's headcount: it gets `max`. */
  reference: number;
  /** Smallest radius for a merged marker, so its count fits inside. */
  clusterMin: number;
};

/**
 * Area-proportional radius: the disc's area, not its width, is what the eye compares, so radius
 * goes with the square root of the headcount. Floored so a single person is still a visible dot, and
 * a cluster may run a little past the busiest city before it is capped, so "Europe" can still read
 * bigger than "Zürich" without swallowing the map.
 */
export function radiusFor(count: number, scale: RadiusScale, merged = false): number {
  const reference = Math.max(scale.reference, 1);
  const raw = scale.max * Math.sqrt(Math.max(count, 1) / reference);
  const floor = merged ? Math.max(scale.min, scale.clusterMin) : scale.min;
  return Math.min(Math.max(raw, floor), scale.max * 1.2);
}

export type ClusterOptions = {
  scale: RadiusScale;
  /** Clear space kept between two markers' edges. */
  gap: number;
  /**
   * Centres closer than this merge whatever their size. On a touch screen this is the tap target,
   * so two neighbouring markers can never share a fingertip.
   */
  minSeparation: number;
};

type Working = {
  keys: string[];
  count: number;
  sx: number;
  sy: number;
  x: number;
  y: number;
  r: number;
};

function byWeight(left: Working, right: Working): number {
  return right.count - left.count || (left.keys[0]! < right.keys[0]! ? -1 : 1);
}

function separation(left: Working, right: Working, options: ClusterOptions): number {
  return Math.max(left.r + right.r + options.gap, options.minSeparation);
}

/**
 * Merges markers that would overlap until none do.
 *
 * Greedy by size: the busiest marker absorbs whatever crowds it, then the next busiest, and the
 * pass repeats because a merged marker is larger and sits at its members' weighted centre, which can
 * bring it into a neighbour's way. Every merge removes a marker, so this ends; when it does, every
 * pair is at least `separation` apart. A merged marker sits at the headcount-weighted centre of its
 * places, so a cluster of Toronto (29) and Montréal (3) stays almost on Toronto.
 */
export function clusterPoints(points: readonly MapPoint[], options: ClusterOptions): Cluster[] {
  const labels = new Map(points.map((point) => [point.key, point]));
  let working: Working[] = points
    .map((point) => ({
      keys: [point.key],
      count: point.count,
      sx: point.x * point.count,
      sy: point.y * point.count,
      x: point.x,
      y: point.y,
      r: radiusFor(point.count, options.scale),
    }))
    .toSorted(byWeight);
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < working.length && !merged; i++) {
      const head = working[i]!;
      for (let j = i + 1; j < working.length; j++) {
        const other = working[j]!;
        if (Math.hypot(head.x - other.x, head.y - other.y) >= separation(head, other, options)) {
          continue;
        }
        const count = head.count + other.count;
        const sx = head.sx + other.sx;
        const sy = head.sy + other.sy;
        const keys = [...head.keys, ...other.keys];
        working[i] = {
          keys,
          count,
          sx,
          sy,
          x: sx / count,
          y: sy / count,
          r: radiusFor(count, options.scale, true),
        };
        working.splice(j, 1);
        merged = true;
        break;
      }
    }
    if (merged) {
      working = working.toSorted(byWeight);
    }
  }
  return working.map((entry) => {
    const keys = entry.keys.toSorted((left, right) => {
      const a = labels.get(left)!;
      const b = labels.get(right)!;
      return b.count - a.count || (left < right ? -1 : 1);
    });
    return {
      key: keys.length === 1 ? keys[0]! : `cluster:${keys.toSorted().join("|")}`,
      keys,
      lead: keys[0]!,
      count: entry.count,
      x: entry.x,
      y: entry.y,
      r: entry.r,
    };
  });
}

// --- Labels ---

export type LabelAnchor = "start" | "middle" | "end";

export type LabelBox = { x0: number; y0: number; x1: number; y1: number };

export type PlacedLabel = { x: number; y: number; anchor: LabelAnchor; box: LabelBox };

export type LabelInput = { key: string; text: string; x: number; y: number; r: number };

// Text is not measured: getBBox() and measureText() need layout or a canvas, which a dialog that is
// not open and the test DOM both lack, and measuring would make the layout depend on which fonts
// loaded. An average advance a little wider than the label font's real one stands in --
// overestimating only costs a label that would have fitted; underestimating is an overlap.
const CHAR_WIDTH_EM = 0.62;
const LINE_EM = 1.25;
// Clear space between a marker's edge and its label, and around each label.
const LABEL_GAP = 4;
const LABEL_PAD = 2;

export function labelBox(
  text: string,
  x: number,
  y: number,
  anchor: LabelAnchor,
  fontSize: number,
): LabelBox {
  const width = [...text].length * CHAR_WIDTH_EM * fontSize;
  const height = LINE_EM * fontSize;
  const x0 = anchor === "start" ? x : anchor === "middle" ? x - width / 2 : x - width;
  // (x, y) is the vertical centre of the line, not a baseline: HTML labels centre on it.
  return {
    x0: x0 - LABEL_PAD,
    y0: y - height / 2 - LABEL_PAD,
    x1: x0 + width + LABEL_PAD,
    y1: y + height / 2 + LABEL_PAD,
  };
}

export function boxesIntersect(left: LabelBox, right: LabelBox): boolean {
  return left.x0 < right.x1 && right.x0 < left.x1 && left.y0 < right.y1 && right.y0 < left.y1;
}

function circleHitsBox(cx: number, cy: number, r: number, box: LabelBox): boolean {
  const nx = Math.max(box.x0, Math.min(cx, box.x1));
  const ny = Math.max(box.y0, Math.min(cy, box.y1));
  return Math.hypot(cx - nx, cy - ny) < r;
}

function candidates(input: LabelInput, fontSize: number): Array<Omit<PlacedLabel, "box">> {
  const reach = input.r + LABEL_GAP;
  const vertical = input.r + LABEL_GAP + (LINE_EM * fontSize) / 2;
  // Right first, the cartographic default, then left, above and below.
  return [
    { x: input.x + reach, y: input.y, anchor: "start" },
    { x: input.x - reach, y: input.y, anchor: "end" },
    { x: input.x, y: input.y - vertical, anchor: "middle" },
    { x: input.x, y: input.y + vertical, anchor: "middle" },
  ];
}

/**
 * Places labels in the order given -- pass the busiest first -- each at the first of right, left,
 * above and below that is inside the box and clear of every marker and every label already placed.
 * A label with nowhere to go is left out; the marker's tooltip and the list both still name it.
 */
export function layoutLabels(
  inputs: readonly LabelInput[],
  options: { fontSize: number; width: number; height: number; budget?: number },
): Map<string, PlacedLabel> {
  const placed = new Map<string, PlacedLabel>();
  const budget = options.budget ?? Number.POSITIVE_INFINITY;
  for (const input of inputs) {
    if (placed.size >= budget) {
      break;
    }
    for (const spot of candidates(input, options.fontSize)) {
      const box = labelBox(input.text, spot.x, spot.y, spot.anchor, options.fontSize);
      const clear =
        box.x0 >= 0 &&
        box.y0 >= 0 &&
        box.x1 <= options.width &&
        box.y1 <= options.height &&
        [...placed.values()].every((other) => !boxesIntersect(box, other.box)) &&
        // Its own marker is clear by construction; testing it would let rounding at the shared
        // edge (the box starts exactly LABEL_PAD past the rim) reject the label.
        inputs.every(
          (marker) =>
            marker === input || !circleHitsBox(marker.x, marker.y, marker.r + LABEL_PAD, box),
        );
      if (clear) {
        placed.set(input.key, { ...spot, box });
        break;
      }
    }
  }
  return placed;
}

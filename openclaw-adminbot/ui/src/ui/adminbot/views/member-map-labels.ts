// Where the member map's city labels go, so that no two of them overlap.
//
// Europe is the problem: Berlin, London, Paris and Zürich sit within a dozen viewBox units of each
// other, and at any font size a label wider than that lands on its neighbour. Shrinking the font
// only moves the threshold, so this places labels instead: busiest place first, each one tried
// above, right, left and below its dot, and kept at the first spot that is clear of every label
// already placed and of every other dot. A label with no clear spot is not drawn on the plot; the
// view shows it on hover instead, and the list beside the plot names every city anyway.
//
// Text is not measured. getBBox() needs layout, which a dialog that is not open and the test DOM
// both lack, and measuring would make the layout depend on which fonts loaded. A per-character
// width a little wider than the label font's real average stands in: overestimating only costs a
// label that would have fitted, while underestimating is the overlap this exists to prevent.

export type LabelAnchor = "start" | "middle" | "end";

export type LabelBox = { x0: number; y0: number; x1: number; y1: number };

export type PlacedLabel = { x: number; y: number; anchor: LabelAnchor; box: LabelBox };

export type LabelPoint = { key: string; label: string; x: number; y: number; r: number };

// Average advance of a semibold sans character, in ems, rounded up.
const CHAR_WIDTH_EM = 0.62;
// Above and below the baseline, in ems: cap height plus the descenders of "g", "y", "p".
const ASCENT_EM = 0.78;
const DESCENT_EM = 0.24;
// Gap between a dot's halo and its label, in viewBox units.
const GAP = 1.5;
// The halo the view draws around each dot.
const HALO = 2;

/** The box a label covers, including the halo stroke drawn behind the text. */
export function labelBox(
  text: string,
  x: number,
  y: number,
  anchor: LabelAnchor,
  fontSize: number,
  strokeWidth = 0,
): LabelBox {
  const width = [...text].length * CHAR_WIDTH_EM * fontSize;
  const x0 = anchor === "start" ? x : anchor === "middle" ? x - width / 2 : x - width;
  const pad = strokeWidth / 2;
  return {
    x0: x0 - pad,
    y0: y - ASCENT_EM * fontSize - pad,
    x1: x0 + width + pad,
    y1: y + DESCENT_EM * fontSize + pad,
  };
}

export function boxesIntersect(left: LabelBox, right: LabelBox): boolean {
  return left.x0 < right.x1 && right.x0 < left.x1 && left.y0 < right.y1 && right.y0 < left.y1;
}

function candidates(point: LabelPoint, fontSize: number): Array<Omit<PlacedLabel, "box">> {
  const reach = point.r + HALO + GAP;
  // Vertically centred on the dot for the side positions: the baseline sits below the centre by
  // about a third of the cap height.
  const sideBaseline = point.y + fontSize * 0.3;
  return [
    { x: point.x, y: point.y - reach, anchor: "middle" },
    { x: point.x + reach, y: sideBaseline, anchor: "start" },
    { x: point.x - reach, y: sideBaseline, anchor: "end" },
    { x: point.x, y: point.y + reach + ASCENT_EM * fontSize, anchor: "middle" },
  ];
}

function inside(box: LabelBox, width: number, height: number): boolean {
  return box.x0 >= 0 && box.y0 >= 0 && box.x1 <= width && box.y1 <= height;
}

/**
 * Picks a spot for up to `budget` labels, in the order given (the busiest place first), and leaves
 * out any that cannot be placed without touching another label, another dot, or the plot's edge.
 */
export function layoutLabels(
  points: readonly LabelPoint[],
  options: { fontSize: number; strokeWidth: number; width: number; height: number; budget: number },
): Map<string, PlacedLabel> {
  const dots = points.map((point) => ({
    key: point.key,
    box: {
      x0: point.x - point.r - HALO,
      y0: point.y - point.r - HALO,
      x1: point.x + point.r + HALO,
      y1: point.y + point.r + HALO,
    },
  }));
  const placed = new Map<string, PlacedLabel>();
  for (const point of points) {
    if (placed.size >= options.budget) {
      break;
    }
    for (const spot of candidates(point, options.fontSize)) {
      const box = labelBox(
        point.label,
        spot.x,
        spot.y,
        spot.anchor,
        options.fontSize,
        options.strokeWidth,
      );
      const clear =
        inside(box, options.width, options.height) &&
        [...placed.values()].every((other) => !boxesIntersect(box, other.box)) &&
        dots.every((dot) => dot.key === point.key || !boxesIntersect(box, dot.box));
      if (clear) {
        placed.set(point.key, { ...spot, box });
        break;
      }
    }
  }
  return placed;
}

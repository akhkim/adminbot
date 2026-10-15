import {
  EMU_PER_INCH,
  EMU_PER_POINT,
  type SlidesAffineTransform,
  type SlidesDimension,
  type SlidesPage,
  type SlidesPageElement,
  type SlidesPresentation,
} from "../../contracts/google-slides.js";
import { normalizeSlideText, parseFaceObjectId, type WorkingGroupBox } from "./working-groups.js";

export type Rect = { x: number; y: number; w: number; h: number };

export type FlatElement = {
  element: SlidesPageElement;
  rect: Rect;
  /** Paint order across the whole slide, back to front, with groups expanded in place. */
  z: number;
  /** Inside an element group: its transform is relative to the group, so it is never moved. */
  grouped: boolean;
  /** Rotated or skewed: a bounding box no longer describes it, so it is never moved either. */
  sheared: boolean;
  /** The element's size before its transform, which a new scale is computed against. */
  intrinsic: { w: number; h: number };
  text: string;
};

// Inset of the area faces may occupy, from the box's edge and below its heading. Fixed rather than
// read off the faces, so where the grid may go never depends on where the faces already are --
// otherwise a run would move the goalposts for the next one and the sync would never settle.
export const CONTENT_INSET_EMU = Math.round(0.06 * EMU_PER_INCH);
export const TITLE_GAP_EMU = Math.round(0.04 * EMU_PER_INCH);
// When the heading is the box's own text there is no separate title shape to sit under.
export const HEADER_FALLBACK_EMU = Math.round(0.35 * EMU_PER_INCH);
export const DEFAULT_FACE_EMU = Math.round(0.55 * EMU_PER_INCH);
export const DEFAULT_GAP_EMU = Math.round(0.1 * EMU_PER_INCH);

// Photos are square; anything further from that is a logo, a banner or a screenshot.
const FACE_ASPECT_MIN = 0.8;
const FACE_ASPECT_MAX = 1.25;
const BOX_SHAPES = new Set(["ROUND_RECTANGLE", "RECTANGLE"]);

type Matrix = { a: number; b: number; c: number; d: number; tx: number; ty: number };

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function toEmu(dimension?: SlidesDimension): number {
  const magnitude = dimension?.magnitude ?? 0;
  return dimension?.unit === "PT" ? magnitude * EMU_PER_POINT : magnitude;
}

function toMatrix(transform?: SlidesAffineTransform): Matrix {
  const unit = transform?.unit === "PT" ? EMU_PER_POINT : 1;
  return {
    a: transform?.scaleX ?? 1,
    b: transform?.shearY ?? 0,
    c: transform?.shearX ?? 0,
    d: transform?.scaleY ?? 1,
    tx: (transform?.translateX ?? 0) * unit,
    ty: (transform?.translateY ?? 0) * unit,
  };
}

// A grouped element's transform is relative to its group, so its place on the page is the
// composition of every enclosing group's transform with its own.
function compose(parent: Matrix, child: Matrix): Matrix {
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    tx: parent.a * child.tx + parent.c * child.ty + parent.tx,
    ty: parent.b * child.tx + parent.d * child.ty + parent.ty,
  };
}

function boundingRect(matrix: Matrix, w: number, h: number): Rect {
  const corners = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ].map(([x, y]) => [
    matrix.a * x! + matrix.c * y! + matrix.tx,
    matrix.b * x! + matrix.d * y! + matrix.ty,
  ]);
  const xs = corners.map(([x]) => x!);
  const ys = corners.map(([, y]) => y!);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function elementText(element: SlidesPageElement): string {
  return (element.shape?.text?.textElements ?? [])
    .map((text) => text.textRun?.content ?? "")
    .join("");
}

export function flattenSlide(page: SlidesPage): FlatElement[] {
  const flat: FlatElement[] = [];
  const visit = (elements: readonly SlidesPageElement[], parent: Matrix, grouped: boolean) => {
    for (const element of elements) {
      const matrix = compose(parent, toMatrix(element.transform));
      if (element.elementGroup) {
        visit(element.elementGroup.children ?? [], matrix, true);
        continue;
      }
      const intrinsic = { w: toEmu(element.size?.width), h: toEmu(element.size?.height) };
      flat.push({
        element,
        rect: boundingRect(matrix, intrinsic.w, intrinsic.h),
        z: flat.length,
        grouped,
        sheared: Math.abs(matrix.b) > 1e-9 || Math.abs(matrix.c) > 1e-9,
        intrinsic,
        text: elementText(element),
      });
    }
  };
  visit(page.pageElements ?? [], IDENTITY, false);
  return flat;
}

function center(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

export function containsPoint(rect: Rect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h
  );
}

export function findSlideByTitle(
  presentation: SlidesPresentation,
  title: string,
): { ok: true; slide: SlidesPage } | { ok: false; reason: string } {
  const wanted = normalizeSlideText(title);
  const matches = (presentation.slides ?? []).filter((slide) =>
    flattenSlide(slide).some((element) => normalizeSlideText(element.text) === wanted),
  );
  if (matches.length !== 1) {
    // Two slides with the same heading is a duplicated slide mid-edit; picking one would be a coin
    // toss over which copy an admin is about to delete.
    return {
      ok: false,
      reason: `expected exactly one slide titled "${title}", found ${matches.length}`,
    };
  }
  return { ok: true, slide: matches[0]! };
}

export type MeasuredFace = {
  objectId: string;
  rect: Rect;
  intrinsic: { w: number; h: number };
  z: number;
  /** Alt text, which is how a face placed by hand can be tied to a member. */
  title?: string;
  description?: string;
  /** Set when the objectId is one this sync minted. */
  tag: { groupKey: string; hash: string } | null;
  movable: boolean;
  crop?: Record<string, number>;
};

export type FaceGridMetrics = {
  faceW: number;
  faceH: number;
  gapX: number;
  gapY: number;
  /** Faces in the widest row; 0 when the box is empty and nothing was measured. */
  columns: number;
  rows: number;
  align: "center" | "left";
  left: number;
  top: number;
  crop: Record<string, number> | null;
  zOrder: "above_box" | "below_box" | "mixed" | "none";
  measured: boolean;
};

export type MeasuredBox = {
  box: WorkingGroupBox;
  found: true;
  rect: Rect;
  boxObjectId: string;
  /** Where faces may go: the box minus the inset, below the heading. */
  content: Rect;
  faces: MeasuredFace[];
  metrics: FaceGridMetrics;
  /** A face spills out of the box or two faces overlap -- the "too many faces" symptom. */
  overflowing: boolean;
};

export type MissingBox = { box: WorkingGroupBox; found: false; reason: string };

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function isFaceShaped(rect: Rect): boolean {
  if (rect.w <= 0 || rect.h <= 0) {
    return false;
  }
  const aspect = rect.w / rect.h;
  return aspect >= FACE_ASPECT_MIN && aspect <= FACE_ASPECT_MAX;
}

/** Faces grouped into rows by vertical centre, top to bottom, each row left to right. */
export function faceRows<T extends { rect: Rect }>(faces: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (const face of faces.toSorted((left, right) => center(left.rect).y - center(right.rect).y)) {
    const row = rows.at(-1);
    const rowCentre = row ? median(row.map((member) => center(member.rect).y)) : 0;
    if (row && Math.abs(center(face.rect).y - rowCentre) < face.rect.h / 2) {
      row.push(face);
    } else {
      rows.push([face]);
    }
  }
  return rows.map((row) => row.toSorted((left, right) => left.rect.x - right.rect.x));
}

function overlapArea(left: Rect, right: Rect): number {
  const w = Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x);
  const h = Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function measureMetrics(faces: readonly MeasuredFace[], content: Rect, boxZ: number): FaceGridMetrics {
  if (!faces.length) {
    return {
      faceW: DEFAULT_FACE_EMU,
      faceH: DEFAULT_FACE_EMU,
      gapX: DEFAULT_GAP_EMU,
      gapY: DEFAULT_GAP_EMU,
      columns: 0,
      rows: 0,
      align: "center",
      left: content.x,
      top: content.y,
      crop: null,
      zOrder: "none",
      measured: false,
    };
  }
  const faceW = median(faces.map((face) => face.rect.w));
  const faceH = median(faces.map((face) => face.rect.h));
  const rows = faceRows(faces);
  const rowGaps = rows.flatMap((row) =>
    row.slice(1).map((face, index) => face.rect.x - (row[index]!.rect.x + row[index]!.rect.w)),
  );
  const gapX = rowGaps.filter((gap) => gap >= 0).length
    ? median(rowGaps.filter((gap) => gap >= 0))
    : DEFAULT_GAP_EMU;
  const rowTops = rows.map((row) => median(row.map((face) => face.rect.y)));
  const lineGaps = rowTops.slice(1).map((top, index) => top - rowTops[index]! - faceH);
  const gapY = lineGaps.filter((gap) => gap >= 0).length
    ? median(lineGaps.filter((gap) => gap >= 0))
    : gapX;
  const contentMid = content.x + content.w / 2;
  // Centred when every row straddles the middle of the box; a single full row is centred by both
  // readings, which is why it takes every row to call it.
  const centred = rows.every((row) => {
    const mid = (row[0]!.rect.x + row.at(-1)!.rect.x + row.at(-1)!.rect.w) / 2;
    return Math.abs(mid - contentMid) <= faceW / 2;
  });
  const crops = new Map<string, number>();
  for (const face of faces) {
    const key = JSON.stringify(face.crop ?? null);
    crops.set(key, (crops.get(key) ?? 0) + 1);
  }
  const commonCrop = [...crops.entries()].toSorted((left, right) => right[1] - left[1])[0]![0];
  const above = faces.filter((face) => face.z > boxZ).length;
  return {
    faceW,
    faceH,
    gapX,
    gapY,
    columns: Math.max(...rows.map((row) => row.length)),
    rows: rows.length,
    align: centred ? "center" : "left",
    left: Math.min(...faces.map((face) => face.rect.x)),
    top: Math.min(...faces.map((face) => face.rect.y)),
    crop: JSON.parse(commonCrop) as Record<string, number> | null,
    zOrder: above === faces.length ? "above_box" : above === 0 ? "below_box" : "mixed",
    measured: true,
  };
}

function locateBox(
  flat: readonly FlatElement[],
  box: WorkingGroupBox,
): { rect: Rect; objectId: string; z: number; content: Rect } | { reason: string } {
  const wanted = normalizeSlideText(box.title);
  const titles = flat.filter((element) => normalizeSlideText(element.text) === wanted);
  if (titles.length !== 1) {
    return { reason: `expected one "${box.title}" heading, found ${titles.length}` };
  }
  const title = titles[0]!;
  const titleArea = title.rect.w * title.rect.h;
  const containing = flat
    .filter(
      (element) =>
        element !== title &&
        BOX_SHAPES.has(element.element.shape?.shapeType ?? "") &&
        containsPoint(element.rect, center(title.rect)) &&
        element.rect.w * element.rect.h >= 2 * titleArea,
    )
    .toSorted((left, right) => left.rect.w * left.rect.h - right.rect.w * right.rect.h)[0];
  const boxElement =
    containing ?? (BOX_SHAPES.has(title.element.shape?.shapeType ?? "") ? title : undefined);
  if (!boxElement) {
    return { reason: `no rounded box around the "${box.title}" heading` };
  }
  const rect = boxElement.rect;
  const headerBottom =
    boxElement === title ? rect.y + HEADER_FALLBACK_EMU : title.rect.y + title.rect.h + TITLE_GAP_EMU;
  const top = Math.max(rect.y + CONTENT_INSET_EMU, headerBottom);
  const bottom = rect.y + rect.h - CONTENT_INSET_EMU;
  return {
    rect,
    objectId: boxElement.element.objectId,
    z: boxElement.z,
    content: {
      x: rect.x + CONTENT_INSET_EMU,
      y: top,
      w: rect.w - 2 * CONTENT_INSET_EMU,
      h: Math.max(0, bottom - top),
    },
  };
}

/**
 * Reads the six boxes off the slide: where each one is, which images in it are faces, and the
 * attributes of the grid they form -- size, spacing, columns, alignment, crop and paint order.
 */
export function measureWorkingGroupsSlide(
  slide: SlidesPage,
  boxes: readonly WorkingGroupBox[],
): Array<MeasuredBox | MissingBox> {
  const flat = flattenSlide(slide);
  const images = flat.filter((element) => element.element.image);
  const located = boxes.map((box) => ({ box, located: locateBox(flat, box) }));
  const found = located.flatMap((entry) => ("reason" in entry.located ? [] : [{ key: entry.box.key, ...entry.located }]));
  const owners = new Map<string, string>();
  const strays: FlatElement[] = [];
  for (const image of images) {
    const tag = parseFaceObjectId(image.element.objectId);
    if (tag) {
      // A face this sync minted belongs to the box its id names, wherever it was dragged.
      owners.set(image.element.objectId, tag.groupKey);
      continue;
    }
    if (!isFaceShaped(image.rect)) {
      continue;
    }
    const point = center(image.rect);
    const inside = found.find((entry) => containsPoint(entry.content, point));
    if (inside) {
      owners.set(image.element.objectId, inside.key);
    } else if (!found.some((entry) => containsPoint(entry.rect, point))) {
      strays.push(image);
    }
  }
  // A face that spilled out of its box -- the overflow this sync exists to fix -- is still that
  // box's face. Without this it would be invisible to the plan, which would add the same member
  // again and leave the spilled copy where it is. Rows grow downwards and columns rightwards, so a
  // stray is claimed only by a box whose top is above it, within one box height of it, and only
  // if it is roughly that box's face size: a logo in the title band is never mistaken for a face.
  for (const image of strays) {
    const point = center(image.rect);
    const owner = found
      .filter((entry) => point.y >= entry.rect.y && point.x >= entry.rect.x)
      .map((entry) => ({ entry, distance: distanceToRect(entry.rect, point) }))
      .filter(({ entry, distance }) => distance <= entry.rect.h)
      .filter(({ entry }) => {
        const typical = medianFaceSize(images.filter((other) => owners.get(other.element.objectId) === entry.key));
        const size = Math.max(image.rect.w, image.rect.h);
        return size >= typical / 2 && size <= typical * 2;
      })
      .toSorted((left, right) => left.distance - right.distance)[0];
    if (owner) {
      owners.set(image.element.objectId, owner.entry.key);
    }
  }
  return located.map(({ box, located: place }) => {
    if ("reason" in place) {
      return { box, found: false, reason: place.reason };
    }
    const faces: MeasuredFace[] = images
      .filter((image) => owners.get(image.element.objectId) === box.key)
      .map((image) => ({
        objectId: image.element.objectId,
        rect: image.rect,
        intrinsic: image.intrinsic,
        z: image.z,
        ...(image.element.title ? { title: image.element.title } : {}),
        ...(image.element.description ? { description: image.element.description } : {}),
        tag: parseFaceObjectId(image.element.objectId),
        movable: !image.grouped && !image.sheared && image.intrinsic.w > 0 && image.intrinsic.h > 0,
        ...(image.element.image?.imageProperties?.cropProperties
          ? { crop: image.element.image.imageProperties.cropProperties }
          : {}),
      }));
    const slack = Math.round(0.01 * EMU_PER_INCH);
    const outside = faces.some(
      (face) =>
        face.rect.x < place.rect.x - slack ||
        face.rect.y < place.rect.y - slack ||
        face.rect.x + face.rect.w > place.rect.x + place.rect.w + slack ||
        face.rect.y + face.rect.h > place.rect.y + place.rect.h + slack,
    );
    const overlapping = faces.some((face, index) =>
      faces
        .slice(index + 1)
        .some((other) => overlapArea(face.rect, other.rect) > 0.1 * face.rect.w * face.rect.h),
    );
    // Measured from the faces inside the box only: a spilled face sits wherever the overflow left
    // it, and letting it vote would teach the grid the overflow's spacing.
    const settled = faces.filter((face) => containsPoint(place.content, center(face.rect)));
    return {
      box,
      found: true,
      rect: place.rect,
      boxObjectId: place.objectId,
      content: place.content,
      faces,
      metrics: measureMetrics(settled.length ? settled : faces, place.content, place.z),
      overflowing: outside || overlapping,
    };
  });
}

function distanceToRect(rect: Rect, point: { x: number; y: number }): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.w));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

function medianFaceSize(images: readonly FlatElement[]): number {
  if (!images.length) {
    return DEFAULT_FACE_EMU;
  }
  const sizes = images.map((image) => Math.max(image.rect.w, image.rect.h)).toSorted((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)]!;
}

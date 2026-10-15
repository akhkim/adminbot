import type { AdminBotLabMember } from "../../contracts/actions.js";
import { EMU_PER_INCH } from "../../contracts/google-slides.js";
import {
  faceRows,
  type FaceGridMetrics,
  type MeasuredBox,
  type MeasuredFace,
  type MissingBox,
  type Rect,
} from "./face-layout-measure.js";
import {
  faceObjectId,
  hasFacePhoto,
  memberIdsByFaceHash,
  normalizeSlideText,
  workingGroupMembers,
} from "./working-groups.js";

// Below this a face stops being recognisable on a projected slide; past it the group is reported
// for a human to split or enlarge the box rather than shrunk into confetti.
export const MIN_FACE_EMU = Math.round(0.2 * EMU_PER_INCH);
// Sub-pixel drift between what was planned and what Slides stores back (it rounds transforms)
// must not read as a move, or the sync would never be idempotent.
export const POSITION_TOLERANCE_EMU = 9_144;

export type PlannedFace = {
  objectId: string;
  memberId: string | null;
  name: string;
  rect: Rect;
  action: "keep" | "move" | "create";
  /** Only for a face being created: the URL Slides fetches the photo from. */
  sourceUrl?: string;
  /** Only for a face being moved: what it looked like before and its unscaled size. */
  from?: Rect;
  intrinsic?: { w: number; h: number };
};

export type RemovedFace = { objectId: string; memberId: string | null; name: string; rect: Rect };

export type GroupPlan = {
  key: string;
  title: string;
  theme: string | null;
  status: "unchanged" | "update" | "blocked" | "untouched" | "missing";
  reason?: string;
  box: Rect | null;
  content: Rect | null;
  metrics: FaceGridMetrics | null;
  overflowing: boolean;
  target: { faceW: number; faceH: number; columns: number; rows: number; shrunk: boolean } | null;
  /** The faces after the change (or as they are, when nothing changes). */
  faces: PlannedFace[];
  removed: RemovedFace[];
  added: string[];
  /** Members who belong in the group but have no photo to show. Skipped, not drawn as blanks. */
  skippedNoPhoto: string[];
  /** Face-like images nobody can be tied to. Never touched; they block a change to their box. */
  unidentified: string[];
};

export type WorkingGroupsPlan = {
  slideObjectId: string;
  groups: GroupPlan[];
  changed: boolean;
  /** Every objectId the plan may move or delete. The request builder refuses anything else. */
  identifiedObjectIds: string[];
};

type Identified = { face: MeasuredFace; memberId: string | null; name: string };

function displayName(member: AdminBotLabMember): string {
  return member.preferred_name?.trim() || member.name;
}

/**
 * Ties each face to a member, or to nobody.
 *
 * A face this sync minted is known by its id. One placed by hand is known only through its alt
 * text -- the member's name, email, or an explicit `adminbot:face:<id>` -- and only when exactly
 * one member answers to it. Anything else stays unidentified, and an unidentified image is never
 * moved or deleted: it might be a co-organiser's photo, a logo, or a face whose owner the roster
 * spells differently.
 */
function identifyFaces(
  faces: readonly MeasuredFace[],
  members: readonly AdminBotLabMember[],
): { identified: Identified[]; unidentified: MeasuredFace[] } {
  const byHash = memberIdsByFaceHash(members);
  const byId = new Map(members.map((member) => [member.id, member]));
  const byLabel = new Map<string, Set<string>>();
  for (const member of members) {
    for (const label of [member.name, member.preferred_name, member.email]) {
      const key = normalizeSlideText(label ?? "");
      if (key) {
        byLabel.set(key, (byLabel.get(key) ?? new Set()).add(member.id));
      }
    }
  }
  const identified: Identified[] = [];
  const unidentified: MeasuredFace[] = [];
  for (const face of faces) {
    if (face.tag) {
      const memberId = byHash.get(face.tag.hash) ?? null;
      const member = memberId ? byId.get(memberId) : undefined;
      // A minted face whose member has left the roster entirely is still ours to remove.
      identified.push({ face, memberId, name: member ? displayName(member) : "former member" });
      continue;
    }
    const memberId = [face.title, face.description]
      .map((label) => label?.trim() ?? "")
      .filter(Boolean)
      .map((label) => {
        const explicit = /^adminbot:face:(.+)$/u.exec(label)?.[1]?.trim();
        if (explicit) {
          return byId.has(explicit) ? explicit : undefined;
        }
        const matches = byLabel.get(normalizeSlideText(label));
        return matches?.size === 1 ? [...matches][0] : undefined;
      })
      .find(Boolean);
    const member = memberId ? byId.get(memberId) : undefined;
    if (member) {
      identified.push({ face, memberId: member.id, name: displayName(member) });
    } else {
      unidentified.push(face);
    }
  }
  return { identified, unidentified };
}

type Grid = { rects: Rect[]; faceW: number; faceH: number; columns: number; rows: number };

function placeRows(
  count: number,
  columns: number,
  faceW: number,
  faceH: number,
  gapX: number,
  gapY: number,
  top: number,
  rowLeft: (rowLength: number) => number,
): Rect[] {
  const rects: Rect[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / columns);
    const rowLength = Math.min(columns, count - row * columns);
    const col = index % columns;
    rects.push({
      x: Math.round(rowLeft(rowLength) + col * (faceW + gapX)),
      y: Math.round(top + row * (faceH + gapY)),
      w: faceW,
      h: faceH,
    });
  }
  return rects;
}

function gridSize(count: number, columns: number, w: number, h: number, gx: number, gy: number) {
  const rows = Math.ceil(count / columns);
  const used = Math.min(columns, count);
  return { rows, width: used * w + (used - 1) * gx, height: rows * h + (rows - 1) * gy };
}

/**
 * Where `count` faces go in `content`, honouring what was measured while it fits.
 *
 * First at the measured size, with the measured column count and then with as many columns as the
 * box allows. Only when neither fits does every face shrink -- by one factor, so the gaps keep
 * their proportion to the faces -- choosing the column count that leaves the faces largest, and
 * the shrunk grid is centred both ways. Shrinking is per group: one crowded box does not make the
 * other five smaller.
 */
export function layoutFaceGrid(
  count: number,
  content: Rect,
  metrics: FaceGridMetrics,
): ({ ok: true; shrunk: boolean } & Grid) | { ok: false; reason: string } {
  const faceW = Math.round(metrics.faceW);
  const faceH = Math.round(metrics.faceH);
  const { gapX, gapY } = metrics;
  if (count === 0) {
    return { ok: true, shrunk: false, rects: [], faceW, faceH, columns: 0, rows: 0 };
  }
  const maxColumns = Math.max(1, Math.floor((content.w + gapX) / (faceW + gapX)));
  const candidates = [
    ...(metrics.columns > 0 && metrics.columns <= maxColumns ? [metrics.columns] : []),
    maxColumns,
  ];
  for (const columns of candidates) {
    const size = gridSize(count, columns, faceW, faceH, gapX, gapY);
    if (size.width > content.w || size.height > content.h) {
      continue;
    }
    // Keep the grid where the faces already were, as long as it still ends inside the box.
    const top = metrics.measured
      ? Math.min(Math.max(metrics.top, content.y), content.y + content.h - size.height)
      : content.y;
    const left = Math.min(Math.max(metrics.left, content.x), content.x + content.w - size.width);
    const rowLeft =
      metrics.align === "center"
        ? (rowLength: number) =>
            content.x + (content.w - (rowLength * faceW + (rowLength - 1) * gapX)) / 2
        : () => left;
    return {
      ok: true,
      shrunk: false,
      rects: placeRows(count, columns, faceW, faceH, gapX, gapY, top, rowLeft),
      faceW,
      faceH,
      columns,
      rows: size.rows,
    };
  }
  let best: { scale: number; columns: number } | null = null;
  for (let columns = 1; columns <= count; columns += 1) {
    const unit = gridSize(count, columns, faceW, faceH, gapX, gapY);
    const scale = Math.min(1, content.w / unit.width, content.h / unit.height);
    const closer =
      best &&
      scale === best.scale &&
      Math.abs(columns - metrics.columns) < Math.abs(best.columns - metrics.columns);
    if (!best || scale > best.scale || closer) {
      best = { scale, columns };
    }
  }
  const { scale, columns } = best!;
  const w = Math.floor(faceW * scale);
  const h = Math.floor(faceH * scale);
  if (Math.min(w, h) < MIN_FACE_EMU) {
    return {
      ok: false,
      reason: `${count} faces would need to shrink below ${(MIN_FACE_EMU / EMU_PER_INCH).toFixed(2)} in to fit; enlarge or split the box`,
    };
  }
  const gx = gapX * scale;
  const gy = gapY * scale;
  const size = gridSize(count, columns, w, h, gx, gy);
  const top = content.y + (content.h - size.height) / 2;
  return {
    ok: true,
    shrunk: true,
    rects: placeRows(count, columns, w, h, gx, gy, top, (rowLength) => {
      return content.x + (content.w - (rowLength * w + (rowLength - 1) * gx)) / 2;
    }),
    faceW: w,
    faceH: h,
    columns,
    rows: size.rows,
  };
}

function sameRect(left: Rect, right: Rect): boolean {
  return (
    Math.abs(left.x - right.x) <= POSITION_TOLERANCE_EMU &&
    Math.abs(left.y - right.y) <= POSITION_TOLERANCE_EMU &&
    Math.abs(left.w - right.w) <= POSITION_TOLERANCE_EMU &&
    Math.abs(left.h - right.h) <= POSITION_TOLERANCE_EMU
  );
}

function readingOrder<T extends { rect: Rect }>(faces: readonly T[]): T[] {
  return faceRows(faces).flat();
}

function planGroup(
  measured: MeasuredBox | MissingBox,
  members: readonly AdminBotLabMember[],
  faceImageUrl: (avatarUrl: string) => string,
  identifiedIds: Set<string>,
): GroupPlan {
  const { box } = measured;
  const base = {
    key: box.key,
    title: box.title,
    theme: box.theme,
    removed: [],
    added: [],
    skippedNoPhoto: [],
    unidentified: [],
    target: null,
  };
  if (!measured.found) {
    return {
      ...base,
      status: "missing",
      reason: measured.reason,
      box: null,
      content: null,
      metrics: null,
      overflowing: false,
      faces: [],
    };
  }
  const { identified, unidentified } = identifyFaces(measured.faces, members);
  const asIs: PlannedFace[] = readingOrder(identified.map((entry) => ({ ...entry, rect: entry.face.rect }))).map(
    (entry) => ({
      objectId: entry.face.objectId,
      memberId: entry.memberId,
      name: entry.name,
      rect: entry.face.rect,
      action: "keep" as const,
    }),
  );
  const measuredPart = {
    box: measured.rect,
    content: measured.content,
    metrics: measured.metrics,
    overflowing: measured.overflowing,
    unidentified: unidentified.map((face) => face.objectId),
  };
  if (!box.theme) {
    return {
      ...base,
      ...measuredPart,
      status: "untouched",
      reason: "no research theme maps to this box; it is measured but left as it is",
      faces: asIs,
    };
  }
  const wanted = workingGroupMembers(members, box.theme);
  const wantedIds = new Set(wanted.map((member) => member.id));
  const kept: Identified[] = [];
  const removed: RemovedFace[] = [];
  const seen = new Set<string>();
  for (const entry of readingOrder(identified.map((item) => ({ ...item, rect: item.face.rect })))) {
    if (entry.memberId && wantedIds.has(entry.memberId) && !seen.has(entry.memberId)) {
      seen.add(entry.memberId);
      kept.push(entry);
    } else {
      // Left the group, left the lab, or a second copy of somebody already shown.
      removed.push({
        objectId: entry.face.objectId,
        memberId: entry.memberId,
        name: entry.name,
        rect: entry.face.rect,
      });
    }
  }
  const missing = wanted.filter((member) => !seen.has(member.id));
  const adding = missing
    .filter(hasFacePhoto)
    .toSorted((left, right) => displayName(left).localeCompare(displayName(right)));
  const skippedNoPhoto = missing.filter((member) => !hasFacePhoto(member)).map(displayName);
  const needsChange = removed.length > 0 || adding.length > 0 || measured.overflowing;
  const blocked = (reason: string): GroupPlan => ({
    ...base,
    ...measuredPart,
    status: "blocked",
    reason,
    skippedNoPhoto,
    faces: asIs,
  });
  if (!needsChange) {
    return { ...base, ...measuredPart, status: "unchanged", skippedNoPhoto, faces: asIs };
  }
  if (unidentified.length) {
    return blocked(
      `${unidentified.length} image(s) in this box are not tied to a member (${unidentified
        .map((face) => face.objectId)
        .join(", ")}); set their alt text to the member's name or delete them, then re-run`,
    );
  }
  const stuck = kept.filter((entry) => !entry.face.movable);
  if (stuck.length) {
    return blocked(
      `${stuck.length} face(s) are grouped or rotated (${stuck
        .map((entry) => entry.face.objectId)
        .join(", ")}); ungroup or straighten them, then re-run`,
    );
  }
  const grid = layoutFaceGrid(kept.length + adding.length, measured.content, measured.metrics);
  if (!grid.ok) {
    return blocked(grid.reason);
  }
  for (const entry of [...kept.map((item) => item.face), ...removed]) {
    identifiedIds.add(entry.objectId);
  }
  const faces: PlannedFace[] = [
    ...kept.map((entry, index): PlannedFace => {
      const rect = grid.rects[index]!;
      const moved = !sameRect(entry.face.rect, rect);
      return {
        objectId: entry.face.objectId,
        memberId: entry.memberId,
        name: entry.name,
        rect,
        action: moved ? "move" : "keep",
        ...(moved ? { from: entry.face.rect, intrinsic: entry.face.intrinsic } : {}),
      };
    }),
    ...adding.map(
      (member, index): PlannedFace => ({
        objectId: faceObjectId(box.key, member.id),
        memberId: member.id,
        name: displayName(member),
        rect: grid.rects[kept.length + index]!,
        action: "create",
        sourceUrl: faceImageUrl(member.avatar_url!.trim()),
      }),
    ),
  ];
  const changed = removed.length > 0 || faces.some((face) => face.action !== "keep");
  return {
    ...base,
    ...measuredPart,
    status: changed ? "update" : "unchanged",
    target: {
      faceW: grid.faceW,
      faceH: grid.faceH,
      columns: grid.columns,
      rows: grid.rows,
      shrunk: grid.shrunk,
    },
    faces,
    removed,
    added: adding.map(displayName),
    skippedNoPhoto,
  };
}

/**
 * The whole slide's plan: per box, who stays, who goes, who is added and where every face ends up.
 *
 * Pure: the same slide and roster always give the same plan, and a slide that already matches the
 * roster gives a plan with no changes -- which is what makes it safe to run every week.
 */
export function planWorkingGroupsSlide(params: {
  slideObjectId: string;
  measured: ReadonlyArray<MeasuredBox | MissingBox>;
  members: readonly AdminBotLabMember[];
  faceImageUrl?: (avatarUrl: string) => string;
}): WorkingGroupsPlan {
  const identifiedIds = new Set<string>();
  const faceImageUrl = params.faceImageUrl ?? ((url: string) => url);
  const groups = params.measured.map((measured) =>
    planGroup(measured, params.members, faceImageUrl, identifiedIds),
  );
  return {
    slideObjectId: params.slideObjectId,
    groups,
    changed: groups.some((group) => group.status === "update"),
    identifiedObjectIds: [...identifiedIds].toSorted(),
  };
}

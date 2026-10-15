import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  containsPoint,
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
  hasMembershipRule,
  memberIdsByFaceHash,
  normalizeSlideText,
  parseFaceOwnerTag,
  workingGroupMembers,
} from "./working-groups.js";

// Sub-pixel drift between what was planned and what Slides stores back (it rounds transforms)
// must not read as a move, or the executor's drift check would refuse every approval.
export const POSITION_TOLERANCE_EMU = 9_144;

export type PlannedFace = {
  objectId: string;
  memberId: string | null;
  name: string;
  rect: Rect;
  /** "keep" is every image already on the slide; the sync only ever adds after them. */
  action: "keep" | "create";
  /** Only for a face being created: the member's avatar, which the executor makes round. */
  sourceUrl?: string;
};

export type RemovedFace = { objectId: string; memberId: string | null; name: string; rect: Rect };

export type GroupPlan = {
  key: string;
  title: string;
  theme: string | null;
  keywords: readonly string[];
  status: "unchanged" | "update" | "full" | "untouched" | "missing";
  reason?: string;
  box: Rect | null;
  content: Rect | null;
  metrics: FaceGridMetrics | null;
  /** Every face in the box after the change: the ones already there, then the new ones. */
  faces: PlannedFace[];
  /** Faces this sync placed for people who left the group, deleted because removals are on. */
  removed: RemovedFace[];
  /** The same faces when removals are off: listed for the approver, left on the slide. */
  wouldRemove: RemovedFace[];
  added: string[];
  /** People who belong but would not fit after the last face; the box is left as it is. */
  noRoom: string[];
  /** Members who belong in the group but have no photo to show. Skipped, not drawn as blanks. */
  skippedNoPhoto: string[];
  /** Images in the box nobody can be tied to. Never touched; they only take up room. */
  unidentified: Array<{ objectId: string; rect: Rect }>;
};

export type WorkingGroupsPlan = {
  slideObjectId: string;
  groups: GroupPlan[];
  changed: boolean;
  /** Every objectId the plan may delete. The request builder refuses anything else. */
  identifiedObjectIds: string[];
};

type Identified = { face: MeasuredFace; memberId: string | null; name: string; owned: boolean };

function displayName(member: AdminBotLabMember): string {
  return member.preferred_name?.trim() || member.name;
}

/**
 * Ties each face to a member, or to nobody, and says which faces are ours.
 *
 * Ours means this sync placed it: the objectId is one it minted, or the alt text carries the
 * `adminbot:member:<id>` tag. Only those may ever be deleted. A face placed by hand is tied to a
 * member through its alt text -- name, preferred name or email, when exactly one member answers to
 * it -- and that only stops the same person being added twice; it is never touched.
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
  const named = (memberId: string | null) => {
    const member = memberId ? byId.get(memberId) : undefined;
    return member ? displayName(member) : "former member";
  };
  const identified: Identified[] = [];
  const unidentified: MeasuredFace[] = [];
  for (const face of faces) {
    const tagged = parseFaceOwnerTag(face.description);
    if (face.tag || tagged) {
      // A face we placed whose member has left the roster entirely is still ours to remove.
      const memberId = tagged ?? byHash.get(face.tag!.hash) ?? null;
      identified.push({ face, memberId, name: named(memberId), owned: true });
      continue;
    }
    const memberId = [face.title, face.description]
      .map((label) => normalizeSlideText(label ?? ""))
      .filter(Boolean)
      .map((label) => {
        const matches = byLabel.get(label);
        return matches?.size === 1 ? [...matches][0] : undefined;
      })
      .find(Boolean);
    if (memberId) {
      identified.push({ face, memberId, name: named(memberId), owned: false });
    } else {
      unidentified.push(face);
    }
  }
  return { identified, unidentified };
}

function overlaps(left: Rect, right: Rect): boolean {
  const w = Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x);
  const h = Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y);
  return w > 0 && h > 0;
}

/**
 * The slots after the last face in a box, at the measured size and spacing, wrapping where the
 * existing rows wrap. Null when they do not all fit inside the box.
 *
 * Only faces settled inside the box anchor the grid: one that spilled over the edge sits wherever
 * the overflow left it. A slot that would overlap any image already in the box is skipped rather
 * than covered, so a hand-placed face out of line is never hidden behind a new one.
 */
export function appendSlots(
  count: number,
  content: Rect,
  metrics: FaceGridMetrics,
  existing: readonly Rect[],
): Rect[] | null {
  if (count === 0) {
    return [];
  }
  const faceW = Math.round(metrics.faceW);
  const faceH = Math.round(metrics.faceH);
  const stepX = faceW + metrics.gapX;
  const stepY = faceH + metrics.gapY;
  const settled = existing.filter((rect) =>
    containsPoint(content, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }),
  );
  const rows = faceRows(settled.map((rect) => ({ rect })));
  const lastRow = rows.at(-1);
  // Rows start where the existing rows start; an empty box starts under its heading.
  const rowStart = settled.length ? Math.min(...settled.map((rect) => rect.x)) : content.x;
  const fitColumns = Math.max(1, Math.floor((content.x + content.w - rowStart + metrics.gapX) / stepX));
  const columns = metrics.columns > 0 ? Math.min(metrics.columns, fitColumns) : fitColumns;
  let y = lastRow ? Math.min(...lastRow.map((entry) => entry.rect.y)) : content.y;
  let column = lastRow ? lastRow.length : 0;
  let x = lastRow ? lastRow.at(-1)!.rect.x + lastRow.at(-1)!.rect.w + metrics.gapX : rowStart;
  const slots: Rect[] = [];
  const right = content.x + content.w;
  const bottom = content.y + content.h;
  while (slots.length < count) {
    if (column >= columns || x + faceW > right) {
      y += stepY;
      x = rowStart;
      column = 0;
    }
    if (y + faceH > bottom) {
      return null;
    }
    const slot = { x: Math.round(x), y: Math.round(y), w: faceW, h: faceH };
    if (!existing.some((rect) => overlaps(rect, slot))) {
      slots.push(slot);
    }
    x += stepX;
    column += 1;
  }
  return slots;
}

function readingOrder<T extends { rect: Rect }>(faces: readonly T[]): T[] {
  return faceRows(faces).flat();
}

function planGroup(
  measured: MeasuredBox | MissingBox,
  members: readonly AdminBotLabMember[],
  allowRemovals: boolean,
  removable: Set<string>,
): GroupPlan {
  const { box } = measured;
  const base = {
    key: box.key,
    title: box.title,
    theme: box.theme,
    keywords: box.keywords ?? [],
    removed: [],
    wouldRemove: [],
    added: [],
    noRoom: [],
    skippedNoPhoto: [],
    unidentified: [],
  };
  if (!measured.found) {
    return { ...base, status: "missing", reason: measured.reason, box: null, content: null, metrics: null, faces: [] };
  }
  const { identified, unidentified } = identifyFaces(measured.faces, members);
  const keepAll = (entries: readonly Identified[]): PlannedFace[] =>
    readingOrder(entries.map((entry) => ({ ...entry, rect: entry.face.rect }))).map((entry) => ({
      objectId: entry.face.objectId,
      memberId: entry.memberId,
      name: entry.name,
      rect: entry.face.rect,
      action: "keep" as const,
    }));
  const measuredPart = {
    box: measured.rect,
    content: measured.content,
    metrics: measured.metrics,
    unidentified: unidentified.map((face) => ({ objectId: face.objectId, rect: face.rect })),
  };
  if (!hasMembershipRule(box)) {
    return {
      ...base,
      ...measuredPart,
      status: "untouched",
      reason: "neither a research theme nor keywords map to this box; it is measured but left as it is",
      faces: keepAll(identified),
    };
  }
  const wanted = workingGroupMembers(members, box);
  const wantedIds = new Set(wanted.map((member) => member.id));
  // Somebody already shown -- by a face we placed or one placed by hand -- is not added again.
  const shown = new Set(identified.flatMap((entry) => (entry.memberId ? [entry.memberId] : [])));
  // Ours and no longer wanted: left the group, left the lab, or a second copy of the same person.
  const stale: RemovedFace[] = [];
  const seenOwned = new Set<string>();
  for (const entry of readingOrder(identified.map((item) => ({ ...item, rect: item.face.rect })))) {
    if (!entry.owned) {
      continue;
    }
    const duplicate = entry.memberId !== null && seenOwned.has(entry.memberId);
    if (entry.memberId) {
      seenOwned.add(entry.memberId);
    }
    if (!entry.memberId || !wantedIds.has(entry.memberId) || duplicate) {
      stale.push({ objectId: entry.face.objectId, memberId: entry.memberId, name: entry.name, rect: entry.face.rect });
    }
  }
  const removed = allowRemovals ? stale : [];
  const removedIds = new Set(removed.map((face) => face.objectId));
  const remaining = identified.filter((entry) => !removedIds.has(entry.face.objectId));
  const missing = wanted.filter((member) => !shown.has(member.id));
  const adding = missing
    .filter(hasFacePhoto)
    .toSorted((left, right) => displayName(left).localeCompare(displayName(right)));
  const skippedNoPhoto = missing.filter((member) => !hasFacePhoto(member)).map(displayName);
  // Every image stays where it is, so every one -- tied to a member or not -- takes up room.
  const occupied = [...remaining.map((entry) => entry.face.rect), ...unidentified.map((face) => face.rect)];
  const slots = appendSlots(adding.length, measured.content, measured.metrics, occupied);
  const noRoom = slots ? [] : adding.map(displayName);
  const placed = slots ? adding : [];
  for (const face of removed) {
    removable.add(face.objectId);
  }
  const faces: PlannedFace[] = [
    ...keepAll(remaining),
    ...placed.map(
      (member, index): PlannedFace => ({
        objectId: faceObjectId(box.key, member.id),
        memberId: member.id,
        name: displayName(member),
        rect: slots![index]!,
        action: "create",
        sourceUrl: member.avatar_url!.trim(),
      }),
    ),
  ];
  const changed = removed.length > 0 || placed.length > 0;
  return {
    ...base,
    ...measuredPart,
    status: changed ? "update" : noRoom.length ? "full" : "unchanged",
    ...(noRoom.length
      ? {
          reason: `${noRoom.length} member(s) do not fit after the last face at the current size; enlarge the box, make room, or add them by hand`,
        }
      : {}),
    faces,
    removed,
    wouldRemove: allowRemovals ? [] : stale,
    added: placed.map(displayName),
    noRoom,
    skippedNoPhoto,
  };
}

/**
 * The whole slide's plan: per box, who is added after the faces already there, who does not fit,
 * and -- only with removals switched on -- which of this sync's own faces go.
 *
 * Append-only by construction: no existing image is ever moved, and none placed by hand is ever
 * deleted. Pure: the same slide and roster always give the same plan, and a slide that already
 * shows everybody gives a plan with no changes -- which is what makes it safe to run every week.
 */
export function planWorkingGroupsSlide(params: {
  slideObjectId: string;
  measured: ReadonlyArray<MeasuredBox | MissingBox>;
  members: readonly AdminBotLabMember[];
  allowRemovals?: boolean;
}): WorkingGroupsPlan {
  const removable = new Set<string>();
  const groups = params.measured.map((measured) =>
    planGroup(measured, params.members, params.allowRemovals === true, removable),
  );
  return {
    slideObjectId: params.slideObjectId,
    groups,
    changed: groups.some((group) => group.status === "update"),
    identifiedObjectIds: [...removable].toSorted(),
  };
}

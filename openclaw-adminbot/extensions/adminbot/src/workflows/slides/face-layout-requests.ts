import {
  EMU_PER_INCH,
  type AdminBotSlidesWorkingGroupsPayload,
  type FaceRing,
  type SlidesFaceRequest,
} from "../../contracts/google-slides.js";
import type { FaceGridMetrics } from "./face-layout-measure.js";
import type { WorkingGroupsPlan } from "./face-layout-plan.js";
import { FACE_ID_PREFIX, faceOwnerTag } from "./working-groups.js";

/** The measured outline as a share of the face, so the ring scales with whatever PNG is made. */
function faceRing(metrics: FaceGridMetrics | null): FaceRing | null {
  if (!metrics?.ring || !(metrics.faceW > 0)) {
    return null;
  }
  const { red, green, blue, weight } = metrics.ring;
  return { red, green, blue, width_ratio: Number((weight / metrics.faceW).toFixed(4)) };
}

/**
 * The minimal batchUpdate for a plan: deletes (only with removals on), then each new face and its
 * alt-text tag.
 *
 * There is no move: every image already on the slide stays exactly where it is. Deletes go first
 * so a face leaving and one arriving never coexist mid-batch, and creates last so new faces land
 * on top of the paint order the way a hand-inserted image does. Only faces the planner marked as
 * ours may be deleted; the builder re-checks that rather than trusting the plan, because it is the
 * last line before a write to a shared deck.
 */
export function buildFaceRequests(
  plan: WorkingGroupsPlan,
  presentationId: string,
): AdminBotSlidesWorkingGroupsPayload {
  const removable = new Set(plan.identifiedObjectIds);
  const updating = plan.groups.filter((group) => group.status === "update");
  const deletes: SlidesFaceRequest[] = [];
  const creates: SlidesFaceRequest[] = [];
  const expected: AdminBotSlidesWorkingGroupsPayload["expected"] = [];
  const faces: AdminBotSlidesWorkingGroupsPayload["faces"] = [];
  for (const group of updating) {
    for (const face of group.removed) {
      if (!removable.has(face.objectId)) {
        throw new Error(`refusing to delete ${face.objectId}: it is not a face this sync placed`);
      }
      deletes.push({ deleteObject: { objectId: face.objectId } });
      expected.push({
        object_id: face.objectId,
        translate_x: Math.round(face.rect.x),
        translate_y: Math.round(face.rect.y),
      });
    }
    const ring = faceRing(group.metrics);
    for (const face of group.faces) {
      if (face.action !== "create") {
        continue;
      }
      if (!face.objectId.startsWith(FACE_ID_PREFIX) || !face.sourceUrl || !face.memberId) {
        throw new Error(`refusing to create ${face.objectId}: untagged id or no photo`);
      }
      creates.push(
        {
          createImage: {
            objectId: face.objectId,
            url: face.sourceUrl,
            elementProperties: {
              pageObjectId: plan.slideObjectId,
              size: {
                width: { magnitude: face.rect.w, unit: "EMU" },
                height: { magnitude: face.rect.h, unit: "EMU" },
              },
              transform: {
                scaleX: 1,
                scaleY: 1,
                shearX: 0,
                shearY: 0,
                translateX: face.rect.x,
                translateY: face.rect.y,
                unit: "EMU",
              },
            },
          },
        },
        {
          updatePageElementAltText: {
            objectId: face.objectId,
            title: face.name,
            description: faceOwnerTag(face.memberId),
          },
        },
      );
      faces.push({ object_id: face.objectId, member_id: face.memberId, avatar_url: face.sourceUrl, ring });
    }
  }
  return {
    presentation_id: presentationId,
    slide_object_id: plan.slideObjectId,
    requests: [...deletes, ...creates],
    expected,
    faces,
    groups: plan.groups.map((group) => ({
      group: group.key,
      title: group.title,
      status: group.status,
      added: group.added,
      removed: group.removed.map((face) => face.name),
      would_remove: group.wouldRemove.map((face) => face.name),
      no_room: group.noRoom,
      skipped_no_photo: group.skippedNoPhoto,
      face_size_in: Number(((group.metrics?.faceW ?? 0) / EMU_PER_INCH).toFixed(3)),
    })),
  };
}

import {
  EMU_PER_INCH,
  type AdminBotSlidesWorkingGroupsPayload,
  type SlidesFaceRequest,
} from "../../contracts/google-slides.js";
import type { WorkingGroupsPlan } from "./face-layout-plan.js";
import { FACE_ID_PREFIX } from "./working-groups.js";

/**
 * The minimal batchUpdate for a plan: deletes, then moves, then creates.
 *
 * Deletes first so a face leaving and a face arriving never coexist mid-batch, and creates last so
 * new faces land on top of the paint order the way a hand-inserted image does. Only faces the
 * planner tied to a member may be moved or deleted; the builder re-checks that rather than trusting
 * the plan, because it is the last line before a write to a shared deck.
 */
export function buildFaceRequests(
  plan: WorkingGroupsPlan,
  presentationId: string,
): AdminBotSlidesWorkingGroupsPayload {
  const identified = new Set(plan.identifiedObjectIds);
  const assertIdentified = (objectId: string) => {
    if (!identified.has(objectId)) {
      throw new Error(`refusing to touch ${objectId}: it is not an identified member face`);
    }
  };
  const updating = plan.groups.filter((group) => group.status === "update");
  const deletes: SlidesFaceRequest[] = [];
  const moves: SlidesFaceRequest[] = [];
  const creates: SlidesFaceRequest[] = [];
  const expected: AdminBotSlidesWorkingGroupsPayload["expected"] = [];
  for (const group of updating) {
    for (const face of group.removed) {
      assertIdentified(face.objectId);
      deletes.push({ deleteObject: { objectId: face.objectId } });
      expected.push({
        object_id: face.objectId,
        translate_x: Math.round(face.rect.x),
        translate_y: Math.round(face.rect.y),
      });
    }
    for (const face of group.faces) {
      if (face.action === "move") {
        assertIdentified(face.objectId);
        const intrinsic = face.intrinsic!;
        moves.push({
          updatePageElementTransform: {
            objectId: face.objectId,
            applyMode: "ABSOLUTE",
            transform: {
              scaleX: face.rect.w / intrinsic.w,
              scaleY: face.rect.h / intrinsic.h,
              shearX: 0,
              shearY: 0,
              translateX: face.rect.x,
              translateY: face.rect.y,
              unit: "EMU",
            },
          },
        });
        expected.push({
          object_id: face.objectId,
          translate_x: Math.round(face.from!.x),
          translate_y: Math.round(face.from!.y),
        });
      } else if (face.action === "create") {
        if (!face.objectId.startsWith(FACE_ID_PREFIX) || !face.sourceUrl) {
          throw new Error(`refusing to create ${face.objectId}: untagged id or no photo`);
        }
        creates.push({
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
        });
      }
    }
  }
  return {
    presentation_id: presentationId,
    slide_object_id: plan.slideObjectId,
    requests: [...deletes, ...moves, ...creates],
    expected,
    groups: plan.groups.map((group) => ({
      group: group.key,
      title: group.title,
      status: group.status,
      added: group.added,
      removed: group.removed.map((face) => face.name),
      moved: group.faces.filter((face) => face.action === "move").length,
      face_size_in: Number(((group.target?.faceW ?? group.metrics?.faceW ?? 0) / EMU_PER_INCH).toFixed(3)),
    })),
  };
}

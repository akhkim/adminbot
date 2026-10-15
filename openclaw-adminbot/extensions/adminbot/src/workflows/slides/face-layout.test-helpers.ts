// A synthetic stand-in for the "Scaling to 50-100 Technical Members" slide: six rounded boxes,
// a heading in each, and rows of square photos about 0.55 in across. Made-up members and
// example.com photo URLs only -- nothing here is read from the real deck.
import type { AdminBotLabMember } from "../../contracts/actions.js";
import {
  EMU_PER_INCH,
  type SlidesFaceRequest,
  type SlidesPageElement,
  type SlidesPresentation,
} from "../../contracts/google-slides.js";
import { faceObjectId, WORKING_GROUP_BOXES } from "./working-groups.js";

export const SLIDE_W = 10 * EMU_PER_INCH;
export const SLIDE_H = 5.625 * EMU_PER_INCH;
export const SLIDE_ID = "g_scaling_slide";
const inch = (value: number) => Math.round(value * EMU_PER_INCH);
// The photos are inserted at 2 in and scaled down, the way a dragged-in image usually is, so a
// test that only worked when scale was 1 would fail here.
const INTRINSIC = inch(2);

export const THEME_TOPIC: Record<string, string> = {
  interp: "Mechanistic interpretability",
  adversarial: "Adversarial robustness",
  multiagent: "Multi-agent systems",
  control: "Loss of control",
  causality: "Causal inference",
};

export function syntheticMember(
  id: string,
  groupKey: string,
  overrides: Partial<AdminBotLabMember> = {},
): AdminBotLabMember {
  return {
    id,
    name: `Member ${id}`,
    member_type: "full",
    research_topics: [THEME_TOPIC[groupKey] ?? "Something else"],
    avatar_url: `https://example.com/avatars/${id}.png`,
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function boxRect(index: number) {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return { x: inch(0.25 + col * 3.2), y: inch(1 + row * 2.2), w: inch(3.05), h: inch(2.1) };
}

function text(content: string) {
  return { textElements: [{ textRun: { content: `${content}\n` } }] };
}

export type FixtureFace = {
  objectId: string;
  /** Alt text; how a hand-placed face is tied to a member. */
  description?: string;
  /** Override the grid slot. */
  at?: { x: number; y: number; size?: number };
};

export function legacyFace(member: AdminBotLabMember, index: number): FixtureFace {
  return { objectId: `g_photo_${index}_${member.id}`, description: member.name };
}

export function taggedFace(groupKey: string, member: AdminBotLabMember): FixtureFace {
  return { objectId: faceObjectId(groupKey, member.id) };
}

export function image(objectId: string, x: number, y: number, size: number, alt?: string) {
  const scale = size / INTRINSIC;
  return {
    objectId,
    size: {
      width: { magnitude: INTRINSIC, unit: "EMU" },
      height: { magnitude: INTRINSIC, unit: "EMU" },
    },
    transform: { scaleX: scale, scaleY: scale, translateX: x, translateY: y, unit: "EMU" },
    ...(alt ? { description: alt } : {}),
    image: {
      contentUrl: `https://lh3.example.com/${objectId}`,
      imageProperties: { cropProperties: { leftOffset: 0.05, rightOffset: 0.05 } },
    },
  } satisfies SlidesPageElement;
}

/**
 * Lays the faces out the way the slide does today: 0.55 in photos, 0.1 in apart, rows centred
 * under the heading, four to a row -- and spilling out of the bottom of the box once there are
 * more than eight, which is the problem this sync exists to fix.
 */
export function syntheticDeck(faces: Record<string, readonly FixtureFace[]>): SlidesPresentation {
  const elements: SlidesPageElement[] = [
    {
      objectId: "g_slide_title",
      size: { width: { magnitude: inch(9), unit: "EMU" }, height: { magnitude: inch(0.6), unit: "EMU" } },
      transform: { scaleX: 1, scaleY: 1, translateX: inch(0.5), translateY: inch(0.2), unit: "EMU" },
      shape: { shapeType: "TEXT_BOX", placeholder: { type: "TITLE" }, text: text("Scaling to 50-100 Technical Members") },
    },
  ];
  const photos: SlidesPageElement[] = [];
  WORKING_GROUP_BOXES.forEach((box, index) => {
    const rect = boxRect(index);
    elements.push({
      objectId: `g_box_${box.key}`,
      size: { width: { magnitude: rect.w, unit: "EMU" }, height: { magnitude: rect.h, unit: "EMU" } },
      transform: { scaleX: 1, scaleY: 1, translateX: rect.x, translateY: rect.y, unit: "EMU" },
      shape: { shapeType: "ROUND_RECTANGLE" },
    });
    // Headings are their own text boxes in points, as the editor makes them.
    elements.push({
      objectId: `g_heading_${box.key}`,
      size: { width: { magnitude: (rect.w - inch(0.2)) / 12_700, unit: "PT" }, height: { magnitude: 21.6, unit: "PT" } },
      transform: { scaleX: 1, scaleY: 1, translateX: rect.x + inch(0.1), translateY: rect.y + inch(0.05), unit: "EMU" },
      shape: { shapeType: "TEXT_BOX", text: text(box.title) },
    });
    const list = faces[box.key] ?? [];
    const size = inch(0.55);
    const gap = inch(0.1);
    const columns = 4;
    const top = rect.y + inch(0.45);
    list.forEach((face, faceIndex) => {
      const row = Math.floor(faceIndex / columns);
      const rowLength = Math.min(columns, list.length - row * columns);
      const left = rect.x + (rect.w - (rowLength * size + (rowLength - 1) * gap)) / 2;
      const x = face.at?.x ?? Math.round(left + (faceIndex % columns) * (size + gap));
      const y = face.at?.y ?? Math.round(top + row * (size + gap));
      photos.push(image(face.objectId, x, y, face.at?.size ?? size, face.description));
    });
  });
  return {
    presentationId: "deck_synthetic",
    revisionId: "rev1",
    pageSize: {
      width: { magnitude: SLIDE_W, unit: "EMU" },
      height: { magnitude: SLIDE_H, unit: "EMU" },
    },
    slides: [
      { objectId: "g_cover", pageElements: [] },
      { objectId: SLIDE_ID, pageElements: [...elements, ...photos] },
    ],
  };
}

/** Plays a batchUpdate onto the fixture the way Slides would, so a second run can be planned. */
export function applyRequests(
  deck: SlidesPresentation,
  requests: readonly SlidesFaceRequest[],
): SlidesPresentation {
  const next = structuredClone(deck);
  for (const slide of next.slides ?? []) {
    for (const request of requests) {
      if ("deleteObject" in request) {
        slide.pageElements = (slide.pageElements ?? []).filter(
          (element) => element.objectId !== request.deleteObject.objectId,
        );
      } else if ("updatePageElementTransform" in request) {
        const element = slide.pageElements?.find(
          (candidate) => candidate.objectId === request.updatePageElementTransform.objectId,
        );
        if (element) {
          element.transform = { ...request.updatePageElementTransform.transform };
        }
      } else if (request.createImage.elementProperties.pageObjectId === slide.objectId) {
        const { size, transform } = request.createImage.elementProperties;
        slide.pageElements = [
          ...(slide.pageElements ?? []),
          {
            objectId: request.createImage.objectId,
            size,
            transform: { ...transform },
            image: { contentUrl: "https://lh3.example.com/new", sourceUrl: request.createImage.url },
          },
        ];
      }
    }
  }
  return next;
}

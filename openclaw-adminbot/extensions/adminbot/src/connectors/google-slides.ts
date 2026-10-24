// Applying an approved working-groups plan to the deck: re-check it, render the new faces round,
// host them just long enough for Slides to copy them, and send the one batchUpdate. Google is
// reached only through the injected client and face host (gog in production, fakes in tests).

import type { AdminBotStoredProposal } from "../contracts/actions.js";
import type {
  AdminBotSlidesWorkingGroupsPayload,
  GoogleSlidesClient,
  SlidesFaceRequest,
  SlidesPresentation,
  SlidesWorkingGroupsSource,
} from "../contracts/google-slides.js";
import type { AdminBotActionExecutor } from "../kernel/service.js";
import { flattenSlide, type Rect } from "../workflows/slides/face-layout-measure.js";
import { POSITION_TOLERANCE_EMU } from "../workflows/slides/face-layout-plan.js";
import {
  DEFAULT_WORKING_GROUPS_SLIDE_TITLE,
  parseFaceObjectId,
  parseFaceOwnerTag,
} from "../workflows/slides/working-groups.js";
import {
  createGogDriveFaceHost,
  createGogSlidesCapture,
  createGogSlidesClient,
  type FaceHost,
  type GogCapture,
  type PublishedFace,
} from "./gog-slides.js";
import { createRoundFaceRenderer, fetchAvatar, type RoundFaceRenderer } from "./slides-face-image.js";

/** Turns a member's avatar into a round PNG at a URL Slides can fetch, for one batchUpdate. */
export type FacePipeline = {
  fetchAvatar(url: string): Promise<Uint8Array>;
  render: RoundFaceRenderer;
  host: FaceHost;
};

function requirePayload(proposal: AdminBotStoredProposal): AdminBotSlidesWorkingGroupsPayload {
  const payload = proposal.proposed_payload as Partial<AdminBotSlidesWorkingGroupsPayload> | null;
  if (
    !payload ||
    typeof payload.presentation_id !== "string" ||
    typeof payload.slide_object_id !== "string" ||
    !Array.isArray(payload.requests) ||
    !Array.isArray(payload.expected) ||
    !Array.isArray(payload.faces)
  ) {
    throw new Error(
      "slides.sync_working_groups requires presentation_id, slide_object_id, requests, expected and faces",
    );
  }
  return payload as AdminBotSlidesWorkingGroupsPayload;
}

function requestKind(request: SlidesFaceRequest): string {
  const keys = Object.keys(request);
  if (keys.length !== 1) {
    throw new Error("each Slides request must name exactly one operation");
  }
  return keys[0]!;
}

/**
 * Checks the payload only asks for what this action may do: create AdminBot-id faces on the
 * planned slide, tag those same new faces with their member, and delete faces whose planned
 * position it carries. Nothing is ever moved, and anything else -- a text edit, a transform, a
 * create on another slide -- is refused before Google is asked, whatever the approver signed.
 */
function validateRequests(payload: AdminBotSlidesWorkingGroupsPayload): void {
  const expected = new Set(payload.expected.map((entry) => entry.object_id));
  const faces = new Map(payload.faces.map((face) => [face.object_id, face]));
  const created = new Set<string>();
  for (const request of payload.requests) {
    const kind = requestKind(request);
    if (kind === "createImage" && "createImage" in request) {
      const create = request.createImage;
      if (!parseFaceObjectId(create.objectId)) {
        throw new Error(`refusing to create ${create.objectId}: not an AdminBot face id`);
      }
      if (create.elementProperties.pageObjectId !== payload.slide_object_id) {
        throw new Error(`refusing to create ${create.objectId} on another slide`);
      }
      const face = faces.get(create.objectId);
      if (!face || face.avatar_url !== create.url || !/^https:\/\//u.test(create.url)) {
        throw new Error(`refusing to create ${create.objectId}: its photo is not the one listed in faces`);
      }
      created.add(create.objectId);
    } else if (kind === "updatePageElementAltText" && "updatePageElementAltText" in request) {
      const alt = request.updatePageElementAltText;
      if (!created.has(alt.objectId)) {
        throw new Error(`refusing to relabel ${alt.objectId}: only faces created in this batch are labelled`);
      }
      if (parseFaceOwnerTag(alt.description) !== faces.get(alt.objectId)?.member_id) {
        throw new Error(`refusing to label ${alt.objectId}: its tag does not name the planned member`);
      }
    } else if (kind === "deleteObject" && "deleteObject" in request) {
      if (!expected.has(request.deleteObject.objectId)) {
        throw new Error(`refusing to delete ${request.deleteObject.objectId}: not planned`);
      }
    } else {
      throw new Error(
        `refusing Slides request "${kind}": only createImage, updatePageElementAltText and deleteObject are allowed`,
      );
    }
  }
  if (created.size !== payload.faces.length) {
    throw new Error("faces and createImage requests do not match");
  }
}

const overlaps = (a: Rect, b: Rect) =>
  a.x + POSITION_TOLERANCE_EMU < b.x + b.w &&
  b.x + POSITION_TOLERANCE_EMU < a.x + a.w &&
  a.y + POSITION_TOLERANCE_EMU < b.y + b.h &&
  b.y + POSITION_TOLERANCE_EMU < a.y + a.h;

/**
 * Whether the slide still looks the way it did when the plan was made.
 *
 * Per object rather than `requiredRevisionId`: the deck is edited by hand all week, and pinning
 * the revision would refuse every approval made after somebody fixed a typo on another slide. What
 * matters is that faces being deleted are still ours and where the approver saw them, and that
 * nobody has since put an image where a new face is about to go.
 */
function staleReason(
  presentation: SlidesPresentation,
  payload: AdminBotSlidesWorkingGroupsPayload,
): string | null {
  const slide = presentation.slides?.find((page) => page.objectId === payload.slide_object_id);
  if (!slide) {
    return `slide ${payload.slide_object_id} no longer exists`;
  }
  const flat = flattenSlide(slide);
  const byId = new Map(flat.map((entry) => [entry.element.objectId, entry]));
  const deleting = new Set(payload.expected.map((entry) => entry.object_id));
  for (const entry of payload.expected) {
    const current = byId.get(entry.object_id);
    if (!current?.element.image || current.grouped) {
      return `${entry.object_id} is no longer a loose image on the slide`;
    }
    if (!parseFaceObjectId(entry.object_id) && !parseFaceOwnerTag(current.element.description)) {
      return `${entry.object_id} no longer carries the AdminBot tag`;
    }
    if (
      Math.abs(current.rect.x - entry.translate_x) > POSITION_TOLERANCE_EMU ||
      Math.abs(current.rect.y - entry.translate_y) > POSITION_TOLERANCE_EMU
    ) {
      return `${entry.object_id} has been moved since the plan was made`;
    }
  }
  const allIds = new Set(
    (presentation.slides ?? []).flatMap((page) => flattenSlide(page).map((entry) => entry.element.objectId)),
  );
  const images = flat.filter((entry) => entry.element.image && !deleting.has(entry.element.objectId));
  for (const request of payload.requests) {
    if (!("createImage" in request)) {
      continue;
    }
    const create = request.createImage;
    if (allIds.has(create.objectId)) {
      return `${create.objectId} already exists`;
    }
    const props = create.elementProperties;
    const rect = {
      x: props.transform.translateX,
      y: props.transform.translateY,
      w: props.size.width.magnitude,
      h: props.size.height.magnitude,
    };
    const blocker = images.find((entry) => overlaps(entry.rect, rect));
    if (blocker) {
      return `an image (${blocker.element.objectId}) now sits where a new face would go`;
    }
  }
  return null;
}

type Rendered = { objectId: string; published: PublishedFace };

/**
 * Renders and hosts every new face, skipping (and reporting) any whose photo cannot be fetched or
 * read: one broken avatar should not hold up everybody else in the batch.
 */
async function publishFaces(
  payload: AdminBotSlidesWorkingGroupsPayload,
  pipeline: FacePipeline,
  hosted: Rendered[],
): Promise<string[]> {
  const failed: string[] = [];
  for (const face of payload.faces) {
    try {
      const avatar = await pipeline.fetchAvatar(face.avatar_url);
      const png = await pipeline.render(avatar, face.ring);
      const published = await pipeline.host.publish(png, `${face.object_id}.png`);
      hosted.push({ objectId: face.object_id, published });
    } catch (error) {
      failed.push(`${face.member_id} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return failed;
}

function withHostedUrls(requests: readonly SlidesFaceRequest[], hosted: readonly Rendered[]): SlidesFaceRequest[] {
  const urls = new Map(hosted.map((face) => [face.objectId, face.published.url]));
  const keep = (objectId: string) => urls.has(objectId);
  return requests.flatMap((request): SlidesFaceRequest[] => {
    if ("createImage" in request) {
      const url = urls.get(request.createImage.objectId);
      return url ? [{ createImage: { ...request.createImage, url } }] : [];
    }
    if ("updatePageElementAltText" in request) {
      return keep(request.updatePageElementAltText.objectId) ? [request] : [];
    }
    return [request];
  });
}

export function createGoogleSlidesExecutor(options: {
  client: GoogleSlidesClient;
  /** Required to add faces; a plan that only deletes can run without it. */
  faces?: FacePipeline;
  // Kill switch, off by default like every connector that writes somewhere shared: a new
  // deployment shows its plans for a cycle before it can touch the deck. ADMINBOT_SLIDES_WRITE=1.
  write?: boolean;
}): AdminBotActionExecutor {
  return {
    async execute(proposal) {
      if (proposal.type !== "slides.sync_working_groups") {
        return { handled: false };
      }
      const payload = requirePayload(proposal);
      validateRequests(payload);
      if (!payload.requests.length) {
        return { handled: true };
      }
      if (!options.write) {
        return {
          handled: true,
          delivered: false,
          reason: "planned and validated, but not applied: ADMINBOT_SLIDES_WRITE is not set to 1",
        };
      }
      if (payload.faces.length && !options.faces) {
        throw new Error("new faces need a face host; set ADMINBOT_SLIDES_FACE_FOLDER_ID");
      }
      const current = await options.client.getPresentation(payload.presentation_id);
      const stale = staleReason(current, payload);
      if (stale) {
        return {
          handled: true,
          delivered: false,
          reason: `the slide changed since this was planned (${stale}); run the preview again`,
        };
      }
      const hosted: Rendered[] = [];
      const releaseErrors: string[] = [];
      let failed: string[] = [];
      try {
        failed = options.faces ? await publishFaces(payload, options.faces, hosted) : [];
        const requests = withHostedUrls(payload.requests, hosted);
        if (!requests.length) {
          return { handled: true, delivered: false, reason: `no face could be rendered: ${failed.join("; ")}` };
        }
        await options.client.batchUpdate(payload.presentation_id, requests);
      } finally {
        // Slides has copied the pixels by the time batchUpdate returns (or failed); either way the
        // public link goes, so a face is never readable by link for longer than one request.
        for (const face of hosted) {
          try {
            await face.published.release();
          } catch (error) {
            releaseErrors.push(error instanceof Error ? error.message : String(error));
          }
        }
      }
      // `reason` is only read for undelivered outcomes, so partial trouble rides in artifacts,
      // which the audit trail keeps alongside the deck link.
      return {
        handled: true,
        artifacts: {
          presentation: `https://docs.google.com/presentation/d/${payload.presentation_id}/edit#slide=id.${payload.slide_object_id}`,
          ...(failed.length ? { faces_not_added: failed.join("; ") } : {}),
          ...(releaseErrors.length ? { link_sharing_not_removed: releaseErrors.join("; ") } : {}),
        },
      };
    },
  };
}

/**
 * The working-groups sync as the environment configures it, or undefined when no deck is named.
 *
 * Both halves come from one place so the read side (planning) and the write side (the executor)
 * can never act as different Google accounts: both are gog as GOG_ACCOUNT, the account every other
 * AdminBot Google action already uses, and the deck is shared with that account as an editor.
 */
export function slidesWorkingGroupsFromEnv(
  env: NodeJS.ProcessEnv,
  options: { capture?: GogCapture; render?: RoundFaceRenderer; fetch?: typeof fetch } = {},
): { source: SlidesWorkingGroupsSource; executor: AdminBotActionExecutor } | undefined {
  const presentationId = env.ADMINBOT_SLIDES_WORKING_GROUPS_PRESENTATION_ID?.trim();
  if (!presentationId) {
    return undefined;
  }
  const account = env.GOG_ACCOUNT?.trim();
  if (!account) {
    throw new Error("ADMINBOT_SLIDES_WORKING_GROUPS_PRESENTATION_ID is set but GOG_ACCOUNT is not");
  }
  const capture = options.capture ?? createGogSlidesCapture(env);
  const scope = env.ADMINBOT_SLIDES_GOG_SCOPE?.trim();
  const gog = { account, capture, ...(scope ? { scope } : {}) };
  const client = createGogSlidesClient(gog);
  const folderId = env.ADMINBOT_SLIDES_FACE_FOLDER_ID?.trim();
  const faces: FacePipeline | undefined = folderId
    ? {
        fetchAvatar: (url) => fetchAvatar(url, options.fetch),
        render: options.render ?? createRoundFaceRenderer(),
        host: createGogDriveFaceHost({ ...gog, folderId }),
      }
    : undefined;
  const debounce = Number(env.ADMINBOT_SLIDES_DEBOUNCE_MS);
  const write = env.ADMINBOT_SLIDES_WRITE === "1";
  // Auto-apply without writes would mark plans executed that never reached the deck, and every
  // run would then plan the same faces again: refuse the combination at startup instead.
  const autoApply = env.ADMINBOT_SLIDES_AUTO_APPLY === "1";
  if (autoApply && !write) {
    throw new Error("ADMINBOT_SLIDES_AUTO_APPLY=1 needs ADMINBOT_SLIDES_WRITE=1");
  }
  if (autoApply && !faces) {
    throw new Error("ADMINBOT_SLIDES_AUTO_APPLY=1 needs ADMINBOT_SLIDES_FACE_FOLDER_ID");
  }
  return {
    source: {
      presentationId,
      slideTitle: env.ADMINBOT_SLIDES_WORKING_GROUPS_SLIDE_TITLE?.trim() || DEFAULT_WORKING_GROUPS_SLIDE_TITLE,
      client,
      ...(env.ADMINBOT_SLIDES_ALLOW_REMOVALS === "1" ? { allowRemovals: true } : {}),
      ...(autoApply ? { autoApply: true } : {}),
      ...(Number.isFinite(debounce) && debounce > 0 ? { debounceMs: debounce } : {}),
    },
    executor: createGoogleSlidesExecutor({
      client,
      write,
      ...(faces ? { faces } : {}),
    }),
  };
}

/**
 * chat.send subhandler: inbound media.
 *
 * Attachments are persisted to the media store before dispatch so the agent turn
 * references stable ids rather than request-scoped buffers, and path offloads are
 * prestaged into the agent workspace. PDFs are the exception the branching here
 * exists for: a managed inbound PDF ref is passed through rather than restaged.
 */
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import {
  type StageSandboxMediaResult,
  stageSandboxMedia,
} from "../../auto-reply/reply/stage-sandbox-media.js";
import type { MsgContext, TemplateContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types/openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { parseInboundMediaUri } from "../../media/media-reference.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import {
  MEDIA_MAX_BYTES,
  type SavedMedia,
  deleteMediaBuffer,
  saveMediaBuffer,
} from "../../media/store.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.js";
import {
  type ChatImageContent,
  MediaOffloadError,
  type OffloadedRef,
  UnsupportedAttachmentError,
} from "../chat-attachments.js";
import { formatForLog } from "../ws-log.js";
import { isAcpBridgeClient } from "./chat.send-origin.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

export async function persistChatSendImages(params: {
  images: ChatImageContent[];
  imageOrder: PromptImageOrderEntry[];
  offloadedRefs: OffloadedRef[];
  client: GatewayRequestHandlerOptions["client"];
  logGateway: GatewayRequestContext["logGateway"];
}): Promise<SavedMedia[]> {
  if (
    (params.images.length === 0 && params.offloadedRefs.length === 0) ||
    isAcpBridgeClient(params.client)
  ) {
    return [];
  }
  const inlineSaved: SavedMedia[] = [];
  for (const img of params.images) {
    try {
      inlineSaved.push(
        await saveMediaBuffer(Buffer.from(img.data, "base64"), img.mimeType, "inbound"),
      );
    } catch (err) {
      params.logGateway.warn(
        `chat.send: failed to persist inbound image (${img.mimeType}): ${formatForLog(err)}`,
      );
    }
  }
  // imageOrder now only tracks image slots (see chat-attachments.ts), so split
  // offloaded refs by mime: image offloads interleave with inline images via
  // imageOrder, and non-image offloads append to the transcript tail. Without
  // this split a non-image file would consume the next image slot whenever
  // both kinds appear in the same request.
  const imageOffloadedSaved: SavedMedia[] = [];
  const nonImageOffloadedSaved: SavedMedia[] = [];
  for (const ref of params.offloadedRefs) {
    const entry: SavedMedia = {
      id: ref.id,
      path: ref.path,
      size: 0,
      contentType: ref.mimeType,
    };
    if (ref.mimeType.startsWith("image/")) {
      imageOffloadedSaved.push(entry);
    } else {
      nonImageOffloadedSaved.push(entry);
    }
  }
  if (params.imageOrder.length === 0) {
    return [...inlineSaved, ...imageOffloadedSaved, ...nonImageOffloadedSaved];
  }
  const saved: SavedMedia[] = [];
  let inlineIndex = 0;
  let offloadedIndex = 0;
  for (const entry of params.imageOrder) {
    if (entry === "inline") {
      const inline = inlineSaved[inlineIndex++];
      if (inline) {
        saved.push(inline);
      }
      continue;
    }
    const offloaded = imageOffloadedSaved[offloadedIndex++];
    if (offloaded) {
      saved.push(offloaded);
    }
  }
  for (; inlineIndex < inlineSaved.length; inlineIndex++) {
    const inline = inlineSaved[inlineIndex];
    if (inline) {
      saved.push(inline);
    }
  }
  for (; offloadedIndex < imageOffloadedSaved.length; offloadedIndex++) {
    const offloaded = imageOffloadedSaved[offloadedIndex];
    if (offloaded) {
      saved.push(offloaded);
    }
  }
  for (const offloaded of nonImageOffloadedSaved) {
    saved.push(offloaded);
  }
  return saved;
}

export function stripTrailingOffloadedMediaMarkers(message: string, refs: OffloadedRef[]): string {
  if (refs.length === 0) {
    return message;
  }
  const removableRefs = new Set(refs.map((ref) => ref.mediaRef));
  const lines = message.split(/\r?\n/);
  while (lines.length > 0) {
    const last = lines[lines.length - 1]?.trim() ?? "";
    const match = /^\[media attached:\s*(media:\/\/inbound\/[^\]\s]+)\]$/.exec(last);
    if (!match?.[1] || !removableRefs.delete(match[1])) {
      break;
    }
    lines.pop();
  }
  return lines.join("\n").trimEnd();
}

export function isPdfOffloadedRef(ref: OffloadedRef): boolean {
  const mime = ref.mimeType.trim().toLowerCase();
  if (mime === "application/pdf" || mime.endsWith("+pdf")) {
    return true;
  }
  return path.extname(ref.path.split(/[?#]/u)[0] ?? "").toLowerCase() === ".pdf";
}

// A managed inbound PDF saved to the media store is safe to hand the agent as its
// media path without sandbox staging: host-side media-understanding extracts its
// text (see resolveFileExtractionLimits) by reading the media-store root, so even
// locked-down agents receive the document. This gates both the up-front bypass for
// oversized PDFs and the fallback to the managed path when sandbox staging fails
// for an already-managed PDF. #90097
export function isManagedInboundPdfOffloadRef(ref: OffloadedRef): boolean {
  if (!isPdfOffloadedRef(ref)) {
    return false;
  }
  try {
    return parseInboundMediaUri(ref.mediaRef) !== null;
  } catch {
    return false;
  }
}

// Oversized managed PDFs skip sandbox staging up front: copying a large PDF into
// every sandbox is wasteful, and files above the 5MB staging cap would otherwise
// be rejected as a 4xx (see prestageMediaPathOffloads).
export function shouldPassThroughManagedInboundPdfOffloadRef(ref: OffloadedRef): boolean {
  return ref.sizeBytes > MEDIA_MAX_BYTES && isManagedInboundPdfOffloadRef(ref);
}

// Stages media-path offloads into the agent sandbox synchronously so chat.send
// can surface 5xx before respond(). Throws MediaOffloadError when staging fails
// for a ref that cannot fall back (ENOSPC / EPERM / partial-stage of a non-PDF or
// unmanaged ref) so the outer chat.send handler maps it to UNAVAILABLE (5xx);
// plain Error would be misclassified as 4xx. Already-managed inbound PDFs instead
// fall back to their managed media path on staging failure (#90097), since
// host-side media-understanding reads them from the media-store root. Offloaded
// refs are cleaned up from the media store before rethrow.
// Callers MUST set ctx.MediaStaged=true when this runs so the dispatch
// pipeline skips its own stageSandboxMedia pass.
//
// Returned paths are absolute media-store paths when no sandbox is active, for
// oversized managed PDFs that bypass staging, or for already-managed PDFs that
// fall back when staging fails (#90097); files staged into the sandbox use
// sandbox-relative paths plus `workspaceDir`. Host-side media-understanding
// resolves both via MediaWorkspaceDir and the media-store root.
export async function prestageMediaPathOffloads(params: {
  offloadedRefs: OffloadedRef[];
  includeImageRefs?: boolean;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
}): Promise<{ paths: string[]; types: string[]; workspaceDir?: string }> {
  const mediaPathRefs = params.offloadedRefs.filter(
    (ref) => params.includeImageRefs || !ref.mimeType.startsWith("image/"),
  );
  if (mediaPathRefs.length === 0) {
    return { paths: [], types: [] };
  }
  const refsByManagedPath = (refs: OffloadedRef[]) => ({
    paths: refs.map((ref) => ref.path),
    types: refs.map((ref) => ref.mimeType),
  });

  // Oversized managed PDFs bypass sandbox staging and are read host-side, so they
  // do not need a workspace copy or the staging-cap check below.
  const passThroughRefs: OffloadedRef[] = [];
  const refsToStage: OffloadedRef[] = [];
  for (const ref of mediaPathRefs) {
    (shouldPassThroughManagedInboundPdfOffloadRef(ref) ? passThroughRefs : refsToStage).push(ref);
  }
  if (refsToStage.length === 0) {
    return refsByManagedPath(mediaPathRefs);
  }

  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const sandbox = await ensureSandboxWorkspaceForSession({
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir,
    });
    if (!sandbox) {
      return refsByManagedPath(mediaPathRefs);
    }

    // stageSandboxMedia caps each file at STAGED_MEDIA_MAX_BYTES (=
    // MEDIA_MAX_BYTES, 5MB) and silently skips oversized files. The parse cap
    // (resolveChatAttachmentMaxBytes, default 20MB) is higher, so a sandboxed
    // session receiving a non-PDF file between the two caps would otherwise
    // pass parse, fail staging, and surface as a retryable 5xx even though
    // retry cannot succeed. Reject here as a client-side 4xx instead. Managed
    // PDFs in that range pass through above instead of being rejected.
    const oversizedForSandbox = refsToStage.filter((ref) => ref.sizeBytes > MEDIA_MAX_BYTES);
    if (oversizedForSandbox.length > 0) {
      const details = oversizedForSandbox
        .map((ref) => `${ref.label} (${ref.sizeBytes} bytes)`)
        .join(", ");
      throw new UnsupportedAttachmentError(
        "non-image-too-large-for-sandbox",
        `attachments exceed sandbox staging limit (${MEDIA_MAX_BYTES} bytes): ${details}`,
      );
    }

    const stagingCtx: MsgContext = {
      MediaPath: refsToStage[0].path,
      MediaPaths: refsToStage.map((ref) => ref.path),
      MediaType: refsToStage[0].mimeType,
      MediaTypes: refsToStage.map((ref) => ref.mimeType),
    };
    let stageResult: StageSandboxMediaResult;
    try {
      stageResult = await stageSandboxMedia({
        ctx: stagingCtx,
        sessionCtx: stagingCtx as TemplateContext,
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        workspaceDir,
      });
    } catch (stageErr) {
      // stageSandboxMedia threw before copying anything (e.g. workspace mkdir
      // ENOSPC/EPERM), so nothing reached the sandbox. Already-managed inbound
      // PDFs still reach the agent via their managed media path (host-side
      // media-understanding reads the media-store root); fail the send only when a
      // ref cannot fall back. #90097
      if (refsToStage.some((ref) => !isManagedInboundPdfOffloadRef(ref))) {
        throw stageErr;
      }
      return refsByManagedPath(mediaPathRefs);
    }

    // stageSandboxMedia silently keeps unstaged entries as their original
    // absolute path, so length parity does not prove every file landed in the
    // sandbox. The RPC max (20MB via resolveChatAttachmentMaxBytes) admits files
    // above the staging cap (STAGED_MEDIA_MAX_BYTES = 5MB); check the returned
    // `staged` map for missing sources. Already-managed inbound PDFs fall back to
    // their absolute managed path (host-side media-understanding reads the
    // media-store root); any other missing source is a 5xx MediaOffloadError the
    // client can retry. #90097
    const stagedSources = stageResult.staged;
    const missing = refsToStage.filter((ref) => !stagedSources.has(ref.path));
    const unstageable = missing.filter((ref) => !isManagedInboundPdfOffloadRef(ref));
    if (unstageable.length > 0) {
      throw new Error(
        `attachment staging incomplete: ${stagedSources.size}/${refsToStage.length} paths staged into sandbox workspace (missing: ${unstageable.map((ref) => ref.path).join(", ")})`,
      );
    }
    const stagedPaths = stagingCtx.MediaPaths ?? [];
    const stagedTypes = stagingCtx.MediaTypes ?? refsToStage.map((ref) => ref.mimeType);

    // Map each ref to its post-staging path. Staged files become sandbox-relative
    // (e.g. `media/inbound/foo.pdf`) so the agent inside the container can read
    // them; pass-through PDFs and managed PDFs that fell back from staging keep
    // their absolute managed path (stagedPaths preserves the absolute path for any
    // unstaged entry). Host-side media-understanding resolves both via
    // ctx.MediaWorkspaceDir plus the media-store root. Preserve attachment order.
    const resolvedByRef = new Map<OffloadedRef, { path: string; mimeType: string }>();
    refsToStage.forEach((ref, index) => {
      resolvedByRef.set(ref, {
        path: stagedPaths[index] ?? ref.path,
        mimeType: stagedTypes[index] ?? ref.mimeType,
      });
    });
    for (const ref of passThroughRefs) {
      resolvedByRef.set(ref, { path: ref.path, mimeType: ref.mimeType });
    }
    const ordered = mediaPathRefs.map(
      (ref) => resolvedByRef.get(ref) ?? { path: ref.path, mimeType: ref.mimeType },
    );
    return {
      paths: ordered.map((entry) => entry.path),
      types: ordered.map((entry) => entry.mimeType),
      workspaceDir: sandbox.workspaceDir,
    };
  } catch (err) {
    await Promise.allSettled(
      params.offloadedRefs.map((ref) => deleteMediaBuffer(ref.id, "inbound")),
    );
    if (err instanceof MediaOffloadError) {
      throw err;
    }
    // Sandbox-oversize rejections are client-side 4xx (see check above). Wrapping
    // them as MediaOffloadError would misclassify them as retryable 5xx.
    if (err instanceof UnsupportedAttachmentError) {
      throw err;
    }
    throw new MediaOffloadError(
      `[Gateway Error] Failed to stage attachments into agent workspace: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }
}

export type ChatSendManagedMediaFields = Partial<
  Pick<MsgContext, "MediaPath" | "MediaPaths" | "MediaType" | "MediaTypes">
>;

export function resolveChatSendManagedMediaFields(
  savedImages: SavedMedia[],
): ChatSendManagedMediaFields {
  const mediaPaths = savedImages.map((entry) => entry.path);
  if (mediaPaths.length === 0) {
    return {};
  }
  const mediaTypes = savedImages.map((entry) => entry.contentType ?? "application/octet-stream");
  return {
    MediaPath: mediaPaths[0],
    MediaPaths: mediaPaths,
    MediaType: mediaTypes[0],
    MediaTypes: mediaTypes,
  };
}

export function applyChatSendManagedMediaFields(
  ctx: MsgContext,
  fields: ChatSendManagedMediaFields,
) {
  if (!ctx.MediaStaged) {
    Object.assign(ctx, fields);
    return;
  }

  if (ctx.MediaPath === undefined && fields.MediaPath !== undefined) {
    ctx.MediaPath = fields.MediaPath;
  }
  if (ctx.MediaPaths === undefined && fields.MediaPaths !== undefined) {
    ctx.MediaPaths = fields.MediaPaths;
  }
  if (ctx.MediaType === undefined && fields.MediaType !== undefined) {
    ctx.MediaType = fields.MediaType;
  }
  if (ctx.MediaTypes === undefined && fields.MediaTypes !== undefined) {
    ctx.MediaTypes = fields.MediaTypes;
  }
}

export function buildChatSendUserTurnMedia(
  savedMedia: SavedMedia[],
): NonNullable<UserTurnInput["media"]> {
  return savedMedia.map((entry) => ({
    path: entry.path,
    contentType: entry.contentType,
  }));
}

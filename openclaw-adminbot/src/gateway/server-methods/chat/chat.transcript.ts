/**
 * chat subhandler: transcript persistence.
 *
 * Everything that reads or appends the on-disk session transcript, including the
 * idempotency-key and metadata lookups that make an append safe to retry, and the
 * partial-output snapshots an aborted run leaves behind. Reply payloads are
 * rendered to transcript text here rather than at the delivery boundary, so the
 * stored turn keeps its directive tags and attachment lines.
 */
import fs from "node:fs";
import path from "node:path";
import { isAudioFileName } from "@openclaw/media-core/mime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { type ReplyPayload, getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { resolveSessionFilePath, updateSessionStoreEntry } from "../../../config/sessions.js";
import { resolveMirroredTranscriptText } from "../../../config/sessions/transcript-mirror.js";
import { CURRENT_SESSION_VERSION } from "../../../config/sessions/version.js";
import type { OpenClawConfig } from "../../../config/types/openclaw.js";
import {
  parseInlineDirectives,
  sanitizeReplyDirectiveId,
  stripInlineDirectiveTagsForDelivery,
} from "../../../shared/directive-tags.js";
import type { ChatAbortControllerEntry } from "../../chat-abort.js";
import { isSuppressedControlReplyText } from "../../control/control-reply-text.js";
import { readSessionTranscriptIndex } from "../../sessions/session-transcript-index.fs.js";
import { loadSessionEntry } from "../../sessions/session-utils.js";
import {
  type GatewayInjectedTtsSupplementMarker,
  appendInjectedAssistantMessageToTranscript,
} from "./chat-transcript-inject.js";
import type { AbortOrigin } from "./chat.run-abort.js";
import { isMediaBearingPayload } from "./chat.tts-supplement.js";
import type { GatewayRequestContext } from "../types.js";

export type TranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

export type AbortedPartialSnapshot = {
  runId: string;
  sessionId: string;
  agentId?: string;
  text: string;
  abortOrigin: AbortOrigin;
};

export type SideResultPayload = {
  kind: "btw";
  runId: string;
  sessionKey: string;
  agentId?: string;
  question: string;
  text: string;
  isError?: boolean;
  ts: number;
};

export function buildTranscriptReplyText(payloads: ReplyPayload[]): string {
  const chunks = payloads
    .map((payload) => {
      if (payload.isReasoning === true) {
        return "";
      }
      const parts = resolveSendableOutboundReplyParts(payload);
      const lines: string[] = [];
      const parsedText = payload.text?.includes("[[")
        ? parseInlineDirectives(payload.text)
        : undefined;
      const replyToId =
        sanitizeReplyDirectiveId(payload.replyToId) ??
        sanitizeReplyDirectiveId(parsedText?.replyToExplicitId);
      if (replyToId) {
        lines.push(`[[reply_to:${replyToId}]]`);
      } else if (payload.replyToCurrent || parsedText?.replyToCurrent) {
        lines.push("[[reply_to_current]]");
      }
      const text = payload.text
        ? stripInlineDirectiveTagsForDelivery(payload.text).text.trim()
        : "";
      if (text && !isSuppressedControlReplyText(text)) {
        lines.push(text);
      }
      for (const mediaUrl of parts.mediaUrls) {
        if (payload.sensitiveMedia === true) {
          continue;
        }
        const trimmed = mediaUrl.trim();
        if (trimmed) {
          lines.push(`Attachment: ${trimmed}`);
        }
      }
      if (
        (payload.audioAsVoice || parsedText?.audioAsVoice) &&
        parts.mediaUrls.some((mediaUrl) => isAudioFileName(mediaUrl))
      ) {
        lines.push("[[audio_as_voice]]");
      }
      return lines.join("\n").trim();
    })
    .filter(Boolean);
  return chunks.join("\n\n").trim();
}

export function hasSensitiveMediaPayload(payloads: ReplyPayload[]): boolean {
  return payloads.some(
    (payload) => payload.sensitiveMedia === true && isMediaBearingPayload(payload),
  );
}

export function resolveTranscriptPath(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
}): string | null {
  const { sessionId, storePath, sessionFile, agentId } = params;
  if (!storePath && !sessionFile) {
    return null;
  }
  try {
    const sessionsDir = storePath ? path.dirname(storePath) : undefined;
    return resolveSessionFilePath(
      sessionId,
      sessionFile ? { sessionFile } : undefined,
      sessionsDir || agentId ? { sessionsDir, agentId } : undefined,
    );
  } catch {
    return null;
  }
}

export function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  if (fs.existsSync(params.transcriptPath)) {
    return { ok: true };
  }
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function findAssistantTranscriptMessageByIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<{ messageId: string; message: Record<string, unknown> } | null> {
  const trimmedIdempotencyKey = idempotencyKey.trim();
  if (!trimmedIdempotencyKey) {
    return null;
  }
  const index = await readSessionTranscriptIndex(transcriptPath, { view: "all" });
  const target = index?.entries.toReversed().find((entry) => {
    const message = entry.record.message as Record<string, unknown> | undefined;
    return message?.role === "assistant" && message.idempotencyKey === trimmedIdempotencyKey;
  });
  const message = target?.record.message as Record<string, unknown> | undefined;
  if (!target || !message) {
    return null;
  }
  return { messageId: target.id ?? trimmedIdempotencyKey, message };
}

export async function findSourceReplyTranscriptMirrorByIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<{ messageId: string; message: Record<string, unknown> } | null> {
  const found = await findAssistantTranscriptMessageByIdempotencyKey(
    transcriptPath,
    idempotencyKey,
  );
  if (found?.message.provider !== "openclaw" || found.message.model !== "delivery-mirror") {
    return null;
  }
  return found;
}

export function extractAssistantTranscriptText(
  message: Record<string, unknown>,
): string | undefined {
  const content = message.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? ((block as { text: string }).text.trim() ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

export async function findSourceReplyTranscriptMirrorByMetadata(params: {
  transcriptPath: string;
  idempotencyKey: string;
  metadata: NonNullable<ReturnType<typeof getReplyPayloadMetadata>>["sourceReplyTranscriptMirror"];
}): Promise<{ messageId: string; message: Record<string, unknown> } | null> {
  const byIdempotencyKey = await findSourceReplyTranscriptMirrorByIdempotencyKey(
    params.transcriptPath,
    params.idempotencyKey,
  );
  if (byIdempotencyKey) {
    return byIdempotencyKey;
  }
  const expectedText = resolveMirroredTranscriptText({
    text: params.metadata?.text,
    mediaUrls: params.metadata?.mediaUrls,
  });
  if (!expectedText) {
    return null;
  }
  const index = await readSessionTranscriptIndex(params.transcriptPath, { view: "all" });
  const target = index?.entries.toReversed().find((entry) => {
    const message = entry.record.message as Record<string, unknown> | undefined;
    return (
      typeof entry.id === "string" &&
      entry.id.trim().length > 0 &&
      message?.role === "assistant" &&
      message.provider === "openclaw" &&
      message.model === "delivery-mirror" &&
      extractAssistantTranscriptText(message) === expectedText
    );
  });
  const message = target?.record.message as Record<string, unknown> | undefined;
  if (!target?.id || !message) {
    return null;
  }
  return { messageId: target.id, message };
}

export async function appendAssistantTranscriptMessage(params: {
  sessionKey: string;
  message: string;
  label?: string;
  content?: Array<Record<string, unknown>>;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  createIfMissing?: boolean;
  idempotencyKey?: string;
  abortMeta?: {
    aborted: true;
    origin: AbortOrigin;
    runId: string;
  };
  ttsSupplement?: GatewayInjectedTtsSupplementMarker;
  cfg?: OpenClawConfig;
}): Promise<TranscriptAppendResult> {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
  });
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  if (params.idempotencyKey) {
    const existing = await findAssistantTranscriptMessageByIdempotencyKey(
      transcriptPath,
      params.idempotencyKey,
    );
    if (existing) {
      return { ok: true, messageId: existing.messageId, message: existing.message };
    }
  }

  const appended = await appendInjectedAssistantMessageToTranscript({
    transcriptPath,
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    message: params.message,
    label: params.label,
    content: params.content,
    idempotencyKey: params.idempotencyKey,
    abortMeta: params.abortMeta,
    ttsSupplement: params.ttsSupplement,
    config: params.cfg,
  });
  if (appended.ok) {
    await advanceSessionTranscriptMarker({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    });
  }
  return appended;
}

export async function advanceSessionTranscriptMarker(params: {
  storePath: string | undefined;
  sessionKey: string;
  sessionId: string;
}): Promise<void> {
  if (!params.storePath) {
    return;
  }

  const transcriptMarkerUpdatedAt = Date.now();
  await updateSessionStoreEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    update: (current) =>
      current.sessionId === params.sessionId ? { updatedAt: transcriptMarkerUpdatedAt } : null,
  });
}

export function collectSessionAbortPartials(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  runIds: ReadonlySet<string>;
  abortOrigin: AbortOrigin;
}): AbortedPartialSnapshot[] {
  const out: AbortedPartialSnapshot[] = [];
  for (const [runId, active] of params.chatAbortControllers) {
    if (!params.runIds.has(runId)) {
      continue;
    }
    const text = params.chatRunBuffers.get(runId);
    if (!text || !text.trim()) {
      continue;
    }
    out.push({
      runId,
      sessionId: active.sessionId,
      agentId: active.agentId,
      text,
      abortOrigin: params.abortOrigin,
    });
  }
  return out;
}

export async function persistAbortedPartials(params: {
  context: Pick<GatewayRequestContext, "logGateway">;
  sessionKey: string;
  snapshots: AbortedPartialSnapshot[];
}): Promise<void> {
  if (params.snapshots.length === 0) {
    return;
  }
  for (const snapshot of params.snapshots) {
    const sessionLoadOptions =
      params.sessionKey === "global" && snapshot.agentId
        ? { agentId: snapshot.agentId }
        : undefined;
    const { cfg, storePath, entry } = loadSessionEntry(params.sessionKey, sessionLoadOptions);
    const sessionId = entry?.sessionId ?? snapshot.sessionId ?? snapshot.runId;
    const appended = await appendAssistantTranscriptMessage({
      sessionKey: params.sessionKey,
      message: snapshot.text,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      ...(snapshot.agentId ? { agentId: snapshot.agentId } : {}),
      createIfMissing: true,
      idempotencyKey: `${snapshot.runId}:assistant`,
      cfg,
      abortMeta: {
        aborted: true,
        origin: snapshot.abortOrigin,
        runId: snapshot.runId,
      },
    });
    if (!appended.ok) {
      params.context.logGateway.warn(
        `chat.abort transcript append failed: ${appended.error ?? "unknown error"}`,
      );
    }
  }
}

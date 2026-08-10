import { createHash } from "node:crypto";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  isReplyPayloadTtsSupplement,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import { formatForLog } from "../ws-log.js";
/**
 * chat subhandler: TTS supplement and webchat media.
 *
 * A TTS supplement carries spoken audio for text the client already displayed, so
 * its visible text is stripped before delivery and the transcript records only a
 * hash of what was shown. The hash is taken over the *projected* display text,
 * not the raw payload, so a later edit to the projection cannot silently
 * invalidate every stored marker.
 */
import type { GatewayInjectedTtsSupplementMarker } from "./chat-transcript-inject.js";
import { buildWebchatAssistantMessageFromReplyPayloads } from "./chat-webchat-media.js";
import {
  type AssistantDisplayContentBlock,
  extractAssistantDisplayTextFromContent,
} from "./chat.assistant-display.js";

/** True when a reply payload carries at least one media reference (mediaUrl or mediaUrls). */
export function isMediaBearingPayload(payload: ReplyPayload): boolean {
  if (payload.isReasoning === true) {
    return false;
  }
  if (payload.mediaUrl?.trim()) {
    return true;
  }
  if (payload.mediaUrls?.some((url) => url.trim())) {
    return true;
  }
  return false;
}

export function stripVisibleTextFromTtsSupplement(payload: ReplyPayload): ReplyPayload {
  return isReplyPayloadTtsSupplement(payload) ? buildTtsSupplementMediaPayload(payload) : payload;
}

export function resolveTtsSupplementMarkerText(text: string): string {
  const trimmed = text.trim();
  const projected = projectChatDisplayMessage(
    {
      role: "assistant",
      content: [{ type: "text", text: trimmed }],
    },
    { maxChars: Number.MAX_SAFE_INTEGER },
  );
  const projectedContent = Array.isArray(projected?.content)
    ? (projected.content as AssistantDisplayContentBlock[])
    : undefined;
  return (
    extractAssistantDisplayTextFromContent(projectedContent) ??
    (typeof projected?.text === "string" ? projected.text.trim() : undefined) ??
    trimmed
  );
}

export function buildTtsSupplementTranscriptMarker(
  payload: ReplyPayload,
): GatewayInjectedTtsSupplementMarker | undefined {
  const supplement = getReplyPayloadTtsSupplement(payload);
  if (!supplement) {
    return undefined;
  }
  const visibleText = resolveTtsSupplementMarkerText(
    payload.text?.trim() || supplement.spokenText.trim(),
  );
  return {
    textSha256: createHash("sha256").update(visibleText).digest("hex"),
  };
}

export function buildMediaOnlyTtsSupplementTranscriptMarker(
  payload: ReplyPayload,
): GatewayInjectedTtsSupplementMarker | undefined {
  if (payload.text?.trim()) {
    return undefined;
  }
  return buildTtsSupplementTranscriptMarker(payload);
}

export function resolveWebchatPromptCacheKey(params: {
  agentId: string;
  model: string;
  provider: string;
  sessionKey: string;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        "v1",
        params.provider.trim().toLowerCase(),
        params.model.trim(),
        normalizeAgentId(params.agentId),
        params.sessionKey,
      ].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return `openclaw-webchat-${digest}`;
}

export async function buildWebchatAssistantMediaMessage(
  payloads: ReplyPayload[],
  options?: {
    localRoots?: readonly string[];
    onLocalAudioAccessDenied?: (message: string) => void;
  },
): Promise<{ content: Array<Record<string, unknown>>; transcriptText: string } | null> {
  return buildWebchatAssistantMessageFromReplyPayloads(payloads, {
    localRoots: options?.localRoots,
    onLocalAudioAccessDenied: (err) => {
      options?.onLocalAudioAccessDenied?.(formatForLog(err));
    },
  });
}

/**
 * Run stage: hook and prompt outcome coercion.
 *
 * Both values crossing back from a hook or a prompt call are untyped at runtime:
 * a hook's reply may be absent (which must still surface as the silent token, not
 * an empty payload list), and a prompt rejection may throw a non-Error. Each is
 * coerced once, here, so the run loop downstream only ever sees its own shapes.
 */
import type { ReplyPayload } from "../../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";

export function buildHandledReplyPayloads(reply?: ReplyPayload) {
  const normalized = reply ?? { text: SILENT_REPLY_TOKEN };
  return [
    {
      text: normalized.text,
      mediaUrl: normalized.mediaUrl,
      mediaUrls: normalized.mediaUrls,
      replyToId: normalized.replyToId,
      audioAsVoice: normalized.audioAsVoice,
      isError: normalized.isError,
      isReasoning: normalized.isReasoning,
    },
  ];
}

export function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

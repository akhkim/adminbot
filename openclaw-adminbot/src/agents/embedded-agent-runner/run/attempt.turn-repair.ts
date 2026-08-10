/**
 * Attempt stage: mid-turn transcript repair.
 *
 * Undoes the artifacts an interrupted turn leaves behind before the next prompt is
 * built — unpaired tool_use/tool_result blocks, and the synthetic assistant error
 * the mid-turn precheck writes, which must be removed from both the in-memory
 * session and the persisted SessionManager entries.
 */
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../shared/transcript-only-openclaw-assistant.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../sessions/session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../../sessions/session-transcript-repair.js";
import { log } from "../logger.js";
import { MID_TURN_PRECHECK_ERROR_MESSAGE } from "./midturn-precheck.js";

export function repairAttemptToolUseResultPairing(
  messages: AgentMessage[],
  isOpenAIResponsesApi: boolean,
): AgentMessage[] {
  return sanitizeToolUseResultPairing(messages, {
    erroredAssistantResultPolicy: "drop",
    ...(isOpenAIResponsesApi ? { missingToolResultText: "aborted" } : {}),
  });
}

export function hasVisiblePendingToolMediaReply(
  reply: { mediaUrls?: string[]; audioAsVoice?: boolean } | null | undefined,
): boolean {
  return Boolean(
    reply &&
    ((reply.mediaUrls ?? []).some((url) => url.trim().length > 0) || reply.audioAsVoice === true),
  );
}

export function isMidTurnPrecheckAssistantError(message: AgentMessage | undefined): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const record = message as unknown as { stopReason?: unknown; errorMessage?: unknown };
  return record.stopReason === "error" && record.errorMessage === MID_TURN_PRECHECK_ERROR_MESSAGE;
}

export function removeTrailingMidTurnPrecheckAssistantError(params: {
  activeSession: { agent: { state: { messages: AgentMessage[] } } };
  sessionManager: ReturnType<typeof guardSessionManager>;
}): void {
  const messages = params.activeSession.agent.state.messages;
  const removedActiveError = isMidTurnPrecheckAssistantError(messages.at(-1));
  if (removedActiveError) {
    params.activeSession.agent.state.messages = messages.slice(0, -1);
  }

  const removedPersistedError =
    params.sessionManager.removeTrailingEntries(
      (entry) => entry.type === "message" && isMidTurnPrecheckAssistantError(entry.message),
      {
        preserveTrailing: (entry) =>
          entry.type === "custom" ||
          entry.type === "label" ||
          entry.type === "session_info" ||
          (entry.type === "message" && isTranscriptOnlyOpenClawAssistantMessage(entry.message)),
      },
    ) > 0;
  if (removedActiveError && !removedPersistedError) {
    log.warn(
      "[context-overflow-midturn-precheck] removed synthetic assistant error from active session but could not locate matching persisted SessionManager entry",
    );
  }
}

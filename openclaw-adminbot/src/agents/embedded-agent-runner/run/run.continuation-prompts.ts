/**
 * Run stage: continuation prompt text.
 *
 * Fixed instructions the run loop prepends when it re-prompts a model that already
 * did work — after a mid-turn precheck, after a compaction that ate the final
 * answer, or after a before-agent-finalize hook asked for a revision. Each one
 * exists to stop the model restarting from scratch or rerunning finished tools.
 */
export const MID_TURN_PRECHECK_CONTINUATION_PROMPT =
  "Continue from the current transcript after the latest tool result. Do not repeat the original user request, and do not rerun completed tools unless the transcript shows they are still needed.";
export const COMPACTION_CONTINUATION_RETRY_INSTRUCTION =
  "The previous attempt compacted the conversation context before producing a final user-visible answer. Continue from the compacted transcript and produce the final answer now. Do not restart from scratch, do not repeat completed work, and do not rerun tools unless the transcript clearly lacks required evidence.";
export const BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX =
  "Before accepting the previous final answer, apply this revision request and produce the revised final answer. Do not repeat completed work or rerun tools unless the request explicitly requires it.";
export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 3;

export function buildBeforeAgentFinalizeRetryPrompt(reason: string): string {
  return `${BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX}\n\n${reason}`;
}

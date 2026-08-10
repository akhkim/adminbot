/**
 * Run stage: the "no real conversation messages" compaction no-op.
 *
 * When the overflow precheck asks for a compaction and the engine reports there
 * was nothing conversational to compact, the stored token snapshot that triggered
 * the precheck was stale. Clearing it is what stops the next turn re-triggering
 * the same precheck, so the reset is deliberately fire-and-forget: a failure is
 * warned and swallowed, since it only costs one redundant precheck.
 */
import { resolveStorePath } from "../../../config/sessions.js";
import { updateSessionEntry } from "../../../config/sessions/session-accessor.js";
import { log } from "../logger.js";
import type { RunEmbeddedAgentParams } from "./params.js";

export const NO_REAL_CONVERSATION_MESSAGES_REASON = "no real conversation messages";

export function isNoRealConversationCompactionNoop(params: {
  ok?: boolean;
  compacted?: boolean;
  reason?: string;
}): boolean {
  return (
    params.ok === true &&
    params.compacted === false &&
    params.reason === NO_REAL_CONVERSATION_MESSAGES_REASON
  );
}

export async function resetNoRealConversationTokenSnapshot(params: {
  config?: RunEmbeddedAgentParams["config"];
  sessionKey?: string;
  agentId?: string;
}): Promise<void> {
  if (!params.sessionKey) {
    return;
  }
  const storePath = resolveStorePath(params.config?.session?.store, { agentId: params.agentId });
  try {
    await updateSessionEntry(
      {
        storePath,
        sessionKey: params.sessionKey,
      },
      async () => ({
        totalTokens: 0,
        totalTokensFresh: true,
        inputTokens: undefined,
        outputTokens: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        contextBudgetStatus: undefined,
        updatedAt: Date.now(),
      }),
      {
        skipMaintenance: true,
        takeCacheOwnership: true,
      },
    );
  } catch (err) {
    log.warn(
      `[context-overflow-precheck] failed to reset stale context snapshot for ` +
        `${params.sessionKey}: ${String(err)}`,
    );
  }
}

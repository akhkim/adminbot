/**
 * Agent-end side effect runner.
 *
 * Harnesses use this to fire plugin `agent_end` hooks either fire-and-forget or awaited during
 * tests and shutdown. It used to also run core skill-research auto-capture, which filed Skill
 * Workshop proposals; that feature is gone, so only the plugin hooks remain.
 */
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

type AgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];

/** Starts agent-end side effects without waiting for completion. */
export function runAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  runAgentHarnessAgentEndHook(params);
}

/** Runs agent-end side effects and waits for plugin completion. */
export async function awaitAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  await awaitAgentHarnessAgentEndHook(params);
}

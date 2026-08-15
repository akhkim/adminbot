import { listAgentIds } from "../../../agents/agent-scope.js";
/**
 * chat subhandler: agent selection.
 *
 * Both chat.send and chat.history accept an optional agentId alongside a session
 * key that may already name an agent. The requested id wins, but it is validated
 * against the configured agents first — a deleted or unknown agent must fail the
 * request rather than silently fall back to the default and write the turn into
 * the wrong agent's transcript.
 */
import type { OpenClawConfig } from "../../../config/types/openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { parseAgentSessionKey } from "../../../sessions/session-key-utils.js";
import { resolveSessionStoreKey } from "../../sessions/session-utils.js";
import { normalizeOptionalText } from "./chat.text-normalize.js";

export function validateChatSelectedAgent(params: {
  cfg: OpenClawConfig;
  requestedSessionKey: string;
  agentId?: string;
}): { ok: true; agentId?: string } | { ok: false; error: string } {
  const agentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  if (!agentId) {
    return { ok: true };
  }
  if (!listAgentIds(params.cfg).includes(agentId)) {
    return { ok: false, error: `Unknown agent id "${params.agentId}"` };
  }
  const requestedSessionKey = params.requestedSessionKey.trim();
  const parsed = parseAgentSessionKey(requestedSessionKey);
  if (parsed && normalizeAgentId(parsed.agentId) !== agentId) {
    return {
      ok: false,
      error: `agentId "${params.agentId}" does not match session key "${params.requestedSessionKey}"`,
    };
  }
  if (requestedSessionKey.toLowerCase() === "global") {
    return { ok: true, agentId };
  }
  if (resolveSessionStoreKey({ cfg: params.cfg, sessionKey: requestedSessionKey }) === "global") {
    return { ok: true, agentId };
  }
  if (!parsed || normalizeAgentId(parsed.agentId) !== agentId) {
    return {
      ok: false,
      error: `agentId "${params.agentId}" does not match session key "${params.requestedSessionKey}"`,
    };
  }
  return { ok: true, agentId };
}

export function resolveRequestedChatAgentId(params: {
  cfg?: OpenClawConfig;
  requestedSessionKey: string;
  agentId?: string;
}): string | undefined {
  const explicitAgentId = normalizeOptionalText(params.agentId);
  if (explicitAgentId) {
    return normalizeAgentId(explicitAgentId);
  }
  if (!params.cfg) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(params.requestedSessionKey.trim());
  if (
    !parsed?.agentId ||
    resolveSessionStoreKey({ cfg: params.cfg, sessionKey: params.requestedSessionKey }) !== "global"
  ) {
    return undefined;
  }
  return normalizeAgentId(parsed.agentId);
}

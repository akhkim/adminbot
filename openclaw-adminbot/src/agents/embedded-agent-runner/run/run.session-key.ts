/**
 * Run stage: session-key backfill.
 *
 * Callers may pass a sessionId without the sessionKey the rest of the run needs.
 * The lookup is read-only and best effort: a failure to resolve degrades to
 * undefined rather than failing the run, because a missing key only costs session
 * continuity, and the id itself is redacted before it reaches the log.
 * See: https://github.com/openclaw/openclaw/issues/60552
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  resolveSessionKeyForRequest,
  resolveStoredSessionKeyForSessionId,
} from "../../command/session.js";
import { redactRunIdentifier } from "../../workspace/workspace-run.js";
import { log } from "../logger.js";
import type { RunEmbeddedAgentParams } from "./params.js";

/**
 * Best-effort backfill of sessionKey from sessionId when not explicitly provided.
 * The return value is normalized: whitespace-only inputs collapse to undefined, and
 * successful resolution returns a trimmed session key. This is a read-only lookup
 * with no side effects.
 */
export function backfillSessionKey(params: {
  config: RunEmbeddedAgentParams["config"];
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  const trimmed = normalizeOptionalString(params.sessionKey);
  if (trimmed) {
    return trimmed;
  }
  if (!params.config || !params.sessionId) {
    return undefined;
  }
  try {
    const resolved = normalizeOptionalString(params.agentId)
      ? resolveStoredSessionKeyForSessionId({
          cfg: params.config,
          sessionId: params.sessionId,
          agentId: params.agentId,
        })
      : resolveSessionKeyForRequest({
          cfg: params.config,
          sessionId: params.sessionId,
          clone: false,
        });
    return normalizeOptionalString(resolved.sessionKey);
  } catch (err) {
    log.warn(
      `[backfillSessionKey] Failed to resolve sessionKey for sessionId=${redactRunIdentifier(sanitizeForLog(params.sessionId))}: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

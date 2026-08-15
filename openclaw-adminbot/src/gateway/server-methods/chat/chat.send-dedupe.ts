import { createHash } from "node:crypto";
import { formatUncaughtError } from "../../../infra/errors.js";
/**
 * chat.send subhandler: active-send dedupe.
 *
 * A resent chat.send for a session that already has a run in flight must join the
 * existing run rather than start a second one, so the in-flight run id is keyed by
 * session scope in the gateway dedupe store. Clearing the entry is conditional on
 * the stored run id still matching — a late clear from a superseded send must not
 * release the current one.
 */
import type { ChannelRouteRef } from "../../../plugin-sdk/channel-route.js";
import { scopeLegacySessionKeyToAgent } from "../../../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../../shared/message-channel.js";
import { formatForLog } from "../../ws-log.js";
import type { GatewayRequestContext } from "../types.js";

export type ChatSendDeliveryEntry = {
  route?: ChannelRouteRef;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  origin?: {
    provider?: string;
    accountId?: string;
    threadId?: string | number;
  };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

export const ACTIVE_CHAT_SEND_DEDUPE_PREFIX = "chat:active-send";

export function resolveActiveChatSendRunId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const runId = (value as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.trim() ? runId : null;
}

export function clearActiveChatSendDedupeRun(
  dedupe: GatewayRequestContext["dedupe"],
  key: string | null,
  runId: string,
) {
  if (!key || resolveActiveChatSendRunId(dedupe.get(key)?.payload) !== runId) {
    return;
  }
  dedupe.delete(key);
}

export function buildAbortedChatSendPayload(params: {
  runId: string;
  endedAt: number;
  stopReason?: string;
}) {
  return {
    runId: params.runId,
    status: "timeout" as const,
    summary: "aborted",
    ...(params.stopReason ? { stopReason: params.stopReason } : {}),
    endedAt: params.endedAt,
  };
}

export function buildActiveChatSendDedupeKey(params: {
  attachmentCount: number;
  explicitDeliverRoute: boolean;
  message: string;
  originatingChannel: string;
  sessionKey: string;
  systemScope?: string;
}): string | null {
  const message = params.message.trim();
  if (
    !message ||
    message.startsWith("/") ||
    params.attachmentCount > 0 ||
    params.explicitDeliverRoute ||
    normalizeMessageChannel(params.originatingChannel) !== INTERNAL_MESSAGE_CHANNEL
  ) {
    return null;
  }
  const dedupeParts = params.systemScope?.trim()
    ? [params.sessionKey, message, params.systemScope.trim()]
    : [params.sessionKey, message];
  const digest = createHash("sha256")
    .update(JSON.stringify(dedupeParts))
    .digest("hex")
    .slice(0, 32);
  return `${ACTIVE_CHAT_SEND_DEDUPE_PREFIX}:${digest}`;
}

export function resolveChatSendActiveScopeKey(params: {
  sessionKey: string;
  agentId?: string;
  mainKey?: string;
}): string {
  if (params.sessionKey !== "global" || !params.agentId) {
    return params.sessionKey;
  }
  return (
    scopeLegacySessionKeyToAgent({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      mainKey: params.mainKey,
    }) ?? params.sessionKey
  );
}

export function formatAttachmentFailureForLog(err: unknown): string {
  const primary = formatUncaughtError(err);
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause === undefined) {
    return primary;
  }
  const causeText = formatUncaughtError(cause);
  if (!causeText || causeText === primary) {
    return primary;
  }
  return `${primary}\nCaused by: ${causeText}`;
}

export function logAttachmentFailure(
  logGateway: Pick<GatewayRequestContext["logGateway"], "error">,
  label: string,
  err: unknown,
): void {
  logGateway.error(label, {
    error: formatAttachmentFailureForLog(err),
    consoleMessage: `${label}: ${formatForLog(err)}`,
  });
}

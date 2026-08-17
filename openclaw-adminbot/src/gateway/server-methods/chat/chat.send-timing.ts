import { performance } from "node:perf_hooks";
import { isOperatorUiClient } from "../../../shared/message-channel.js";
/**
 * chat.send subhandler: operator server-timing telemetry.
 *
 * The dashboard's send latency breakdown is fed by out-of-band `chat.send_timing`
 * broadcasts rather than by the ack payload, so a slow operator connection cannot
 * stall the send itself — every emission is `dropIfSlow` and addressed to the one
 * originating connection. Non-operator clients get nothing.
 */
import type { GatewayClient, GatewayRequestContext } from "../types.js";

export type ChatSendAckServerTiming = {
  receivedToAckMs: number;
  loadSessionMs: number;
  prepareAttachmentsMs?: number;
};

export type ChatSendServerTimingPhase =
  | "dispatch-started"
  | "model-selected"
  | "agent-run-started"
  | "first-assistant-event"
  | "dispatch-completed"
  | "post-dispatch-completed";

export function roundedChatSendTimingMs(value: number): number {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

export function chatSendAckServerTimingAttributes(
  timing: ChatSendAckServerTiming | undefined,
): Record<string, number> {
  if (!timing) {
    return {};
  }
  return {
    serverReceivedToAckMs: timing.receivedToAckMs,
    serverLoadSessionMs: timing.loadSessionMs,
    ...(timing.prepareAttachmentsMs !== undefined
      ? { serverPrepareAttachmentsMs: timing.prepareAttachmentsMs }
      : {}),
  };
}

export function shouldIncludeChatSendAckServerTiming(client?: {
  id?: string | null;
  mode?: string | null;
}): boolean {
  return isOperatorUiClient(client);
}

export function emitOperatorChatSendServerTiming(params: {
  context: Pick<GatewayRequestContext, "broadcastToConnIds">;
  client?: GatewayClient | null;
  phase: ChatSendServerTimingPhase;
  runId: string;
  sessionKey: string;
  agentId?: string;
  receivedAtMs: number;
  ackedAtMs: number;
  dispatchStartedAtMs?: number;
  extra?: Record<string, string | number>;
}) {
  const connId =
    typeof params.client?.connId === "string" && params.client.connId.trim()
      ? params.client.connId.trim()
      : undefined;
  if (!connId || !isOperatorUiClient(params.client?.connect?.client)) {
    return;
  }
  const nowMs = performance.now();
  params.context.broadcastToConnIds(
    "chat.send_timing",
    {
      phase: params.phase,
      runId: params.runId,
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ackToPhaseMs: roundedChatSendTimingMs(nowMs - params.ackedAtMs),
      receivedToPhaseMs: roundedChatSendTimingMs(nowMs - params.receivedAtMs),
      ...(params.dispatchStartedAtMs !== undefined
        ? {
            dispatchStartedToPhaseMs: roundedChatSendTimingMs(nowMs - params.dispatchStartedAtMs),
          }
        : {}),
      ...params.extra,
    },
    new Set([connId]),
    { dropIfSlow: true },
  );
}

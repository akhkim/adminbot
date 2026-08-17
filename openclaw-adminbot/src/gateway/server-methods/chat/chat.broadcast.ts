import { resolveDefaultAgentId } from "../../../agents/agent-scope.js";
import type { ReplyPayload } from "../../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../../config/types/openclaw.js";
import { projectChatDisplayMessage } from "../../chat-display-projection.js";
import type { SideResultPayload } from "./chat.transcript.js";
/**
 * chat subhandler: streaming broadcast.
 *
 * Emits the final, side-result and error frames for a run. Sequence numbers are
 * per-run and monotonic because the dashboard orders frames by them rather than
 * by arrival, and global-aware payloads fan out to every delivery key the session
 * resolves to so a client watching the global view still sees the frame.
 */
import type { GatewayRequestContext } from "../types.js";

export function nextChatSeq(context: { agentRunSeq: Map<string, number> }, runId: string) {
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, next);
  return next;
}

export function broadcastChatFinal(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq"> &
    Partial<Pick<GatewayRequestContext, "getRuntimeConfig">>;
  runId: string;
  sessionKey: string;
  agentId?: string;
  message?: Record<string, unknown>;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payloadAgentId = params.sessionKey === "global" ? params.agentId : undefined;
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq,
    state: "final" as const,
    message: projectChatDisplayMessage(params.message),
  };
  params.context.broadcast("chat", payload);
  sendGlobalAwareNodeChatPayload({
    context: params.context,
    sessionKey: params.sessionKey,
    agentId: payloadAgentId,
    event: "chat",
    payload,
  });
  params.context.agentRunSeq.delete(params.runId);
}

export function isBtwReplyPayload(payload: ReplyPayload | undefined): payload is ReplyPayload & {
  btw: { question: string };
  text: string;
} {
  return (
    typeof payload?.btw?.question === "string" &&
    payload.btw.question.trim().length > 0 &&
    typeof payload.text === "string" &&
    payload.text.trim().length > 0
  );
}

export function broadcastSideResult(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq"> &
    Partial<Pick<GatewayRequestContext, "getRuntimeConfig">>;
  payload: SideResultPayload;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.payload.runId);
  const payloadAgentId =
    params.payload.sessionKey === "global" ? params.payload.agentId : undefined;
  const payload = {
    ...params.payload,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq,
  };
  params.context.broadcast("chat.side_result", payload);
  sendGlobalAwareNodeChatPayload({
    context: params.context,
    sessionKey: params.payload.sessionKey,
    agentId: payloadAgentId,
    event: "chat.side_result",
    payload,
  });
}

export function broadcastChatError(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq"> &
    Partial<Pick<GatewayRequestContext, "getRuntimeConfig">>;
  runId: string;
  sessionKey: string;
  agentId?: string;
  errorMessage?: string;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payloadAgentId = params.sessionKey === "global" ? params.agentId : undefined;
  const errorText = params.errorMessage?.trim();
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq,
    state: "error" as const,
    errorMessage: params.errorMessage,
    ...(errorText
      ? {
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text:
                  errorText.startsWith("⚠️") || errorText.startsWith("Error:")
                    ? errorText
                    : `Error: ${errorText}`,
              },
            ],
            timestamp: Date.now(),
          },
        }
      : {}),
  };
  params.context.broadcast("chat", payload);
  sendGlobalAwareNodeChatPayload({
    context: params.context,
    sessionKey: params.sessionKey,
    agentId: payloadAgentId,
    event: "chat",
    payload,
  });
  params.context.agentRunSeq.delete(params.runId);
}

export function sendGlobalAwareNodeChatPayload(params: {
  context: Pick<GatewayRequestContext, "nodeSendToSession"> &
    Partial<Pick<GatewayRequestContext, "getRuntimeConfig">>;
  sessionKey: string;
  agentId?: string;
  event: string;
  payload: unknown;
}) {
  const deliveryKeys = resolveGlobalAwareNodeChatDeliveryKeys({
    cfg: params.context.getRuntimeConfig?.() ?? ({} as OpenClawConfig),
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  for (const deliveryKey of deliveryKeys) {
    params.context.nodeSendToSession(deliveryKey, params.event, params.payload);
  }
}

export function resolveGlobalAwareNodeChatDeliveryKeys(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): string[] {
  if (params.sessionKey !== "global") {
    return [params.sessionKey];
  }
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const scopedAgentId = params.agentId ?? defaultAgentId;
  const keys = [`agent:${scopedAgentId}:global`];
  if (scopedAgentId === defaultAgentId) {
    keys.push("global");
  }
  return keys;
}

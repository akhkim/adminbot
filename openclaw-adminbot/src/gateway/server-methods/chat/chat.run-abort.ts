import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { parseAgentSessionKey } from "../../../sessions/session-key-utils.js";
import {
  type ChatAbortControllerEntry,
  type ChatAbortOps,
  abortChatRunById,
} from "../../chat-abort.js";
import { ADMIN_SCOPE } from "../../method-scopes.js";
import { setGatewayDedupeEntry } from "../agent-wait-dedupe.js";
import { normalizeOptionalText, normalizeUnknownText } from "./chat.text-normalize.js";
import { collectSessionAbortPartials, persistAbortedPartials } from "./chat.transcript.js";
/**
 * chat.abort subhandler: run abort authorization and execution.
 *
 * A chat.abort request may only stop runs its requester owns, so every path here
 * re-derives the requester identity from the client rather than trusting the
 * params, and pre-registered agent runs (which have no controller yet) are
 * authorized and marked aborted through the dedupe store instead.
 */
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "../types.js";

export type AbortOrigin = "rpc" | "stop-command";

export type ChatAbortRequester = {
  connId?: string;
  deviceId?: string;
  isAdmin: boolean;
};

export type PreRegisteredAgentDedupePayload = {
  agentId?: unknown;
  controlUiVisible?: unknown;
  dedupeKeys?: unknown;
  ownerConnId?: unknown;
  ownerDeviceId?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  status?: unknown;
};

export type PreRegisteredAgentRun = {
  runId: string;
  sessionKey: string;
  payload: PreRegisteredAgentDedupePayload;
};

export function createChatAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunBuffers: context.chatRunBuffers,
    chatAbortedRuns: context.chatAbortedRuns,
    clearChatRunState: context.clearChatRunState,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    getRuntimeConfig: context.getRuntimeConfig,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
  };
}

export function resolveChatAbortRequester(
  client: GatewayRequestHandlerOptions["client"],
): ChatAbortRequester {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return {
    connId: normalizeOptionalText(client?.connId),
    deviceId: normalizeOptionalText(client?.connect?.device?.id),
    isAdmin: scopes.includes(ADMIN_SCOPE),
  };
}

export function canRequesterAbortChatRun(
  entry: ChatAbortControllerEntry,
  requester: ChatAbortRequester,
): boolean {
  if (requester.isAdmin) {
    return true;
  }
  const ownerDeviceId = normalizeOptionalText(entry.ownerDeviceId);
  const ownerConnId = normalizeOptionalText(entry.ownerConnId);
  if (!ownerDeviceId && !ownerConnId) {
    return true;
  }
  if (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) {
    return true;
  }
  if (ownerConnId && requester.connId && ownerConnId === requester.connId) {
    return true;
  }
  return false;
}

export function canRequesterAbortChatRunWithoutSessionMatch(
  entry: ChatAbortControllerEntry,
  requester: ChatAbortRequester,
): boolean {
  if (requester.isAdmin) {
    return true;
  }
  const ownerDeviceId = normalizeOptionalText(entry.ownerDeviceId);
  const ownerConnId = normalizeOptionalText(entry.ownerConnId);
  return Boolean(
    (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) ||
    (ownerConnId && requester.connId && ownerConnId === requester.connId),
  );
}

export function readPreRegisteredAgentDedupePayloadForSession(params: {
  entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never;
  runId: string;
  sessionKey: string;
  agentId?: string;
  defaultAgentId: string;
  includeHidden?: boolean;
}): PreRegisteredAgentDedupePayload | undefined {
  if (!params.entry?.ok) {
    return undefined;
  }
  const payload = params.entry.payload as PreRegisteredAgentDedupePayload | undefined;
  if (payload?.status !== "accepted") {
    return undefined;
  }
  if (!params.includeHidden && payload.controlUiVisible === false) {
    return undefined;
  }
  const payloadRunId = normalizeUnknownText(payload.runId);
  if (payloadRunId && payloadRunId !== params.runId) {
    return undefined;
  }
  if (normalizeUnknownText(payload.sessionKey) !== params.sessionKey) {
    return undefined;
  }
  const agentId = normalizeOptionalText(params.agentId)?.toLowerCase();
  if (agentId) {
    const parsed = parseAgentSessionKey(params.sessionKey);
    const sessionAgentId =
      params.sessionKey === "global"
        ? resolveStoredGlobalRunAgentId(
            normalizeUnknownText(payload.agentId),
            params.defaultAgentId,
          )
        : parsed?.agentId
          ? normalizeAgentId(parsed.agentId)
          : undefined;
    if (sessionAgentId && sessionAgentId !== agentId) {
      return undefined;
    }
  }
  return payload;
}

export function readPreRegisteredAgentRun(params: {
  key: string;
  entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never;
}): PreRegisteredAgentRun | undefined {
  if (!params.key.startsWith("agent:") || !params.entry?.ok) {
    return undefined;
  }
  const payload = params.entry.payload as PreRegisteredAgentDedupePayload | undefined;
  if (payload?.status !== "accepted") {
    return undefined;
  }
  if (payload.controlUiVisible === false) {
    return undefined;
  }
  const runId = normalizeUnknownText(payload.runId) ?? normalizeOptionalText(params.key.slice(6));
  const sessionKey = normalizeUnknownText(payload.sessionKey);
  if (!runId || !sessionKey) {
    return undefined;
  }
  return { runId, sessionKey, payload };
}

export function canRequesterAbortPreRegisteredAgentRun(
  payload: PreRegisteredAgentDedupePayload,
  requester: ChatAbortRequester,
): boolean {
  return canRequesterAbortChatRun(
    {
      controller: new AbortController(),
      sessionId: "",
      sessionKey: normalizeUnknownText(payload.sessionKey) ?? "",
      startedAtMs: 0,
      expiresAtMs: 0,
      ownerConnId: normalizeUnknownText(payload.ownerConnId),
      ownerDeviceId: normalizeUnknownText(payload.ownerDeviceId),
      controlUiVisible: payload.controlUiVisible === false ? false : undefined,
      kind: "agent",
    },
    requester,
  );
}

export function resolvePreRegisteredAgentDedupeKeys(
  payload: PreRegisteredAgentDedupePayload,
  runId: string,
): string[] {
  const keys = [`agent:${runId}`];
  const payloadKeys = Array.isArray(payload.dedupeKeys) ? payload.dedupeKeys : [];
  for (const key of payloadKeys) {
    const normalized = normalizeUnknownText(key);
    if (normalized?.startsWith("agent:")) {
      keys.push(normalized);
    }
  }
  return uniqueStrings(keys);
}

export function resolveStoredGlobalRunAgentId(
  agentId: string | undefined,
  defaultAgentId: string,
): string {
  return normalizeOptionalText(agentId)?.toLowerCase() ?? defaultAgentId.toLowerCase();
}

export function writePreRegisteredAgentAbort(params: {
  context: GatewayRequestContext;
  runId: string;
  sessionKey: string;
  payload: PreRegisteredAgentDedupePayload;
  stopReason: string;
  endedAt?: number;
}) {
  const endedAt = params.endedAt ?? Date.now();
  const payloadAgentId = normalizeUnknownText(params.payload.agentId);
  for (const key of resolvePreRegisteredAgentDedupeKeys(params.payload, params.runId)) {
    setGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      key,
      entry: {
        ts: endedAt,
        ok: true,
        payload: {
          runId: params.runId,
          sessionKey: params.sessionKey,
          ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
          ...(params.payload.controlUiVisible === false ? { controlUiVisible: false } : {}),
          status: "timeout" as const,
          summary: "aborted",
          stopReason: params.stopReason,
          endedAt,
        },
      },
    });
  }
}

export function resolveAuthorizedPreRegisteredAgentRunsForSessionKeys(params: {
  context: GatewayRequestContext;
  sessionKeys: Iterable<string>;
  agentId?: string;
  defaultAgentId: string;
  requester: ChatAbortRequester;
}) {
  const sessionKeys = new Set(
    Array.from(params.sessionKeys, (sessionKey) => normalizeOptionalText(sessionKey)).filter(
      (sessionKey): sessionKey is string => Boolean(sessionKey),
    ),
  );
  const authorizedByRunId = new Map<string, PreRegisteredAgentRun>();
  let matchedSessionRuns = 0;
  for (const [key, entry] of params.context.dedupe) {
    const run = readPreRegisteredAgentRun({ key, entry });
    if (!run || !sessionKeys.has(run.sessionKey)) {
      continue;
    }
    if (params.context.chatAbortControllers.has(run.runId)) {
      continue;
    }
    const agentId = normalizeOptionalText(params.agentId)?.toLowerCase();
    if (
      agentId &&
      run.sessionKey === "global" &&
      resolveStoredGlobalRunAgentId(
        normalizeUnknownText(run.payload.agentId),
        params.defaultAgentId,
      ) !== agentId
    ) {
      continue;
    }
    matchedSessionRuns += 1;
    if (canRequesterAbortPreRegisteredAgentRun(run.payload, params.requester)) {
      authorizedByRunId.set(run.runId, run);
    }
  }
  return {
    matchedSessionRuns,
    authorizedRuns: [...authorizedByRunId.values()],
  };
}

export function resolveAuthorizedRunsForSessionKeys(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  sessionKeys: Iterable<string>;
  sessionIds?: Iterable<string | undefined>;
  agentId?: string;
  defaultAgentId: string;
  requester: ChatAbortRequester;
}) {
  const sessionKeys = new Set(
    Array.from(params.sessionKeys, (sessionKey) => normalizeOptionalText(sessionKey)).filter(
      (sessionKey): sessionKey is string => Boolean(sessionKey),
    ),
  );
  const sessionIds = new Set(
    Array.from(params.sessionIds ?? [], (sessionId) => normalizeOptionalText(sessionId)).filter(
      (sessionId): sessionId is string => Boolean(sessionId),
    ),
  );
  const agentId = normalizeOptionalText(params.agentId)?.toLowerCase();
  const authorizedRuns: Array<{ runId: string; sessionKey: string }> = [];
  let matchedSessionRuns = 0;
  for (const [runId, active] of params.chatAbortControllers) {
    if (active.controlUiVisible === false) {
      continue;
    }
    if (!sessionKeys.has(active.sessionKey) && !sessionIds.has(active.sessionId)) {
      continue;
    }
    if (
      agentId &&
      active.sessionKey === "global" &&
      resolveStoredGlobalRunAgentId(active.agentId, params.defaultAgentId) !== agentId
    ) {
      continue;
    }
    matchedSessionRuns += 1;
    if (canRequesterAbortChatRun(active, params.requester)) {
      authorizedRuns.push({ runId, sessionKey: active.sessionKey });
    }
  }
  return {
    matchedSessionRuns,
    authorizedRuns,
  };
}

export async function abortChatRunsForSessionKeyWithPartials(params: {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  sessionKeyAliases?: string[];
  agentId?: string;
  sessionId?: string;
  persistSessionKey?: string;
  defaultAgentId: string;
  abortOrigin: AbortOrigin;
  stopReason?: string;
  requester: ChatAbortRequester;
}): Promise<{ aborted: boolean; runIds: string[]; unauthorized: boolean }> {
  const sessionKeys = [params.sessionKey, ...(params.sessionKeyAliases ?? [])];
  const { matchedSessionRuns, authorizedRuns } = resolveAuthorizedRunsForSessionKeys({
    chatAbortControllers: params.context.chatAbortControllers,
    sessionKeys,
    sessionIds: [params.sessionId],
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
  });
  const {
    matchedSessionRuns: matchedPendingAgentRuns,
    authorizedRuns: authorizedPendingAgentRuns,
  } = resolveAuthorizedPreRegisteredAgentRunsForSessionKeys({
    context: params.context,
    sessionKeys,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
  });
  if (authorizedRuns.length === 0 && authorizedPendingAgentRuns.length === 0) {
    return {
      aborted: false,
      runIds: [],
      unauthorized: matchedSessionRuns > 0 || matchedPendingAgentRuns > 0,
    };
  }
  const authorizedRunIdSet = new Set(authorizedRuns.map((run) => run.runId));
  const snapshots = collectSessionAbortPartials({
    chatAbortControllers: params.context.chatAbortControllers,
    chatRunBuffers: params.context.chatRunBuffers,
    runIds: authorizedRunIdSet,
    abortOrigin: params.abortOrigin,
  });
  const runIds: string[] = [];
  for (const { runId, sessionKey } of authorizedRuns) {
    const res = abortChatRunById(params.ops, {
      runId,
      sessionKey,
      stopReason: params.stopReason,
    });
    if (res.aborted) {
      runIds.push(runId);
    }
  }
  const endedAt = Date.now();
  const stopReason = params.stopReason ?? "rpc";
  for (const { runId, sessionKey, payload } of authorizedPendingAgentRuns) {
    writePreRegisteredAgentAbort({
      context: params.context,
      runId,
      sessionKey,
      payload,
      stopReason,
      endedAt,
    });
    runIds.push(runId);
  }
  const res = { aborted: runIds.length > 0, runIds, unauthorized: false };
  if (res.aborted) {
    await persistAbortedPartials({
      context: params.context,
      sessionKey: params.persistSessionKey ?? params.sessionKey,
      snapshots,
    });
  }
  return res;
}

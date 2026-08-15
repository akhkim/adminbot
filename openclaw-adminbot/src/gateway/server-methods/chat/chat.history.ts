import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatHistoryParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId, resolveSessionAgentId } from "../../../agents/agent-scope.js";
import { type ReplyPayload, getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../../config/types/openclaw.js";
import { measureDiagnosticsTimelineSpan } from "../../../infra/diagnostics/diagnostics-timeline.js";
import { jsonUtf8Bytes } from "../../../infra/json-utf8-bytes.js";
import { logLargePayload } from "../../../logging/diagnostic-payload.js";
import {
  boundInFlightRunSnapshotForChatHistory,
  resolveInFlightRunSnapshot,
} from "../../chat-abort.js";
import {
  augmentChatHistoryWithCanvasBlocks,
  dropPreSessionStartAnnouncePairs,
  projectRecentChatDisplayMessages,
  resolveEffectiveChatHistoryMaxChars,
} from "../../chat-display-projection.js";
import { augmentChatHistoryWithCliSessionImports } from "../../client/cli-session-history.js";
import { getMaxChatHistoryMessagesBytes } from "../../server/server-constants.js";
import { resolveSessionHistoryTailReadOptions } from "../../sessions/session-history-state.js";
import {
  capArrayByJsonBytes,
  readRecentSessionMessagesAsync,
  readSessionMessagesAsync,
} from "../../sessions/session-transcript-readers.js";
import {
  buildGatewaySessionInfo,
  getSessionDefaults,
  listAgentsForGateway,
  loadSessionEntry,
  resolveSessionModelRef,
  resolveSessionStoreKey,
} from "../../sessions/session-utils.js";
import { resolveRequestedChatAgentId, validateChatSelectedAgent } from "./chat.agent-selection.js";
import { scheduleChatHistoryManagedImageCleanup } from "./chat.assistant-display.js";
import { type ChatHistoryMethod, buildChatStartupMetadataResult } from "./chat.metadata.js";
import { normalizeOptionalText } from "./chat.text-normalize.js";
import {
  loadOptionalServerMethodModelCatalog,
  startOptionalServerMethodModelCatalogLoad,
} from "../optional-model-catalog.js";
import { hasTrackedActiveSessionRun } from "../session-active-runs.js";
import { canRequesterAccessSession, resolveSessionAccessRequester } from "../session-ownership.js";
/**
 * chat.history subhandler.
 *
 * Reads a session transcript back for the dashboard under a hard byte budget. An
 * oversized single message is replaced by a placeholder rather than dropped, and
 * if the budget still cannot be met the response carries an explicit unavailable
 * sentinel — a blank transcript would read as "no history" and is never returned.
 */
import type { GatewayRequestHandlerOptions } from "../types.js";

export const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
export const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
export const CHAT_HISTORY_UNAVAILABLE_SENTINEL =
  "[chat.history unavailable: transcript too large to display; the full history is preserved on disk]";

/**
 * A minimal, metadata-free notice returned when even a single oversized
 * placeholder cannot fit the chat-history byte budget. Returning this instead
 * of an empty array guarantees the dashboard never renders a blank transcript,
 * which otherwise reads to the operator as total history loss.
 */
export function buildChatHistoryUnavailableSentinel(): Record<string, unknown> {
  return {
    role: "assistant",
    timestamp: Date.now(),
    content: [{ type: "text", text: CHAT_HISTORY_UNAVAILABLE_SENTINEL }],
  };
}
export const CHAT_STARTUP_OPTIONAL_MODEL_CATALOG_TIMEOUT_MS = 25;
export let chatHistoryPlaceholderEmitCount = 0;

export function buildOversizedHistoryPlaceholder(message?: unknown): Record<string, unknown> {
  const role =
    message &&
    typeof message === "object" &&
    typeof (message as { role?: unknown }).role === "string"
      ? (message as { role: string }).role
      : "assistant";
  const timestamp =
    message &&
    typeof message === "object" &&
    typeof (message as { timestamp?: unknown }).timestamp === "number"
      ? (message as { timestamp: number }).timestamp
      : Date.now();
  const rawMetadata =
    message && typeof message === "object"
      ? (message as Record<string, unknown>)["__openclaw"]
      : undefined;
  const metadata =
    rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {};
  const metadataId = typeof metadata.id === "string" ? metadata.id : undefined;
  const metadataSeq = typeof metadata.seq === "number" ? metadata.seq : undefined;
  return {
    role,
    timestamp,
    content: [{ type: "text", text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER }],
    __openclaw: {
      ...(metadataId ? { id: metadataId } : {}),
      ...(metadataSeq !== undefined ? { seq: metadataSeq } : {}),
      truncated: true,
      reason: "oversized",
    },
  };
}

export function replaceOversizedChatHistoryMessages(params: {
  messages: unknown[];
  maxSingleMessageBytes: number;
}): { messages: unknown[]; replacedCount: number } {
  const { messages, maxSingleMessageBytes } = params;
  if (messages.length === 0) {
    return { messages, replacedCount: 0 };
  }
  let replacedCount = 0;
  const next = messages.map((message) => {
    if (jsonUtf8Bytes(message) <= maxSingleMessageBytes) {
      return message;
    }
    replacedCount += 1;
    return buildOversizedHistoryPlaceholder(message);
  });
  return { messages: replacedCount > 0 ? next : messages, replacedCount };
}

export function enforceChatHistoryFinalBudget(params: { messages: unknown[]; maxBytes: number }): {
  messages: unknown[];
  placeholderCount: number;
} {
  const { messages, maxBytes } = params;
  if (messages.length === 0) {
    return { messages, placeholderCount: 0 };
  }
  if (jsonUtf8Bytes(messages) <= maxBytes) {
    return { messages, placeholderCount: 0 };
  }
  const last = messages.at(-1);
  if (last && jsonUtf8Bytes([last]) <= maxBytes) {
    return { messages: [last], placeholderCount: 0 };
  }
  const placeholder = buildOversizedHistoryPlaceholder(last);
  if (jsonUtf8Bytes([placeholder]) <= maxBytes) {
    return { messages: [placeholder], placeholderCount: 1 };
  }
  // The oversized placeholder still does not fit (e.g. the source message
  // carried very large metadata). Never return an empty history — that renders
  // as a blank transcript and reads as data loss even though the on-disk
  // transcript is intact. Fall back to a small metadata-free sentinel.
  return { messages: [buildChatHistoryUnavailableSentinel()], placeholderCount: 1 };
}

export function isSourceReplyTranscriptMirrorPayload(payload: ReplyPayload | undefined) {
  return Boolean(payload && getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror);
}

export function readChatHistoryMessageId(message: unknown): string | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  return typeof metadata?.id === "string" ? metadata.id : undefined;
}

export async function isChatMessageIdVisibleAfterHistoryFilters(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionEntry?: { sessionFile?: string; sessionId?: string };
  sessionKey: string;
  agentId?: string;
  messageId: string;
  sessionStartedAt?: number;
  allowResetArchiveFallback?: boolean;
}): Promise<boolean> {
  if (params.sessionStartedAt === undefined) {
    return true;
  }
  const messages = await readSessionMessagesAsync(
    {
      agentId: params.agentId,
      sessionEntry: params.sessionEntry,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    {
      mode: "full",
      reason: "chat.message.get visibility",
      ...(params.allowResetArchiveFallback === true ? { allowResetArchiveFallback: true } : {}),
    },
  );
  return dropPreSessionStartAnnouncePairs(messages, params.sessionStartedAt).some(
    (message) => readChatHistoryMessageId(message) === params.messageId,
  );
}

export function dropLocalHistoryOverreadContextMessage(
  messages: unknown[],
  contextMessage: unknown,
): unknown[] {
  if (contextMessage === undefined) {
    return messages;
  }
  const index = messages.indexOf(contextMessage);
  if (index < 0) {
    return messages;
  }
  return [...messages.slice(0, index), ...messages.slice(index + 1)];
}

export async function handleChatHistoryRequest({
  params,
  respond,
  context,
  client,
  method,
  includeAgentsList,
  includeMetadata,
}: GatewayRequestHandlerOptions & {
  method: ChatHistoryMethod;
  includeAgentsList?: boolean;
  includeMetadata?: boolean;
}) {
  if (!validateChatHistoryParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid ${method} params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
      ),
    );
    return;
  }
  const { sessionKey, limit, maxChars } = params as {
    sessionKey: string;
    agentId?: string;
    limit?: number;
    maxChars?: number;
  };
  const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
  const requestedAgentId = resolveRequestedChatAgentId({
    cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
    requestedSessionKey: sessionKey,
    agentId: agentIdOverride,
  });
  const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
  const {
    cfg,
    storePath,
    store,
    entry: rawEntry,
    canonicalKey,
  } = loadSessionEntry(sessionKey, sessionLoadOptions);
  const sessionRequester = resolveSessionAccessRequester(client);
  const entry =
    rawEntry && canRequesterAccessSession(rawEntry, sessionRequester, canonicalKey)
      ? rawEntry
      : undefined;
  // The store has to be filtered as well, not just `entry`. buildGatewaySessionInfo below is
  // handed both, and reads the store by key for the session and its children -- so nulling `entry`
  // alone still let a non-owner reconstruct another member's session info (its label included,
  // which leaks what the conversation is about).
  const accessibleStore = Object.fromEntries(
    Object.entries(store).filter(([candidateKey, candidate]) =>
      canRequesterAccessSession(candidate, sessionRequester, candidateKey),
    ),
  );
  const selectedAgent = validateChatSelectedAgent({
    cfg,
    requestedSessionKey: sessionKey,
    agentId: requestedAgentId,
  });
  if (!selectedAgent.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
    return;
  }
  const startupModelCatalogLoad =
    method === "chat.startup" ? startOptionalServerMethodModelCatalogLoad(context) : undefined;
  const modelCatalogPromise = measureDiagnosticsTimelineSpan(
    `gateway.${method}.model_catalog`,
    () =>
      startupModelCatalogLoad
        ? loadOptionalServerMethodModelCatalog(context, method, {
            logOnceKey: "chat.startup",
            startedLoad: startupModelCatalogLoad,
            timeoutMs: CHAT_STARTUP_OPTIONAL_MODEL_CATALOG_TIMEOUT_MS,
          })
        : loadOptionalServerMethodModelCatalog(context, method),
    {
      config: cfg,
      phase: method,
    },
  );
  if (startupModelCatalogLoad) {
    void modelCatalogPromise.catch(() => undefined);
  }
  const sessionId = entry?.sessionId;
  const sessionAgentId = resolveSessionAgentId({
    sessionKey,
    config: cfg,
    agentId: selectedAgent.agentId,
  });
  const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
  const hardMax = 1000;
  const defaultLimit = 200;
  const requested = typeof limit === "number" ? limit : defaultLimit;
  const max = Math.min(hardMax, requested);
  const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
  const rawHistoryWindow = resolveSessionHistoryTailReadOptions(max);
  const localHistoryReadOptions = {
    maxMessages: rawHistoryWindow.maxMessages + 1,
    maxLines: rawHistoryWindow.maxLines + 1,
  };
  const localMessages =
    sessionId && storePath
      ? await readRecentSessionMessagesAsync(
          {
            agentId: sessionAgentId,
            sessionEntry: entry,
            sessionId,
            sessionKey: canonicalKey,
            storePath,
          },
          {
            ...localHistoryReadOptions,
            maxBytes: Math.max(maxHistoryBytes * 2, 1024 * 1024),
            allowResetArchiveFallback: true,
          },
        )
      : [];
  const overreadContextMessage =
    localMessages.length > rawHistoryWindow.maxMessages ? localMessages[0] : undefined;
  const localMessagesWithBoundaryFilter = dropLocalHistoryOverreadContextMessage(
    dropPreSessionStartAnnouncePairs(
      localMessages,
      typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
    ),
    overreadContextMessage,
  );
  const rawMessages = augmentChatHistoryWithCliSessionImports({
    entry,
    provider: resolvedSessionModel.provider,
    localMessages: localMessagesWithBoundaryFilter,
  });
  // Drop subagent_announce pairs (user inter-session announce + adjacent
  // assistant) whose record timestamp predates the current session's
  // sessionStartedAt. Run after CLI history imports too, because those
  // timestamped messages share the same chat.history response surface.
  const recencyFilteredMessages = dropPreSessionStartAnnouncePairs(
    rawMessages,
    typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
  );
  const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars(cfg, maxChars);
  const normalized = augmentChatHistoryWithCanvasBlocks(
    projectRecentChatDisplayMessages(recencyFilteredMessages, {
      maxChars: effectiveMaxChars,
      maxMessages: max,
    }),
  );
  const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
  const replaced = replaceOversizedChatHistoryMessages({
    messages: normalized,
    maxSingleMessageBytes: perMessageHardCap,
  });
  scheduleChatHistoryManagedImageCleanup({
    sessionKey,
    ...(selectedAgent.agentId ? { agentId: selectedAgent.agentId } : {}),
    context,
  });
  const capped = capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
  const bounded = enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });
  const placeholderCount = replaced.replacedCount + bounded.placeholderCount;
  if (placeholderCount > 0) {
    chatHistoryPlaceholderEmitCount += placeholderCount;
    logLargePayload({
      surface: "gateway.chat.history",
      action: "truncated",
      bytes: jsonUtf8Bytes(normalized),
      limitBytes: maxHistoryBytes,
      count: placeholderCount,
      reason: "chat_history_budget",
    });
    context.logGateway.debug(
      `chat.history omitted oversized payloads placeholders=${placeholderCount} total=${chatHistoryPlaceholderEmitCount}`,
    );
  }
  const modelCatalog = await modelCatalogPromise;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const startupMetadata = includeMetadata
    ? await buildChatStartupMetadataResult({
        cfg,
        context,
        agentId: sessionAgentId,
        modelCatalog,
      })
    : undefined;
  const sessionInfo = buildGatewaySessionInfo({
    cfg,
    storePath,
    store: accessibleStore,
    key: canonicalKey,
    entry,
    agentId: selectedAgent.agentId,
    modelCatalog,
  });
  const activeRunAgentId =
    canonicalKey === "global" ? (selectedAgent.agentId ?? defaultAgentId) : selectedAgent.agentId;
  sessionInfo.hasActiveRun = hasTrackedActiveSessionRun({
    context,
    requestedKey: sessionKey,
    canonicalKey,
    ...(activeRunAgentId ? { agentId: activeRunAgentId } : {}),
    defaultAgentId,
  });
  const defaults = getSessionDefaults(cfg, modelCatalog, { allowPluginNormalization: false });
  const thinkingLevel = sessionInfo.thinkingLevel ?? sessionInfo.thinkingDefault;
  const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
  sessionInfo.verboseLevel = verboseLevel;
  // Surface any run still streaming for this session+agent so a client that
  // switched away (and stopped receiving the run's per-agent-delivered events)
  // can restore the in-flight assistant text on switch-back.
  const inFlightRun = resolveInFlightRunSnapshot({
    chatAbortControllers: context.chatAbortControllers,
    chatRunBuffers: context.chatRunBuffers,
    requestedSessionKey: sessionKey,
    canonicalSessionKey: resolveSessionStoreKey({ cfg, sessionKey }),
    agentId: activeRunAgentId,
    defaultAgentId,
  });
  const boundedInFlightRun = boundInFlightRunSnapshotForChatHistory({
    snapshot: inFlightRun,
    messages: bounded.messages,
    maxBytes: maxHistoryBytes,
  });
  const payload = {
    sessionKey,
    sessionId,
    messages: bounded.messages,
    defaults,
    sessionInfo,
    thinkingLevel,
    fastMode: entry?.fastMode,
    verboseLevel,
    ...(boundedInFlightRun ? { inFlightRun: boundedInFlightRun } : {}),
    ...(includeAgentsList ? { agentsList: listAgentsForGateway(cfg, modelCatalog) } : {}),
    ...(startupMetadata ? { metadata: startupMetadata } : {}),
  };
  respond(true, payload);
}

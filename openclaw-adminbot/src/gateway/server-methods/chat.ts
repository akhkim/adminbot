// oxlint-disable max-lines -- deferred split, see docs/adr/0006-deferred-monster-splits.md
// Chat gateway methods implement chat.send/history/abort/inject/metadata and
// bridge UI RPCs to agent dispatch, transcripts, media, and streaming state.
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatInjectParams,
  validateChatMessageGetParams,
  validateChatSendParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveProviderIdForAuth } from "../../agents/auth/provider-auth-aliases.js";
import { rewriteTranscriptEntriesInRuntimeTranscript } from "../../agents/embedded-agent-runner/transcript-rewrite.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types/openclaw.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  emitDiagnosticsTimelineEvent,
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../../infra/diagnostics/diagnostics-timeline.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
} from "../../media/local-roots.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { SavedMedia } from "../../media/store.js";
import { createChannelMessageReplyPipeline } from "../../plugin-sdk/channel-outbound.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeInputProvenance, type InputProvenance } from "../../sessions/input-provenance.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnInput,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDisplay,
  sanitizeReplyDirectiveId,
} from "../../shared/directive-tags.js";
import { INTERNAL_MESSAGE_CHANNEL, isOperatorUiClient } from "../../shared/message-channel.js";
import {
  abortChatRunById,
  isChatStopCommandText,
  registerChatAbortController,
  updateChatRunProvider,
} from "../chat-abort.js";
import {
  type ChatImageContent,
  MediaOffloadError,
  type OffloadedRef,
  parseMessageWithAttachments,
  resolveChatAttachmentMaxBytes,
} from "../chat-attachments.js";
import {
  augmentChatHistoryWithCanvasBlocks,
  projectChatDisplayMessage,
  resolveEffectiveChatHistoryMaxChars,
} from "../chat-display-projection.js";
import { sanitizeChatSendMessageInput } from "../chat-input-sanitize.js";
import { attachManagedOutgoingImagesToMessage } from "../managed-image-attachments.js";
import { chatAbortMarkerTimestampMs, type ChatRunTiming } from "../server/server-chat-state.js";
import { MAX_PAYLOAD_BYTES } from "../server/server-constants.js";
import { readSessionTranscriptIndex } from "../sessions/session-transcript-index.fs.js";
import { readSessionMessageByIdAsync } from "../sessions/session-transcript-readers.js";
import {
  loadSessionEntry,
  resolveGatewayModelSupportsImages,
  resolveDeletedAgentIdFromSessionKey,
  resolveSessionModelRef,
  resolveSessionStoreKey,
} from "../sessions/session-utils.js";
import { formatForLog } from "../ws-log.js";
import { setGatewayDedupeEntry } from "./agent-wait-dedupe.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";
import type { GatewayInjectedTtsSupplementMarker } from "./chat-transcript-inject.js";
import { resolveRequestedChatAgentId, validateChatSelectedAgent } from "./chat.agent-selection.js";
import {
  type AssistantDisplayContentBlock,
  buildAssistantDisplayContentFromReplyPayloads,
  extractAssistantDisplayText,
  extractAssistantDisplayTextFromContent,
  hasAssistantDisplayMediaContent,
  hasManagedOutgoingAssistantContent,
  hasVisibleAssistantFinalMessage,
  replaceAssistantContentTextBlocks,
  sanitizeAssistantDisplayText,
  stripManagedOutgoingAssistantContentBlocks,
} from "./chat.assistant-display.js";
import {
  broadcastChatError,
  broadcastChatFinal,
  broadcastSideResult,
  isBtwReplyPayload,
  sendGlobalAwareNodeChatPayload,
} from "./chat.broadcast.js";
import {
  handleChatHistoryRequest,
  isChatMessageIdVisibleAfterHistoryFilters,
  isSourceReplyTranscriptMirrorPayload,
} from "./chat.history.js";
import { handleChatMetadataRequest } from "./chat.metadata.js";
import {
  abortChatRunsForSessionKeyWithPartials,
  canRequesterAbortChatRun,
  canRequesterAbortChatRunWithoutSessionMatch,
  canRequesterAbortPreRegisteredAgentRun,
  createChatAbortOps,
  readPreRegisteredAgentDedupePayloadForSession,
  resolveChatAbortRequester,
  resolveStoredGlobalRunAgentId,
  writePreRegisteredAgentAbort,
} from "./chat.run-abort.js";
import {
  buildAbortedChatSendPayload,
  buildActiveChatSendDedupeKey,
  clearActiveChatSendDedupeRun,
  logAttachmentFailure,
  resolveActiveChatSendRunId,
  resolveChatSendActiveScopeKey,
} from "./chat.send-dedupe.js";
import {
  applyChatSendManagedMediaFields,
  buildChatSendUserTurnMedia,
  persistChatSendImages,
  prestageMediaPathOffloads,
  resolveChatSendManagedMediaFields,
  stripTrailingOffloadedMediaMarkers,
} from "./chat.send-media.js";
import {
  canInjectSystemProvenance,
  explicitOriginTargetsAcpSession,
  explicitOriginTargetsPluginBinding,
  normalizeExplicitChatSendOrigin,
  normalizeOptionalChatSystemReceipt,
  resolveChatSendOriginatingRoute,
} from "./chat.send-origin.js";
import {
  type ChatSendServerTimingPhase,
  chatSendAckServerTimingAttributes,
  emitOperatorChatSendServerTiming,
  roundedChatSendTimingMs,
  shouldIncludeChatSendAckServerTiming,
} from "./chat.send-timing.js";
import { normalizeOptionalText } from "./chat.text-normalize.js";
import {
  advanceSessionTranscriptMarker,
  appendAssistantTranscriptMessage,
  buildTranscriptReplyText,
  findSourceReplyTranscriptMirrorByIdempotencyKey,
  findSourceReplyTranscriptMirrorByMetadata,
  hasSensitiveMediaPayload,
  persistAbortedPartials,
  resolveTranscriptPath,
} from "./chat.transcript.js";
import {
  buildMediaOnlyTtsSupplementTranscriptMarker,
  buildTtsSupplementTranscriptMarker,
  buildWebchatAssistantMediaMessage,
  isMediaBearingPayload,
  resolveWebchatPromptCacheKey,
  stripVisibleTextFromTtsSupplement,
} from "./chat.tts-supplement.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";

export {
  augmentChatHistoryWithCanvasBlocks,
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  dropPreSessionStartAnnouncePairs,
  resolveEffectiveChatHistoryMaxChars,
  sanitizeChatHistoryMessages,
} from "../chat-display-projection.js";
export { sanitizeChatSendMessageInput } from "../chat-input-sanitize.js";
export {
  buildOversizedHistoryPlaceholder,
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  enforceChatHistoryFinalBudget,
  replaceOversizedChatHistoryMessages,
} from "./chat.history.js";

export const chatHandlers: GatewayRequestHandlers = {
  "chat.history": async (opts) => {
    await handleChatHistoryRequest({ ...opts, method: "chat.history" });
  },
  "chat.startup": async (opts) => {
    await handleChatHistoryRequest({
      ...opts,
      method: "chat.startup",
      includeAgentsList: true,
      includeMetadata: true,
    });
  },
  "chat.metadata": handleChatMetadataRequest,
  "chat.message.get": async ({ params, respond, context }) => {
    if (!validateChatMessageGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.message.get params: ${formatValidationErrors(validateChatMessageGetParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, messageId, maxChars } = params as {
      sessionKey: string;
      agentId?: string;
      messageId: string;
      maxChars?: number;
    };
    const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
      requestedSessionKey: sessionKey,
      agentId: agentIdOverride,
    });
    const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey, sessionLoadOptions);
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: sessionKey,
      agentId: requestedAgentId,
    });
    if (!selectedAgent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
      return;
    }
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(true, { ok: false, unavailableReason: "not_found" });
      return;
    }

    const sessionAgentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
      agentId: selectedAgent.agentId,
    });
    const resolved = await readSessionMessageByIdAsync(
      {
        agentId: sessionAgentId,
        sessionEntry: entry,
        sessionId,
        sessionKey,
        storePath,
      },
      messageId,
      { allowResetArchiveFallback: true },
    );
    if (!resolved.found) {
      respond(true, { ok: false, unavailableReason: "not_found" });
      return;
    }
    const visible = await isChatMessageIdVisibleAfterHistoryFilters({
      sessionId,
      storePath,
      sessionEntry: entry,
      sessionKey,
      agentId: sessionAgentId,
      messageId,
      sessionStartedAt:
        typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
      allowResetArchiveFallback: true,
    });
    if (!visible) {
      respond(true, { ok: false, unavailableReason: "not_found" });
      return;
    }
    if (resolved.oversized) {
      respond(true, { ok: false, unavailableReason: "oversized" });
      return;
    }

    const effectiveMaxChars =
      typeof maxChars === "number" ? maxChars : Math.min(MAX_PAYLOAD_BYTES, 1_000_000);
    const projectedMessage = resolved.message
      ? projectChatDisplayMessage(resolved.message, {
          maxChars: effectiveMaxChars,
        })
      : undefined;
    const projected = projectedMessage
      ? augmentChatHistoryWithCanvasBlocks([projectedMessage])[0]
      : undefined;
    if (!projected) {
      respond(true, { ok: false, unavailableReason: "not_visible" });
      return;
    }

    respond(true, {
      ok: true,
      message: projected,
    });
  },
  "chat.abort": async ({ params, respond, context, client }) => {
    if (!validateChatAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey: rawSessionKey, runId } = params as {
      sessionKey: string;
      agentId?: string;
      runId?: string;
    };
    const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
    const abortCfg = context.getRuntimeConfig();
    const defaultAgentId = resolveDefaultAgentId(abortCfg);
    const parsedAbortSessionKey = parseAgentSessionKey(rawSessionKey);
    const abortSessionResolvesGlobal =
      resolveSessionStoreKey({ cfg: abortCfg, sessionKey: rawSessionKey }) === "global";
    const inferredGlobalAgentId =
      !agentIdOverride && parsedAbortSessionKey && abortSessionResolvesGlobal
        ? normalizeAgentId(parsedAbortSessionKey.agentId)
        : undefined;
    const abortAgentId =
      agentIdOverride ??
      inferredGlobalAgentId ??
      (abortSessionResolvesGlobal ? defaultAgentId : undefined);
    if (
      agentIdOverride &&
      parsedAbortSessionKey &&
      normalizeAgentId(parsedAbortSessionKey.agentId) !== normalizeAgentId(agentIdOverride)
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `agentId "${agentIdOverride}" does not match session key "${rawSessionKey}"`,
        ),
      );
      return;
    }
    const canonicalAbortSessionKey =
      abortAgentId && abortSessionResolvesGlobal ? "global" : rawSessionKey;

    const ops = createChatAbortOps(context);
    const requester = resolveChatAbortRequester(client);

    if (!runId) {
      const res = await abortChatRunsForSessionKeyWithPartials({
        context,
        ops,
        sessionKey: canonicalAbortSessionKey,
        sessionKeyAliases: canonicalAbortSessionKey === rawSessionKey ? undefined : [rawSessionKey],
        agentId: abortAgentId,
        defaultAgentId,
        abortOrigin: "rpc",
        stopReason: "rpc",
        requester,
      });
      if (res.unauthorized) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }
    const normalizedAgentIdOverride = abortAgentId?.toLowerCase();

    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      const pendingAgentEntry = context.dedupe.get(`agent:${runId}`);
      const pendingAgentMatch = (() => {
        const canonicalMatch = readPreRegisteredAgentDedupePayloadForSession({
          entry: pendingAgentEntry,
          runId,
          sessionKey: canonicalAbortSessionKey,
          agentId: abortAgentId,
          defaultAgentId,
          includeHidden: true,
        });
        if (canonicalMatch) {
          return { sessionKey: canonicalAbortSessionKey, payload: canonicalMatch };
        }
        if (rawSessionKey === canonicalAbortSessionKey) {
          return undefined;
        }
        const aliasMatch = readPreRegisteredAgentDedupePayloadForSession({
          entry: pendingAgentEntry,
          runId,
          sessionKey: rawSessionKey,
          agentId: abortAgentId,
          defaultAgentId,
          includeHidden: true,
        });
        return aliasMatch ? { sessionKey: rawSessionKey, payload: aliasMatch } : undefined;
      })();
      if (pendingAgentMatch) {
        const pendingAgentPayload = pendingAgentMatch.payload;
        if (!canRequesterAbortPreRegisteredAgentRun(pendingAgentPayload, requester)) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
          return;
        }
        writePreRegisteredAgentAbort({
          context,
          runId,
          sessionKey: pendingAgentMatch.sessionKey,
          payload: pendingAgentPayload,
          stopReason: "rpc",
        });
        respond(true, { ok: true, aborted: true, runIds: [runId] });
        return;
      }
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    const abortSessionKeysForRun = new Set([rawSessionKey, canonicalAbortSessionKey]);
    if (
      !abortSessionKeysForRun.has(active.sessionKey) &&
      !canRequesterAbortChatRunWithoutSessionMatch(active, requester)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }
    if (
      normalizedAgentIdOverride &&
      active.sessionKey === "global" &&
      resolveStoredGlobalRunAgentId(active.agentId, defaultAgentId) !== normalizedAgentIdOverride
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match agentId"),
      );
      return;
    }
    if (!canRequesterAbortChatRun(active, requester)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }

    const partialText = context.chatRunBuffers.get(runId);
    const res = abortChatRunById(ops, {
      runId,
      sessionKey: active.sessionKey,
      stopReason: "rpc",
    });
    if (res.aborted && active.controlUiVisible !== false && partialText && partialText.trim()) {
      await persistAbortedPartials({
        context,
        sessionKey: active.sessionKey,
        snapshots: [
          {
            runId,
            sessionId: active.sessionId,
            agentId: active.agentId,
            text: partialText,
            abortOrigin: "rpc",
          },
        ],
      });
    }
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.aborted ? [runId] : [],
    });
  },
  "chat.send": async ({ params, respond, context, client }) => {
    const chatSendReceivedAtMs = performance.now();
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      agentId?: string;
      sessionId?: string;
      message: string;
      thinking?: string;
      fastMode?: boolean;
      deliver?: boolean;
      originatingChannel?: string;
      originatingTo?: string;
      originatingAccountId?: string;
      originatingThreadId?: string;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
      timeoutMs?: number;
      systemInputProvenance?: InputProvenance;
      systemProvenanceReceipt?: string;
      suppressCommandInterpretation?: boolean;
      idempotencyKey: string;
    };
    const suppressCommandInterpretation = p.suppressCommandInterpretation === true;
    const explicitOriginResult = normalizeExplicitChatSendOrigin({
      originatingChannel: p.originatingChannel,
      originatingTo: p.originatingTo,
      accountId: p.originatingAccountId,
      messageThreadId: p.originatingThreadId,
    });
    if (!explicitOriginResult.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, explicitOriginResult.error));
      return;
    }
    if (
      (p.systemInputProvenance ||
        p.systemProvenanceReceipt ||
        suppressCommandInterpretation ||
        explicitOriginResult.value) &&
      !canInjectSystemProvenance(client)
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          p.systemInputProvenance || p.systemProvenanceReceipt || suppressCommandInterpretation
            ? "system provenance fields require admin scope"
            : "originating route fields require admin scope",
        ),
      );
      return;
    }
    const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
    if (!sanitizedMessageResult.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, sanitizedMessageResult.error),
      );
      return;
    }
    const systemReceiptResult = normalizeOptionalChatSystemReceipt(p.systemProvenanceReceipt);
    if (!systemReceiptResult.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, systemReceiptResult.error));
      return;
    }
    const inboundMessage = sanitizedMessageResult.message;
    const systemInputProvenance = normalizeInputProvenance(p.systemInputProvenance);
    const systemProvenanceReceipt = systemReceiptResult.receipt;
    const systemDedupeScope =
      systemInputProvenance || systemProvenanceReceipt
        ? JSON.stringify([systemProvenanceReceipt ?? null, systemInputProvenance ?? null])
        : undefined;
    const stopCommand = !suppressCommandInterpretation && isChatStopCommandText(inboundMessage);
    const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);
    const rawMessage = inboundMessage.trim();
    if (!rawMessage && normalizedAttachments.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "message or attachment required"),
      );
      return;
    }
    const rawSessionKey = p.sessionKey;
    const agentIdOverride = normalizeOptionalText(p.agentId);
    const clientRunId = p.idempotencyKey;
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
      requestedSessionKey: rawSessionKey,
      agentId: agentIdOverride,
    });
    const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
    const sessionLoadStartedAtMs = performance.now();
    const sessionLoadResult = measureDiagnosticsTimelineSpanSync(
      "gateway.chat_send.load_session",
      () => loadSessionEntry(rawSessionKey, sessionLoadOptions),
      {
        phase: "agent-turn",
        attributes: {
          runId: clientRunId,
          hasAttachments: normalizedAttachments.length > 0,
          hasExplicitOrigin: explicitOriginResult.value !== undefined,
        },
      },
    );
    const sessionLoadMs = roundedChatSendTimingMs(performance.now() - sessionLoadStartedAtMs);
    const { cfg, entry, canonicalKey: sessionKey, legacyKey } = sessionLoadResult;
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: rawSessionKey,
      agentId: requestedAgentId,
    });
    if (!selectedAgent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
      return;
    }
    const requestedSessionId = normalizeOptionalText(p.sessionId);
    const backingSessionId = entry?.sessionId ?? requestedSessionId;
    const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, sessionKey, entry, {
      acpMetadataSessionKey: legacyKey ?? sessionKey,
    });
    if (deletedAgentId !== null) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Agent "${deletedAgentId}" no longer exists in configuration`,
        ),
      );
      return;
    }
    const agentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
      agentId: selectedAgent.agentId,
    });
    const activeRunScopeKey = resolveChatSendActiveScopeKey({
      sessionKey,
      agentId: selectedAgent.agentId,
      mainKey: cfg.session?.mainKey,
    });
    const resolvedSessionModel = resolveSessionModelRef(cfg, entry, agentId);
    const resolvedSessionAuthProvider = resolveProviderIdForAuth(resolvedSessionModel.provider, {
      config: cfg,
    });
    let parsedMessage = inboundMessage;
    let parsedImages: ChatImageContent[] = [];
    let imageOrder: PromptImageOrderEntry[] = [];
    let offloadedRefs: OffloadedRef[] = [];
    let mediaPathOffloadPaths: string[] = [];
    let mediaPathOffloadTypes: string[] = [];
    let mediaPathOffloadWorkspaceDir: string | undefined;
    const timeoutMs = resolveAgentTimeoutMs({
      cfg,
      overrideMs: p.timeoutMs,
    });
    const now = Date.now();

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry,
      sessionKey,
      channel: entry?.channel,
      chatType: entry?.chatType,
    });
    if (sendPolicy === "deny") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
      );
      return;
    }

    if (stopCommand) {
      const defaultAgentId = resolveDefaultAgentId(cfg);
      const stopAgentId =
        sessionKey === "global" ? (selectedAgent.agentId ?? defaultAgentId) : selectedAgent.agentId;
      const res = await abortChatRunsForSessionKeyWithPartials({
        context,
        ops: createChatAbortOps(context),
        sessionKey: rawSessionKey,
        sessionKeyAliases: sessionKey === rawSessionKey ? undefined : [sessionKey],
        agentId: stopAgentId,
        sessionId: entry?.sessionId,
        persistSessionKey: sessionKey,
        defaultAgentId,
        abortOrigin: "stop-command",
        stopReason: "stop",
        requester: resolveChatAbortRequester(client),
      });
      if (res.unauthorized) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const cached = context.dedupe.get(`chat:${clientRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }

    const abortMarker = context.chatAbortedRuns.get(clientRunId);
    if (abortMarker !== undefined) {
      const abortedAt = chatAbortMarkerTimestampMs(abortMarker);
      const payload = buildAbortedChatSendPayload({
        runId: clientRunId,
        endedAt: abortedAt,
      });
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${clientRunId}`,
        entry: {
          ts: abortedAt,
          ok: true,
          payload,
        },
      });
      respond(true, payload, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }

    const activeExisting = context.chatAbortControllers.get(clientRunId);
    if (activeExisting) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }
    const clientInfo = client?.connect?.client;
    const chatSendTraceAttributes = {
      runId: clientRunId,
      sessionKey,
      agentId: selectedAgent.agentId ?? agentId,
      provider: resolvedSessionModel.provider,
      model: resolvedSessionModel.model,
      hasAttachments: normalizedAttachments.length > 0,
      hasExplicitOrigin: explicitOriginResult.value !== undefined,
      hasConnectedClient: client?.connect !== undefined,
    };
    const originatingRoute = resolveChatSendOriginatingRoute({
      client: clientInfo,
      deliver: p.deliver,
      entry,
      explicitOrigin: explicitOriginResult.value,
      hasConnectedClient: client?.connect !== undefined,
      mainKey: cfg.session?.mainKey,
      sessionKey,
    });
    const activeChatSendDedupeKey = buildActiveChatSendDedupeKey({
      attachmentCount: normalizedAttachments.length,
      explicitDeliverRoute: originatingRoute.explicitDeliverRoute,
      message: rawMessage,
      originatingChannel: originatingRoute.originatingChannel,
      sessionKey: activeRunScopeKey,
      systemScope: systemDedupeScope,
    });
    if (activeChatSendDedupeKey) {
      const activeRunId = resolveActiveChatSendRunId(
        context.dedupe.get(activeChatSendDedupeKey)?.payload,
      );
      if (activeRunId && context.chatAbortControllers.has(activeRunId)) {
        respond(true, { runId: activeRunId, status: "in_flight" as const }, undefined, {
          cached: true,
          runId: activeRunId,
        });
        return;
      }
    }
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const activeRunAbort = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: clientRunId,
      sessionId: backingSessionId ?? clientRunId,
      sessionKey,
      agentId: selectedAgent.agentId,
      timeoutMs,
      now,
      ownerConnId: normalizeOptionalText(client?.connId),
      ownerDeviceId: normalizeOptionalText(client?.connect?.device?.id),
      providerId: resolvedSessionModel.provider,
      authProviderId: resolvedSessionAuthProvider,
      kind: "chat-send",
      lifecycleGeneration,
    });
    if (!activeRunAbort.registered) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }
    claimAgentRunContext(clientRunId, {
      sessionKey,
      sessionId: backingSessionId ?? clientRunId,
      lifecycleGeneration,
    });
    if (activeChatSendDedupeKey) {
      context.dedupe.set(activeChatSendDedupeKey, {
        ts: now,
        ok: true,
        payload: { runId: clientRunId },
      });
    }
    const explicitOriginTargetsPlugin = explicitOriginTargetsPluginBinding(
      explicitOriginResult.value,
    );
    let prepareAttachmentsMs: number | undefined;
    if (normalizedAttachments.length > 0) {
      const prepareAttachmentsStartedAtMs = performance.now();
      try {
        await measureDiagnosticsTimelineSpan(
          "gateway.chat_send.prepare_attachments",
          async () => {
            const supportsSessionModelImages = await resolveGatewayModelSupportsImages({
              loadGatewayModelCatalog: context.loadGatewayModelCatalog,
              provider: resolvedSessionModel.provider,
              model: resolvedSessionModel.model,
            });
            const explicitOriginSupportsInlineImages =
              explicitOriginTargetsAcpSession(explicitOriginResult.value) ||
              explicitOriginTargetsPlugin;
            // Bound plugin sessions own the real recipient model, so keep image
            // attachments even when the parent OpenClaw session model is text-only.
            const supportsImages = supportsSessionModelImages || explicitOriginSupportsInlineImages;
            const routeImageOffloadsAsMediaPaths = !supportsImages;
            const parsed = await parseMessageWithAttachments(
              inboundMessage,
              normalizedAttachments,
              {
                maxBytes: resolveChatAttachmentMaxBytes(cfg),
                log: context.logGateway,
                supportsImages,
                // chat.send routes selected offloadedRefs into ctx.MediaPaths below
                // so the auto-reply stage pipeline can surface them to the agent.
                acceptNonImage: true,
              },
            );
            parsedMessage = stripTrailingOffloadedMediaMarkers(
              parsed.message,
              routeImageOffloadsAsMediaPaths
                ? parsed.offloadedRefs.filter((ref) => ref.mimeType.startsWith("image/"))
                : [],
            );
            parsedImages = parsed.images;
            imageOrder = routeImageOffloadsAsMediaPaths ? [] : parsed.imageOrder;
            offloadedRefs = parsed.offloadedRefs;
            ({
              paths: mediaPathOffloadPaths,
              types: mediaPathOffloadTypes,
              workspaceDir: mediaPathOffloadWorkspaceDir,
            } = await prestageMediaPathOffloads({
              offloadedRefs,
              // Text-only image offloads need ctx.MediaPaths so media-understanding
              // can describe them via agents.defaults.imageModel. Vision-capable
              // image offloads stay as prompt refs for native image loading.
              includeImageRefs: routeImageOffloadsAsMediaPaths,
              cfg,
              sessionKey,
              agentId,
            }));
          },
          {
            phase: "agent-turn",
            config: cfg,
            attributes: {
              ...chatSendTraceAttributes,
              attachmentCount: normalizedAttachments.length,
            },
          },
        );
        prepareAttachmentsMs = roundedChatSendTimingMs(
          performance.now() - prepareAttachmentsStartedAtMs,
        );
      } catch (err) {
        activeRunAbort.cleanup({ force: true });
        clearAgentRunContext(clientRunId, lifecycleGeneration);
        clearActiveChatSendDedupeRun(context.dedupe, activeChatSendDedupeKey, clientRunId);
        logAttachmentFailure(context.logGateway, "chat.send attachment parse/stage failed", err);
        respond(
          false,
          undefined,
          errorShape(
            err instanceof MediaOffloadError ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
            String(err),
          ),
        );
        return;
      }
    }
    if (activeRunAbort.controller.signal.aborted) {
      const stopReason = activeRunAbort.entry?.abortStopReason ?? "rpc";
      const endedAt = Date.now();
      const payload = buildAbortedChatSendPayload({
        runId: clientRunId,
        stopReason,
        endedAt,
      });
      clearActiveChatSendDedupeRun(context.dedupe, activeChatSendDedupeKey, clientRunId);
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${clientRunId}`,
        entry: {
          ts: endedAt,
          ok: true,
          payload,
        },
      });
      respond(true, payload, undefined, { runId: clientRunId });
      return;
    }

    try {
      const serverTiming = shouldIncludeChatSendAckServerTiming(clientInfo)
        ? {
            receivedToAckMs: roundedChatSendTimingMs(performance.now() - chatSendReceivedAtMs),
            loadSessionMs: sessionLoadMs,
            ...(prepareAttachmentsMs !== undefined ? { prepareAttachmentsMs } : {}),
          }
        : undefined;
      const chatSendTiming: ChatRunTiming | undefined =
        serverTiming && typeof client?.connId === "string" && client.connId.trim()
          ? {
              ackedAtMs: performance.now(),
              connId: client.connId.trim(),
              receivedAtMs: chatSendReceivedAtMs,
            }
          : undefined;
      context.addChatRun(clientRunId, {
        sessionKey,
        agentId: selectedAgent.agentId,
        clientRunId,
        ...(chatSendTiming ? { chatSendTiming } : {}),
      });
      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
        ...(serverTiming ? { serverTiming } : {}),
      };
      emitDiagnosticsTimelineEvent(
        {
          type: "mark",
          name: "gateway.chat_send.ack_ready",
          phase: "agent-turn",
          attributes: {
            ...chatSendTraceAttributes,
            ackStatus: ackPayload.status,
            ...chatSendAckServerTimingAttributes(serverTiming),
          },
        },
        { config: cfg },
      );
      respond(true, ackPayload, undefined, { runId: clientRunId });
      const chatSendAckedAtMs = chatSendTiming?.ackedAtMs ?? performance.now();
      const persistedImagesPromise = persistChatSendImages({
        images: parsedImages,
        imageOrder,
        offloadedRefs,
        client,
        logGateway: context.logGateway,
      });
      let persistedMediaForTranscript: SavedMedia[] | undefined;
      const getPersistedMediaForTranscript = async () => {
        if (!persistedMediaForTranscript) {
          persistedMediaForTranscript = await persistedImagesPromise;
        }
        return persistedMediaForTranscript;
      };
      const preparedUserTurnMediaPromise =
        normalizedAttachments.length > 0 ? getPersistedMediaForTranscript() : Promise.resolve([]);
      const userTurnMediaPromise = preparedUserTurnMediaPromise.then(buildChatSendUserTurnMedia);
      const baseUserTurnInput: UserTurnInput = {
        text: rawMessage,
        timestamp: now,
        idempotencyKey: `${clientRunId}:user`,
        ...(systemInputProvenance ? { provenance: systemInputProvenance } : {}),
      };
      const userTurnInputPromise: Promise<UserTurnInput> = userTurnMediaPromise.then((media) => ({
        ...baseUserTurnInput,
        ...(media.length > 0
          ? {
              media,
              mediaOnlyText: "[User sent media without caption]",
            }
          : {}),
      }));
      const pluginBoundMediaFieldsPromise =
        explicitOriginTargetsPlugin && parsedImages.length > 0
          ? preparedUserTurnMediaPromise.then(resolveChatSendManagedMediaFields)
          : Promise.resolve({});

      const trimmedMessage = parsedMessage.trim();
      const injectThinking = Boolean(
        p.thinking && trimmedMessage && !trimmedMessage.startsWith("/"),
      );
      const commandBody = injectThinking ? `/think ${p.thinking} ${parsedMessage}` : parsedMessage;
      const commandSource =
        !suppressCommandInterpretation && trimmedMessage.startsWith("/") ? "text" : undefined;
      const messageForAgent = systemProvenanceReceipt
        ? [systemProvenanceReceipt, parsedMessage].filter(Boolean).join("\n\n")
        : parsedMessage;
      const {
        originatingChannel,
        originatingTo,
        accountId,
        messageThreadId,
        explicitDeliverRoute,
      } = originatingRoute;
      // The per-message timestamp prefix is now applied at the single LLM
      // boundary (normalizeMessagesForLlmBoundary), derived from each message's
      // own timestamp, so the current turn and all historical turns carry
      // identical bytes on the wire. BodyForAgent uses the same bare text as
      // Body; the transient gateway stamp is removed (stamping the live turn
      // here would diverge from bare stored history and bust the prompt cache).
      // See: https://github.com/openclaw/openclaw/issues/3658
      const ctx: MsgContext = {
        Body: messageForAgent,
        BodyForAgent: messageForAgent,
        BodyForCommands: commandBody,
        RawBody: parsedMessage,
        CommandBody: commandBody,
        InputProvenance: systemInputProvenance,
        SessionKey: sessionKey,
        AgentId: agentId,
        Provider: INTERNAL_MESSAGE_CHANNEL,
        Surface: INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: originatingChannel,
        OriginatingTo: originatingTo,
        ExplicitDeliverRoute: explicitDeliverRoute,
        AccountId: accountId,
        MessageThreadId: messageThreadId,
        ChatType: "direct",
        ...(commandSource ? { CommandSource: commandSource } : {}),
        CommandAuthorized: !suppressCommandInterpretation,
        CommandTurn: commandSource
          ? {
              kind: "text-slash",
              source: commandSource,
              authorized: true,
              body: commandBody,
            }
          : {
              kind: "normal",
              source: "message",
              authorized: false,
              body: commandBody,
            },
        MessageSid: clientRunId,
        ...(!isOperatorUiClient(clientInfo)
          ? {
              SenderId: clientInfo?.id,
              SenderName: clientInfo?.displayName,
              SenderUsername: clientInfo?.displayName,
            }
          : {}),
        GatewayClientScopes: client?.connect?.scopes ?? [],
      };
      const isInternalTextSlashCommandTurn =
        ctx.Provider === INTERNAL_MESSAGE_CHANNEL && ctx.CommandSource === "text";
      if (mediaPathOffloadPaths.length > 0) {
        // Inject offloads via the same MsgContext fields the channel
        // path uses so buildInboundMediaNote renders a real `[media attached:
        // <workspace-relative-path>]` line into the agent prompt. Marker
        // blocks the dispatch pipeline from re-running stageSandboxMedia; see
        // prestageMediaPathOffloads.
        ctx.MediaPath = mediaPathOffloadPaths[0];
        ctx.MediaPaths = mediaPathOffloadPaths;
        ctx.MediaType = mediaPathOffloadTypes[0];
        ctx.MediaTypes = mediaPathOffloadTypes;
        ctx.MediaWorkspaceDir = mediaPathOffloadWorkspaceDir;
        ctx.MediaStaged = true;
      }
      const mediaPathOffloadsIncludeImages = mediaPathOffloadTypes.some((type) =>
        type.startsWith("image/"),
      );
      const replyOptionImages = mediaPathOffloadsIncludeImages
        ? undefined
        : parsedImages.length > 0
          ? parsedImages
          : undefined;

      const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
        cfg,
        agentId,
        channel: INTERNAL_MESSAGE_CHANNEL,
      });
      const deliveredReplies: Array<{ payload: ReplyPayload; kind: "block" | "final" }> = [];
      let appendedWebchatAgentMedia = false;
      let agentRunStarted = false;
      const userTurnRecorder: UserTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
        input: baseUserTurnInput,
        resolveInput: () => userTurnInputPromise,
        target: () => {
          const {
            storePath: latestStorePath,
            store: latestStore,
            entry: latestEntry,
          } = loadSessionEntry(sessionKey, sessionLoadOptions);
          const resolvedSessionId = latestEntry?.sessionId ?? backingSessionId;
          if (!resolvedSessionId) {
            return undefined;
          }
          return {
            sessionId: resolvedSessionId,
            sessionKey,
            sessionEntry: latestEntry ?? entry,
            sessionStore: latestStore,
            storePath: latestStorePath,
            agentId,
            config: cfg,
          };
        },
        errorContext: "gateway chat user turn transcript",
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
        onPersistenceError: (error) => {
          context.logGateway.warn(
            `gateway user transcript persistence failed: ${formatForLog(error)}`,
          );
        },
      });
      const persistGatewayUserTurnTranscript = async () => {
        await measureDiagnosticsTimelineSpan(
          "gateway.chat_send.persist_user_transcript",
          async () => {
            await userTurnRecorder.persistFallback();
          },
          {
            phase: "agent-turn",
            config: cfg,
            attributes: chatSendTraceAttributes,
          },
        );
      };
      const persistGatewayUserTurnTranscriptBestEffort = async () => {
        await persistGatewayUserTurnTranscript().catch(() => undefined);
      };
      const appendWebchatAgentMediaTranscriptIfNeeded = async (payload: ReplyPayload) => {
        if (!agentRunStarted || appendedWebchatAgentMedia || !isMediaBearingPayload(payload)) {
          return;
        }
        if (isSourceReplyTranscriptMirrorPayload(payload)) {
          return;
        }
        const ttsSupplementMarker = buildTtsSupplementTranscriptMarker(payload);
        const [transcriptPayload] = await normalizeWebchatReplyMediaPathsForDisplay({
          cfg,
          sessionKey,
          agentId,
          accountId,
          payloads: [stripVisibleTextFromTtsSupplement(payload)],
        });
        if (!transcriptPayload) {
          return;
        }
        const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
          sessionKey,
          sessionLoadOptions,
        );
        const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
        const resolvedTranscriptPath = resolveTranscriptPath({
          sessionId,
          storePath: latestStorePath,
          sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
          agentId,
        });
        const mediaLocalRoots = appendLocalMediaParentRoots(
          getAgentScopedMediaLocalRoots(cfg, agentId),
          resolvedTranscriptPath ? [resolvedTranscriptPath] : undefined,
        );
        const assistantContent = await buildAssistantDisplayContentFromReplyPayloads({
          sessionKey,
          agentId,
          payloads: [transcriptPayload],
          managedImageLocalRoots: mediaLocalRoots,
          includeSensitiveMedia: transcriptPayload.sensitiveMedia !== true,
          onLocalAudioAccessDenied: (message) => {
            context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
          },
          onManagedImagePrepareError: (message) => {
            context.logGateway.warn(`webchat image embedding skipped attachment: ${message}`);
          },
        });
        const mediaMessage = await buildWebchatAssistantMediaMessage([transcriptPayload], {
          localRoots: mediaLocalRoots,
          onLocalAudioAccessDenied: (message) => {
            context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
          },
        });
        const persistedAssistantContent = replaceAssistantContentTextBlocks(
          assistantContent,
          mediaMessage,
        );
        const persistedContentForAppend = hasAssistantDisplayMediaContent(persistedAssistantContent)
          ? persistedAssistantContent
          : undefined;
        if (!persistedContentForAppend?.length) {
          return;
        }
        const transcriptReply =
          mediaMessage?.transcriptText ??
          extractAssistantDisplayTextFromContent(assistantContent) ??
          buildTranscriptReplyText([transcriptPayload]);
        if (!transcriptReply && !persistedAssistantContent?.length && !assistantContent?.length) {
          return;
        }
        const appended = await appendAssistantTranscriptMessage({
          sessionKey,
          message: transcriptReply,
          ...(persistedContentForAppend?.length ? { content: persistedContentForAppend } : {}),
          sessionId,
          storePath: latestStorePath,
          sessionFile: latestEntry?.sessionFile,
          agentId,
          createIfMissing: true,
          idempotencyKey: `${clientRunId}:assistant-media`,
          ttsSupplement: ttsSupplementMarker,
          cfg,
        });
        if (appended.ok) {
          if (appended.messageId && assistantContent?.length) {
            await attachManagedOutgoingImagesToMessage({
              messageId: appended.messageId,
              blocks: assistantContent,
            });
          }
          appendedWebchatAgentMedia = true;
          return;
        }
        context.logGateway.warn(
          `webchat transcript append failed for media reply: ${appended.error ?? "unknown error"}`,
        );
      };
      const dispatcher = createReplyDispatcher({
        ...replyPipeline,
        onError: (err) => {
          context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
        },
        deliver: async (payload, info) => {
          if (getReplyPayloadMetadata(payload)?.beforeAgentRunBlocked === true) {
            userTurnRecorder.markBlocked();
          }
          switch (info.kind) {
            case "block":
            case "final":
              deliveredReplies.push({ payload, kind: info.kind });
              await appendWebchatAgentMediaTranscriptIfNeeded(payload);
              break;
            case "tool":
              // Tool results that carry audio (e.g. the TTS tool) must be promoted
              // to "final" so the downstream audio extraction path can pick them up.
              // Strip text to avoid leaking tool summary into the combined reply.
              if (isMediaBearingPayload(payload)) {
                deliveredReplies.push({
                  payload: { ...payload, text: undefined },
                  kind: "final",
                });
              }
              break;
          }
        },
      });

      const emitServerTiming = (
        phase: ChatSendServerTimingPhase,
        extra?: Record<string, string | number>,
        dispatchStartedAtMs?: number,
      ) => {
        emitOperatorChatSendServerTiming({
          context,
          client,
          phase,
          runId: clientRunId,
          sessionKey,
          agentId,
          receivedAtMs: chatSendReceivedAtMs,
          ackedAtMs: chatSendAckedAtMs,
          dispatchStartedAtMs,
          extra,
        });
      };
      const dispatchStartedAtMs = performance.now();
      if (chatSendTiming) {
        chatSendTiming.dispatchStartedAtMs = dispatchStartedAtMs;
      }
      emitServerTiming("dispatch-started");
      let firstAssistantServerTimingEmitted = false;
      const emitFirstAssistantServerTiming = () => {
        if (firstAssistantServerTimingEmitted || chatSendTiming?.firstAssistantEventSent) {
          return;
        }
        firstAssistantServerTimingEmitted = true;
        if (chatSendTiming) {
          chatSendTiming.firstAssistantEventSent = true;
        }
        emitServerTiming("first-assistant-event", undefined, dispatchStartedAtMs);
      };
      void measureDiagnosticsTimelineSpan(
        "gateway.chat_send.dispatch_inbound",
        async () => {
          applyChatSendManagedMediaFields(ctx, await pluginBoundMediaFieldsPromise);
          const dispatchResult = await dispatchInboundMessage({
            ctx,
            cfg,
            dispatcher,
            onSessionMetadataChanges: (changes) => {
              for (const change of changes) {
                emitSessionsChanged(context, change);
              }
            },
            replyOptions: {
              runId: clientRunId,
              ...(isOperatorUiClient(clientInfo)
                ? {
                    promptCacheKey: resolveWebchatPromptCacheKey({
                      agentId,
                      provider: resolvedSessionModel.provider,
                      model: resolvedSessionModel.model,
                      sessionKey: activeRunScopeKey,
                    }),
                  }
                : {}),
              abortSignal: activeRunAbort.controller.signal,
              images: replyOptionImages,
              imageOrder: imageOrder.length > 0 ? imageOrder : undefined,
              thinkingLevelOverride: p.thinking,
              fastModeOverride: p.fastMode,
              userTurnTranscriptRecorder: userTurnRecorder,
              onAgentRunStart: (runId) => {
                agentRunStarted = true;
                emitServerTiming(
                  "agent-run-started",
                  runId !== clientRunId ? { agentRunId: runId } : undefined,
                  dispatchStartedAtMs,
                );
                const connId = typeof client?.connId === "string" ? client.connId : undefined;
                const wantsToolEvents = hasGatewayClientCap(
                  client?.connect?.caps,
                  GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
                );
                if (connId && wantsToolEvents) {
                  context.registerToolEventRecipient(runId, connId);
                  // Register for any other active runs *in the same session* so
                  // late-joining clients (e.g. page refresh mid-response) receive
                  // in-progress tool events without leaking cross-session data.
                  const defaultAgentId = resolveDefaultAgentId(cfg);
                  const selectedGlobalAgentId =
                    sessionKey === "global" ? (selectedAgent.agentId ?? defaultAgentId) : undefined;
                  for (const [activeRunId, active] of context.chatAbortControllers) {
                    const activeGlobalAgentId =
                      active.sessionKey === "global"
                        ? (active.agentId ?? defaultAgentId)
                        : undefined;
                    const sameSelectedGlobalAgent =
                      sessionKey === "global" &&
                      selectedGlobalAgentId !== undefined &&
                      activeGlobalAgentId === selectedGlobalAgentId;
                    const sameSession =
                      active.sessionKey === sessionKey &&
                      (sessionKey !== "global" || sameSelectedGlobalAgent);
                    if (activeRunId !== runId && sameSession) {
                      context.registerToolEventRecipient(activeRunId, connId);
                    }
                  }
                }
              },
              onModelSelected: (modelSelection) => {
                updateChatRunProvider(context.chatAbortControllers, {
                  runId: clientRunId,
                  providerId: modelSelection.provider,
                  authProviderId: resolveProviderIdForAuth(modelSelection.provider, {
                    config: cfg,
                  }),
                });
                onModelSelected(modelSelection);
                emitServerTiming(
                  "model-selected",
                  {
                    provider: modelSelection.provider,
                    model: modelSelection.model,
                  },
                  dispatchStartedAtMs,
                );
              },
            },
          });
          if (dispatchResult.beforeAgentRunBlocked === true) {
            userTurnRecorder.markBlocked();
          }
          return dispatchResult;
        },
        {
          phase: "agent-turn",
          config: cfg,
          attributes: chatSendTraceAttributes,
        },
      )
        .then(async () => {
          emitServerTiming("dispatch-completed", undefined, dispatchStartedAtMs);
          const postDispatchStartedAtMs = performance.now();
          await measureDiagnosticsTimelineSpan(
            "gateway.chat_send.post_dispatch",
            async () => {
              const returnedAgentErrorPayloads = agentRunStarted
                ? deliveredReplies
                    .map((entryInner) => entryInner.payload)
                    .filter((payload) => payload.isError)
                : [];
              const returnedAgentErrorMessage =
                returnedAgentErrorPayloads
                  .map((payload) => payload.text?.trim())
                  .filter((text): text is string => Boolean(text))
                  .join(" | ") || undefined;
              if (
                agentRunStarted &&
                returnedAgentErrorPayloads.length > 0 &&
                !userTurnRecorder.hasPersisted() &&
                !userTurnRecorder.isBlocked()
              ) {
                await persistGatewayUserTurnTranscriptBestEffort();
              }
              if (
                agentRunStarted &&
                returnedAgentErrorPayloads.length === 0 &&
                !userTurnRecorder.hasPersisted() &&
                !userTurnRecorder.isBlocked() &&
                userTurnRecorder.hasRuntimePersistencePending()
              ) {
                await persistGatewayUserTurnTranscriptBestEffort();
              }
              let broadcastedSourceReplyFinal = false;
              // WebChat persistence has two owners. Agent runs persist model-visible turns
              // through OpenClaw runtime's SessionManager; this dispatcher only owns live delivery payloads.
              // Do not blindly mirror agent-run final payloads into JSONL or chat.history can
              // duplicate normal embedded-agent assistant turns. The non-agent branch below has no
              // runtime-owned assistant turn, so it appends a gateway-injected assistant entry before
              // broadcasting the final UI event.
              if (!agentRunStarted) {
                const btwReplies = deliveredReplies
                  .map((entryScoped) => entryScoped.payload)
                  .filter(isBtwReplyPayload);
                const btwText = btwReplies
                  .map((payload) => payload.text.trim())
                  .filter(Boolean)
                  .join("\n\n")
                  .trim();
                if (btwReplies.length > 0 && btwText) {
                  broadcastSideResult({
                    context,
                    payload: {
                      kind: "btw",
                      runId: clientRunId,
                      sessionKey,
                      ...(sessionKey === "global" && agentId ? { agentId } : {}),
                      question: btwReplies[0].btw.question.trim(),
                      text: btwText,
                      isError: btwReplies.some((payload) => payload.isError),
                      ts: Date.now(),
                    },
                  });
                  broadcastChatFinal({
                    context,
                    runId: clientRunId,
                    sessionKey,
                    agentId,
                  });
                } else {
                  const finalPayloadEntries = deliveredReplies.filter(
                    (entryItem) => entryItem.kind === "final",
                  );
                  const parseReplyInlineDirectives = (payload: ReplyPayload) =>
                    typeof payload.text === "string" && payload.text.includes("[[")
                      ? parseInlineDirectives(payload.text)
                      : undefined;
                  const shouldFoldCommandBlocks = isInternalTextSlashCommandTurn;
                  const commandBlockPayloadEntries = shouldFoldCommandBlocks
                    ? deliveredReplies.filter((entryItem) => entryItem.kind === "block")
                    : [];
                  const replyMediaUrls = (payload: ReplyPayload) =>
                    resolveSendableOutboundReplyParts(payload).mediaUrls;
                  const normalizeCommandMediaDedupeKey = (value: string): string => {
                    const trimmed = value.trim();
                    if (!trimmed) {
                      return "";
                    }
                    if (!trimmed.toLowerCase().startsWith("file://")) {
                      return path.isAbsolute(trimmed) ? path.normalize(trimmed) : trimmed;
                    }
                    try {
                      const parsed = new URL(trimmed);
                      if (parsed.protocol === "file:") {
                        return path.normalize(fileURLToPath(parsed));
                      }
                    } catch {
                      // Keep malformed file URL-like values comparable with the fallback below.
                    }
                    return trimmed.replace(/^file:\/\//iu, "");
                  };
                  const replyMediaDedupeKeys = (payload: ReplyPayload) =>
                    replyMediaUrls(payload).map((mediaUrl) =>
                      normalizeCommandMediaDedupeKey(mediaUrl),
                    );
                  const canonicalizeReplyMedia = (payload: ReplyPayload): ReplyPayload => {
                    const mediaUrls = replyMediaUrls(payload);
                    return {
                      ...payload,
                      mediaUrl: undefined,
                      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
                    };
                  };
                  const mergeDefinedReplySemantics = (
                    target: ReplyPayload,
                    source: ReplyPayload,
                  ): ReplyPayload => {
                    const sourceInlineDirectives = parseReplyInlineDirectives(source);
                    const sourceReplyToId =
                      sanitizeReplyDirectiveId(source.replyToId) ??
                      sanitizeReplyDirectiveId(sourceInlineDirectives?.replyToExplicitId);
                    return {
                      ...target,
                      ...(source.trustedLocalMedia === true || target.trustedLocalMedia === true
                        ? { trustedLocalMedia: true }
                        : {}),
                      ...(source.sensitiveMedia === true || target.sensitiveMedia === true
                        ? { sensitiveMedia: true }
                        : {}),
                      ...(source.presentation !== undefined
                        ? { presentation: source.presentation }
                        : {}),
                      ...(source.delivery !== undefined ? { delivery: source.delivery } : {}),
                      ...(source.interactive !== undefined
                        ? { interactive: source.interactive }
                        : {}),
                      ...(sourceReplyToId !== undefined ? { replyToId: sourceReplyToId } : {}),
                      ...(source.replyToTag === true || target.replyToTag === true
                        ? { replyToTag: true }
                        : {}),
                      ...(source.replyToCurrent === true ||
                      sourceInlineDirectives?.replyToCurrent === true ||
                      target.replyToCurrent === true
                        ? { replyToCurrent: true }
                        : {}),
                      ...(source.audioAsVoice === true ||
                      sourceInlineDirectives?.audioAsVoice === true ||
                      target.audioAsVoice === true
                        ? { audioAsVoice: true }
                        : {}),
                      ...(source.spokenText !== undefined ? { spokenText: source.spokenText } : {}),
                      ...(source.ttsSupplement !== undefined
                        ? { ttsSupplement: source.ttsSupplement }
                        : {}),
                      ...(source.isError === true || target.isError === true
                        ? { isError: true }
                        : {}),
                      ...(source.channelData !== undefined
                        ? { channelData: source.channelData }
                        : {}),
                    };
                  };
                  const mergeMediaReplySemantics = (
                    target: ReplyPayload,
                    source: ReplyPayload,
                  ): ReplyPayload => {
                    const sourceInlineDirectives = parseReplyInlineDirectives(source);
                    return {
                      ...target,
                      ...(source.trustedLocalMedia === true || target.trustedLocalMedia === true
                        ? { trustedLocalMedia: true }
                        : {}),
                      ...(source.sensitiveMedia === true || target.sensitiveMedia === true
                        ? { sensitiveMedia: true }
                        : {}),
                      ...(source.audioAsVoice === true ||
                      sourceInlineDirectives?.audioAsVoice === true ||
                      target.audioAsVoice === true
                        ? { audioAsVoice: true }
                        : {}),
                    };
                  };
                  const hasMergeableReplySemantics = (payload: ReplyPayload): boolean => {
                    const inlineDirectives = parseReplyInlineDirectives(payload);
                    return Boolean(
                      payload.trustedLocalMedia !== undefined ||
                      payload.sensitiveMedia !== undefined ||
                      payload.presentation ||
                      payload.delivery ||
                      payload.interactive ||
                      payload.replyToId ||
                      payload.replyToTag !== undefined ||
                      payload.replyToCurrent !== undefined ||
                      payload.audioAsVoice !== undefined ||
                      inlineDirectives?.hasReplyTag ||
                      inlineDirectives?.hasAudioTag ||
                      payload.spokenText ||
                      payload.ttsSupplement ||
                      payload.isError !== undefined ||
                      payload.channelData,
                    );
                  };
                  const hasUnmergedReplySemantics = (payload: ReplyPayload): boolean =>
                    Boolean(
                      payload.isReasoning ||
                      payload.isReasoningSnapshot ||
                      payload.isCompactionNotice ||
                      payload.isFallbackNotice ||
                      payload.isStatusNotice ||
                      payload.btw,
                    );
                  const hasReplySemantics = (payload: ReplyPayload): boolean =>
                    hasMergeableReplySemantics(payload) || hasUnmergedReplySemantics(payload);
                  const mediaSetsMatch = (
                    leftMediaUrls: readonly string[],
                    rightMediaUrls: readonly string[],
                  ): boolean => {
                    if (leftMediaUrls.length !== rightMediaUrls.length) {
                      return false;
                    }
                    return leftMediaUrls.every(
                      (mediaUrl, index) => mediaUrl === rightMediaUrls[index],
                    );
                  };
                  const replyDisplayText = (payload: ReplyPayload): string =>
                    sanitizeAssistantDisplayText(payload.text) ?? "";
                  const commandBlockPayloadEntriesForDelivery = commandBlockPayloadEntries.map(
                    (entryItem) => ({
                      kind: entryItem.kind,
                      payload: canonicalizeReplyMedia(entryItem.payload),
                    }),
                  );
                  const sensitiveMediaDedupeKeys = new Set(
                    finalPayloadEntries.flatMap((entryItem) =>
                      entryItem.payload.sensitiveMedia === true
                        ? replyMediaDedupeKeys(entryItem.payload).filter(Boolean)
                        : [],
                    ),
                  );
                  if (sensitiveMediaDedupeKeys.size > 0) {
                    for (const entryItem of commandBlockPayloadEntriesForDelivery) {
                      if (
                        replyMediaDedupeKeys(entryItem.payload).some((key) =>
                          sensitiveMediaDedupeKeys.has(key),
                        )
                      ) {
                        entryItem.payload = { ...entryItem.payload, sensitiveMedia: true };
                      }
                    }
                  }
                  const finalPayloadEntriesForDelivery = shouldFoldCommandBlocks
                    ? finalPayloadEntries.flatMap((entryItem) => {
                        const finalMediaUrls = replyMediaUrls(entryItem.payload);
                        const finalMediaKeys = replyMediaDedupeKeys(entryItem.payload);
                        const finalDisplayText = replyDisplayText(entryItem.payload);
                        const matchingMediaBlockEntry =
                          finalMediaUrls.length > 0
                            ? commandBlockPayloadEntriesForDelivery.find((candidate) =>
                                mediaSetsMatch(
                                  replyMediaDedupeKeys(candidate.payload),
                                  finalMediaKeys,
                                ),
                              )
                            : undefined;
                        const matchingTextBlockEntry = finalDisplayText
                          ? commandBlockPayloadEntriesForDelivery.find(
                              (candidate) =>
                                replyDisplayText(candidate.payload) === finalDisplayText,
                            )
                          : undefined;
                        const matchingMediaAndTextBlockEntry =
                          finalMediaUrls.length > 0 && finalDisplayText
                            ? commandBlockPayloadEntriesForDelivery.find(
                                (candidate) =>
                                  replyDisplayText(candidate.payload) === finalDisplayText &&
                                  mediaSetsMatch(
                                    replyMediaDedupeKeys(candidate.payload),
                                    finalMediaKeys,
                                  ),
                              )
                            : undefined;
                        const duplicateBlockEntry =
                          finalMediaUrls.length > 0
                            ? finalDisplayText
                              ? matchingMediaAndTextBlockEntry
                              : matchingMediaBlockEntry
                            : finalMediaUrls.length === 0
                              ? matchingTextBlockEntry
                              : undefined;
                        if (duplicateBlockEntry) {
                          duplicateBlockEntry.payload = mergeDefinedReplySemantics(
                            duplicateBlockEntry.payload,
                            entryItem.payload,
                          );
                        } else if (matchingMediaBlockEntry) {
                          matchingMediaBlockEntry.payload = mergeMediaReplySemantics(
                            matchingMediaBlockEntry.payload,
                            entryItem.payload,
                          );
                        }
                        const remainingFinalMediaUrls = matchingMediaBlockEntry
                          ? []
                          : finalMediaUrls;
                        if (
                          remainingFinalMediaUrls.length === 0 &&
                          ((duplicateBlockEntry && !hasUnmergedReplySemantics(entryItem.payload)) ||
                            (!duplicateBlockEntry &&
                              !finalDisplayText &&
                              !hasReplySemantics(entryItem.payload)))
                        ) {
                          return [];
                        }
                        return [
                          {
                            ...entryItem,
                            payload: {
                              ...entryItem.payload,
                              mediaUrl: undefined,
                              mediaUrls:
                                remainingFinalMediaUrls.length > 0
                                  ? remainingFinalMediaUrls
                                  : undefined,
                            },
                          },
                        ];
                      })
                    : finalPayloadEntries;
                  // Non-agent command paths can enqueue only block replies. If no visible final
                  // supersedes them, fold those blocks into the final WebChat message.
                  const rawFinalPayloads = appendedWebchatAgentMedia
                    ? []
                    : [
                        ...commandBlockPayloadEntriesForDelivery,
                        ...finalPayloadEntriesForDelivery,
                      ].map((entryCandidate) => entryCandidate.payload);
                  const finalPayloads = await normalizeWebchatReplyMediaPathsForDisplay({
                    cfg,
                    sessionKey,
                    agentId,
                    accountId,
                    payloads: rawFinalPayloads,
                  });
                  const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
                    sessionKey,
                    sessionLoadOptions,
                  );
                  const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
                  const resolvedTranscriptPath = resolveTranscriptPath({
                    sessionId,
                    storePath: latestStorePath,
                    sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
                    agentId,
                  });
                  const mediaLocalRoots = appendLocalMediaParentRoots(
                    getAgentScopedMediaLocalRoots(cfg, agentId),
                    resolvedTranscriptPath ? [resolvedTranscriptPath] : undefined,
                  );
                  const assistantContent = await buildAssistantDisplayContentFromReplyPayloads({
                    sessionKey,
                    agentId,
                    payloads: finalPayloads,
                    managedImageLocalRoots: mediaLocalRoots,
                    includeSensitiveMedia: false,
                    onLocalAudioAccessDenied: (message) => {
                      context.logGateway.warn(
                        `webchat audio embedding denied local path: ${message}`,
                      );
                    },
                    onManagedImagePrepareError: (message) => {
                      context.logGateway.warn(
                        `webchat image embedding skipped attachment: ${message}`,
                      );
                    },
                  });
                  const mediaMessage = await buildWebchatAssistantMediaMessage(finalPayloads, {
                    localRoots: mediaLocalRoots,
                    onLocalAudioAccessDenied: (message) => {
                      context.logGateway.warn(
                        `webchat audio embedding denied local path: ${message}`,
                      );
                    },
                  });
                  const hasSensitiveMedia = hasSensitiveMediaPayload(finalPayloads);
                  const ttsSupplementMarker = finalPayloads
                    .map((payload) => buildMediaOnlyTtsSupplementTranscriptMarker(payload))
                    .find((marker): marker is GatewayInjectedTtsSupplementMarker =>
                      Boolean(marker),
                    );
                  const persistedAssistantContent = replaceAssistantContentTextBlocks(
                    hasSensitiveMedia
                      ? await buildAssistantDisplayContentFromReplyPayloads({
                          sessionKey,
                          agentId,
                          payloads: finalPayloads,
                          managedImageLocalRoots: mediaLocalRoots,
                          includeSensitiveMedia: false,
                          onLocalAudioAccessDenied: (message) => {
                            context.logGateway.warn(
                              `webchat audio embedding denied local path: ${message}`,
                            );
                          },
                          onManagedImagePrepareError: (message) => {
                            context.logGateway.warn(
                              `webchat image embedding skipped attachment: ${message}`,
                            );
                          },
                        })
                      : assistantContent,
                    mediaMessage,
                  );
                  const persistedContentForAppend = hasAssistantDisplayMediaContent(
                    persistedAssistantContent,
                  )
                    ? persistedAssistantContent
                    : undefined;
                  const broadcastAssistantContent = hasAssistantDisplayMediaContent(
                    assistantContent,
                  )
                    ? assistantContent
                    : hasAssistantDisplayMediaContent(mediaMessage?.content)
                      ? mediaMessage?.content
                      : assistantContent;
                  const displayReply =
                    extractAssistantDisplayTextFromContent(assistantContent) ??
                    buildTranscriptReplyText(finalPayloads);
                  const transcriptDisplayReply = displayReply
                    ? stripInlineDirectiveTagsForDisplay(displayReply).text.trim()
                    : "";
                  const transcriptReply =
                    mediaMessage?.transcriptText ||
                    buildTranscriptReplyText(finalPayloads) ||
                    transcriptDisplayReply;
                  let message: Record<string, unknown> | undefined;
                  const shouldAppendAssistantTranscript = Boolean(
                    transcriptReply || persistedContentForAppend?.length,
                  );
                  if (shouldAppendAssistantTranscript) {
                    await persistGatewayUserTurnTranscriptBestEffort();
                  } else {
                    await persistGatewayUserTurnTranscriptBestEffort();
                  }
                  if (shouldAppendAssistantTranscript) {
                    const appended = await appendAssistantTranscriptMessage({
                      sessionKey,
                      message: transcriptReply,
                      ...(persistedContentForAppend?.length
                        ? { content: persistedContentForAppend }
                        : {}),
                      sessionId,
                      storePath: latestStorePath,
                      sessionFile: latestEntry?.sessionFile,
                      agentId,
                      createIfMissing: true,
                      idempotencyKey: clientRunId,
                      ttsSupplement: ttsSupplementMarker,
                      cfg,
                    });
                    if (appended.ok) {
                      if (appended.messageId && assistantContent?.length) {
                        await attachManagedOutgoingImagesToMessage({
                          messageId: appended.messageId,
                          blocks: assistantContent,
                        });
                      }
                      message = broadcastAssistantContent?.length
                        ? { ...appended.message, content: broadcastAssistantContent }
                        : appended.message;
                    } else {
                      context.logGateway.warn(
                        `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
                      );
                      const fallbackAssistantContent =
                        stripManagedOutgoingAssistantContentBlocks(persistedAssistantContent) ??
                        stripManagedOutgoingAssistantContentBlocks(assistantContent);
                      const fallbackText =
                        extractAssistantDisplayText(fallbackAssistantContent) ?? displayReply;
                      const nowValue = Date.now();
                      message = {
                        role: "assistant",
                        ...(fallbackAssistantContent?.length
                          ? { content: fallbackAssistantContent }
                          : fallbackText
                            ? { content: [{ type: "text", text: fallbackText }] }
                            : {}),
                        ...(fallbackText ? { text: fallbackText } : {}),
                        timestamp: nowValue,
                        ...(ttsSupplementMarker
                          ? { openclawTtsSupplement: ttsSupplementMarker }
                          : {}),
                        // Keep this compatible with runner stopReason enums even though this message isn't
                        // persisted to the transcript due to the append failure.
                        stopReason: "stop",
                        usage: { input: 0, output: 0, totalTokens: 0 },
                      };
                    }
                  } else if (broadcastAssistantContent?.length) {
                    message = {
                      role: "assistant",
                      content: broadcastAssistantContent,
                      text: extractAssistantDisplayText(broadcastAssistantContent) ?? "",
                      timestamp: Date.now(),
                      stopReason: "stop",
                      usage: { input: 0, output: 0, totalTokens: 0 },
                    };
                  }
                  if (hasVisibleAssistantFinalMessage(message)) {
                    emitFirstAssistantServerTiming();
                  }
                  broadcastChatFinal({
                    context,
                    runId: clientRunId,
                    sessionKey,
                    agentId,
                    message,
                  });
                }
              } else {
                const hasReturnedAgentErrorPayloads = returnedAgentErrorPayloads.length > 0;
                const agentRunReplyPayloads = deliveredReplies
                  .filter((entryEntry) => entryEntry.kind === "final")
                  .map((entryResult) => entryResult.payload)
                  .filter(
                    (payload) =>
                      isSourceReplyTranscriptMirrorPayload(payload) ||
                      (!hasReturnedAgentErrorPayloads && isReplyPayloadStatusNotice(payload)),
                  );
                if (agentRunReplyPayloads.length > 0) {
                  const hasSourceReplyTranscriptMirror = agentRunReplyPayloads.some(
                    isSourceReplyTranscriptMirrorPayload,
                  );
                  const finalPayloads = await normalizeWebchatReplyMediaPathsForDisplay({
                    cfg,
                    sessionKey,
                    agentId,
                    accountId,
                    payloads: agentRunReplyPayloads,
                  });
                  const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
                    sessionKey,
                    sessionLoadOptions,
                  );
                  const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
                  const resolvedTranscriptPath = resolveTranscriptPath({
                    sessionId,
                    storePath: latestStorePath,
                    sessionFile: latestEntry?.sessionFile ?? entry?.sessionFile,
                    agentId,
                  });
                  const mediaLocalRoots = appendLocalMediaParentRoots(
                    getAgentScopedMediaLocalRoots(cfg, agentId),
                    resolvedTranscriptPath ? [resolvedTranscriptPath] : undefined,
                  );
                  const buildReplyAssistantContent = async (
                    payloads: typeof finalPayloads,
                  ): Promise<AssistantDisplayContentBlock[] | undefined> =>
                    await buildAssistantDisplayContentFromReplyPayloads({
                      sessionKey,
                      agentId,
                      payloads,
                      managedImageLocalRoots: mediaLocalRoots,
                      includeSensitiveMedia: false,
                      onLocalAudioAccessDenied: (message) => {
                        context.logGateway.warn(
                          `webchat audio embedding denied local path: ${message}`,
                        );
                      },
                      onManagedImagePrepareError: (message) => {
                        context.logGateway.warn(
                          `webchat image embedding skipped attachment: ${message}`,
                        );
                      },
                    });
                  const buildReplyMediaMessage = async (payloads: typeof finalPayloads) =>
                    await buildWebchatAssistantMediaMessage(payloads, {
                      localRoots: mediaLocalRoots,
                      onLocalAudioAccessDenied: (message) => {
                        context.logGateway.warn(
                          `webchat audio embedding denied local path: ${message}`,
                        );
                      },
                    });
                  const combinedAssistantContent =
                    agentRunReplyPayloads.length === 1
                      ? await buildReplyAssistantContent(finalPayloads)
                      : undefined;
                  const combinedMediaMessage =
                    agentRunReplyPayloads.length === 1
                      ? await buildReplyMediaMessage(finalPayloads)
                      : undefined;
                  type SourceReplyContentState = {
                    broadcastContent: AssistantDisplayContentBlock[];
                    persistedContent: AssistantDisplayContentBlock[];
                    hasManagedOutgoingContent: boolean;
                    backedManagedOutgoingContent: boolean;
                  };
                  const sourceReplyContentStates: SourceReplyContentState[] = [];
                  const sourceReplyBroadcastContent: AssistantDisplayContentBlock[] = [];
                  for (const [replyIndex] of agentRunReplyPayloads.entries()) {
                    const finalPayload = finalPayloads[replyIndex];
                    if (!finalPayload) {
                      continue;
                    }
                    const replyAssistantContent =
                      agentRunReplyPayloads.length === 1
                        ? combinedAssistantContent
                        : await buildReplyAssistantContent([finalPayload]);
                    const replyMediaMessage =
                      agentRunReplyPayloads.length === 1
                        ? combinedMediaMessage
                        : await buildReplyMediaMessage([finalPayload]);
                    const replyBroadcastContent = hasAssistantDisplayMediaContent(
                      replyAssistantContent,
                    )
                      ? replyAssistantContent
                      : hasAssistantDisplayMediaContent(replyMediaMessage?.content)
                        ? replyMediaMessage?.content
                        : replyAssistantContent;
                    const persistedContent = replaceAssistantContentTextBlocks(
                      replyAssistantContent,
                      replyMediaMessage ?? null,
                    );
                    const state: SourceReplyContentState = {
                      broadcastContent: replyBroadcastContent ? [...replyBroadcastContent] : [],
                      persistedContent: persistedContent ? [...persistedContent] : [],
                      hasManagedOutgoingContent:
                        hasManagedOutgoingAssistantContent(persistedContent),
                      backedManagedOutgoingContent: false,
                    };
                    sourceReplyContentStates[replyIndex] = state;
                    if (state.broadcastContent.length > 0) {
                      sourceReplyBroadcastContent.push(...state.broadcastContent);
                    }
                  }

                  const displayReply =
                    extractAssistantDisplayTextFromContent(sourceReplyBroadcastContent) ??
                    buildTranscriptReplyText(finalPayloads);
                  if (sourceReplyBroadcastContent.length || displayReply) {
                    const sourceReplyPersistenceRequests: Array<{
                      idempotencyKey: string;
                      metadata: NonNullable<
                        ReturnType<typeof getReplyPayloadMetadata>
                      >["sourceReplyTranscriptMirror"];
                      state: SourceReplyContentState;
                    }> = [];
                    for (const [
                      replyIndex,
                      sourceReplyPayload,
                    ] of agentRunReplyPayloads.entries()) {
                      const state = sourceReplyContentStates[replyIndex];
                      if (!state || !hasAssistantDisplayMediaContent(state.persistedContent)) {
                        continue;
                      }
                      const mirrorMetadata =
                        getReplyPayloadMetadata(sourceReplyPayload)?.sourceReplyTranscriptMirror;
                      const mirrorIdempotencyKey = mirrorMetadata?.idempotencyKey;
                      if (
                        typeof mirrorIdempotencyKey !== "string" ||
                        mirrorIdempotencyKey.trim().length === 0
                      ) {
                        continue;
                      }
                      if (!state.hasManagedOutgoingContent) {
                        state.backedManagedOutgoingContent = true;
                      }
                      sourceReplyPersistenceRequests.push({
                        idempotencyKey: mirrorIdempotencyKey,
                        metadata: mirrorMetadata,
                        state,
                      });
                    }

                    const attachSourceReplyManagedImages = async (paramsLocal: {
                      messageId?: string;
                      request: (typeof sourceReplyPersistenceRequests)[number];
                    }) => {
                      if (!paramsLocal.request.state.hasManagedOutgoingContent) {
                        paramsLocal.request.state.backedManagedOutgoingContent = true;
                        return;
                      }
                      if (!paramsLocal.messageId) {
                        return;
                      }
                      await attachManagedOutgoingImagesToMessage({
                        messageId: paramsLocal.messageId,
                        blocks: paramsLocal.request.state.persistedContent,
                      });
                      paramsLocal.request.state.backedManagedOutgoingContent = true;
                    };

                    if (resolvedTranscriptPath && sourceReplyPersistenceRequests.length > 0) {
                      const allowedSourceReplyMirrorIds = new Set<string>();
                      for (const [
                        replyIndex,
                        sourceReplyPayload,
                      ] of agentRunReplyPayloads.entries()) {
                        if (!sourceReplyContentStates[replyIndex]) {
                          continue;
                        }
                        const mirrorIdempotencyKey =
                          getReplyPayloadMetadata(sourceReplyPayload)?.sourceReplyTranscriptMirror
                            ?.idempotencyKey;
                        const mirrorMetadata =
                          getReplyPayloadMetadata(sourceReplyPayload)?.sourceReplyTranscriptMirror;
                        if (
                          typeof mirrorIdempotencyKey !== "string" ||
                          mirrorIdempotencyKey.trim().length === 0 ||
                          !mirrorMetadata
                        ) {
                          continue;
                        }
                        const target = await findSourceReplyTranscriptMirrorByMetadata({
                          transcriptPath: resolvedTranscriptPath,
                          idempotencyKey: mirrorIdempotencyKey,
                          metadata: mirrorMetadata,
                        });
                        if (target) {
                          allowedSourceReplyMirrorIds.add(target.messageId);
                        }
                      }
                      const rewriteTargets: Array<{
                        request: (typeof sourceReplyPersistenceRequests)[number];
                        messageId: string;
                        message: Record<string, unknown>;
                      }> = [];
                      for (const request of sourceReplyPersistenceRequests) {
                        const target = await findSourceReplyTranscriptMirrorByMetadata({
                          transcriptPath: resolvedTranscriptPath,
                          idempotencyKey: request.idempotencyKey,
                          metadata: request.metadata,
                        });
                        if (target) {
                          rewriteTargets.push({ request, ...target });
                        }
                      }

                      if (rewriteTargets.length > 0) {
                        const rewriteTargetIds = new Set(
                          rewriteTargets.map((target) => target.messageId),
                        );
                        const rewriteIndex = await readSessionTranscriptIndex(
                          resolvedTranscriptPath,
                          { view: "all" },
                        );
                        const firstRewriteEntryIndex =
                          rewriteIndex?.entries.findIndex(
                            (entryValue) =>
                              typeof entryValue.id === "string" &&
                              rewriteTargetIds.has(entryValue.id),
                          ) ?? -1;
                        const canRewriteSourceReplyMirrors =
                          firstRewriteEntryIndex >= 0 &&
                          rewriteIndex?.entries
                            .slice(firstRewriteEntryIndex)
                            .every(
                              (entryLocal) =>
                                typeof entryLocal.id !== "string" ||
                                allowedSourceReplyMirrorIds.has(entryLocal.id),
                            ) === true;
                        if (canRewriteSourceReplyMirrors) {
                          const result = await rewriteTranscriptEntriesInRuntimeTranscript({
                            scope: {
                              sessionId,
                              sessionKey,
                              sessionFile: resolvedTranscriptPath,
                              agentId,
                              ...(latestStorePath ? { storePath: latestStorePath } : {}),
                            },
                            request: {
                              allowedRewriteSuffixEntryIds: [...allowedSourceReplyMirrorIds],
                              replacements: rewriteTargets.map((target) => ({
                                entryId: target.messageId,
                                message: {
                                  ...(target.message as unknown as AgentMessage),
                                  idempotencyKey: target.request.idempotencyKey,
                                  content: target.request.state.persistedContent,
                                } as unknown as AgentMessage,
                              })),
                            },
                            config: cfg,
                          });
                          if (result.changed) {
                            await advanceSessionTranscriptMarker({
                              storePath: latestStorePath,
                              sessionKey,
                              sessionId,
                            });
                            for (const target of rewriteTargets) {
                              const rewritten =
                                await findSourceReplyTranscriptMirrorByIdempotencyKey(
                                  resolvedTranscriptPath,
                                  target.request.idempotencyKey,
                                );
                              await attachSourceReplyManagedImages({
                                messageId: rewritten?.messageId,
                                request: target.request,
                              });
                            }
                          }
                        }
                      }
                    }
                    const sourceReplyContent = sourceReplyContentStates
                      .flatMap((state) => {
                        if (
                          state.hasManagedOutgoingContent &&
                          !state.backedManagedOutgoingContent
                        ) {
                          const stripped = stripManagedOutgoingAssistantContentBlocks(
                            state.broadcastContent,
                          );
                          return stripped?.length
                            ? stripped
                            : [{ type: "text", text: "Media reply could not be displayed." }];
                        }
                        return state.broadcastContent;
                      })
                      .filter((block): block is AssistantDisplayContentBlock => Boolean(block));
                    const sourceReplyTextFromContent =
                      extractAssistantDisplayTextFromContent(sourceReplyContent);
                    const sourceReplyText =
                      sourceReplyTextFromContent ??
                      (sourceReplyContent.length === 0 ? displayReply : undefined);
                    const nowLocal = Date.now();
                    const message = {
                      role: "assistant",
                      ...(sourceReplyContent?.length
                        ? { content: sourceReplyContent }
                        : sourceReplyText
                          ? { content: [{ type: "text", text: sourceReplyText }] }
                          : {}),
                      ...(sourceReplyText ? { text: sourceReplyText } : {}),
                      timestamp: nowLocal,
                      stopReason: "stop",
                      usage: { input: 0, output: 0, totalTokens: 0 },
                    };
                    if (hasVisibleAssistantFinalMessage(message)) {
                      emitFirstAssistantServerTiming();
                    }
                    broadcastChatFinal({
                      context,
                      runId: clientRunId,
                      sessionKey,
                      agentId,
                      message,
                    });
                    broadcastedSourceReplyFinal = hasSourceReplyTranscriptMirror;
                  }
                }
              }
              const shouldBroadcastAgentError =
                returnedAgentErrorPayloads.length > 0 && !broadcastedSourceReplyFinal;
              if (shouldBroadcastAgentError) {
                broadcastChatError({
                  context,
                  runId: clientRunId,
                  sessionKey,
                  agentId,
                  errorMessage: returnedAgentErrorMessage,
                });
              }
              if (!context.chatAbortedRuns.has(clientRunId)) {
                const returnedAgentError = shouldBroadcastAgentError
                  ? errorShape(
                      ErrorCodes.UNAVAILABLE,
                      returnedAgentErrorMessage ?? "agent returned an error payload",
                    )
                  : undefined;
                setGatewayDedupeEntry({
                  dedupe: context.dedupe,
                  key: `chat:${clientRunId}`,
                  entry: {
                    ts: Date.now(),
                    ok: !shouldBroadcastAgentError,
                    payload: shouldBroadcastAgentError
                      ? {
                          runId: clientRunId,
                          status: "error" as const,
                          summary: returnedAgentErrorMessage ?? "agent returned an error payload",
                        }
                      : { runId: clientRunId, status: "ok" as const },
                    ...(returnedAgentError ? { error: returnedAgentError } : {}),
                  },
                });
              }
            },
            {
              phase: "agent-turn",
              config: cfg,
              attributes: chatSendTraceAttributes,
            },
          );
          emitServerTiming(
            "post-dispatch-completed",
            {
              postDispatchMs: roundedChatSendTimingMs(performance.now() - postDispatchStartedAtMs),
            },
            dispatchStartedAtMs,
          );
        })
        .catch(async (err: unknown) => {
          const emitAfterError =
            userTurnRecorder.hasPersisted() || userTurnRecorder.isBlocked()
              ? Promise.resolve()
              : persistGatewayUserTurnTranscript();
          await emitAfterError.catch((transcriptErr: unknown) => {
            context.logGateway.warn(
              `webchat user transcript update failed after error: ${formatForLog(transcriptErr)}`,
            );
          });
          const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: {
              ts: Date.now(),
              ok: false,
              payload: {
                runId: clientRunId,
                status: "error" as const,
                summary: String(err),
              },
              error,
            },
          });
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey,
            agentId,
            errorMessage: String(err),
          });
        })
        .finally(() => {
          activeRunAbort.cleanup();
          clearAgentRunContext(clientRunId, lifecycleGeneration);
          clearActiveChatSendDedupeRun(context.dedupe, activeChatSendDedupeKey, clientRunId);
          context.removeChatRun(clientRunId, clientRunId, sessionKey);
        });
    } catch (err) {
      activeRunAbort.cleanup({ force: true });
      clearAgentRunContext(clientRunId, lifecycleGeneration);
      clearActiveChatSendDedupeRun(context.dedupe, activeChatSendDedupeKey, clientRunId);
      context.removeChatRun(clientRunId, clientRunId, sessionKey);
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(err),
      };
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${clientRunId}`,
        entry: {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        },
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(err),
      });
      broadcastChatError({
        context,
        runId: clientRunId,
        sessionKey,
        agentId,
        errorMessage: String(err),
      });
    }
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      agentId?: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const rawSessionKey = p.sessionKey;
    const requestedAgentId = resolveRequestedChatAgentId({
      cfg: (context as { getRuntimeConfig?: () => OpenClawConfig }).getRuntimeConfig?.(),
      requestedSessionKey: rawSessionKey,
      agentId: p.agentId,
    });
    const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
    const {
      cfg,
      storePath,
      entry,
      canonicalKey: sessionKey,
    } = loadSessionEntry(rawSessionKey, sessionLoadOptions);
    const selectedAgent = validateChatSelectedAgent({
      cfg,
      requestedSessionKey: rawSessionKey,
      agentId: requestedAgentId,
    });
    if (!selectedAgent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
      return;
    }
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }
    const agentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
      agentId: selectedAgent.agentId,
    });

    const appended = await appendAssistantTranscriptMessage({
      sessionKey,
      message: p.message,
      label: p.label,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      agentId,
      createIfMissing: true,
      cfg,
    });
    if (!appended.ok || !appended.messageId || !appended.message) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to write transcript: ${appended.error ?? "unknown error"}`,
        ),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const message = projectChatDisplayMessage(appended.message, {
      maxChars: resolveEffectiveChatHistoryMaxChars(cfg),
    });
    const chatPayload = {
      runId: `inject-${appended.messageId}`,
      sessionKey,
      ...(sessionKey === "global" && agentId ? { agentId } : {}),
      seq: 0,
      state: "final" as const,
      message,
    };
    context.broadcast("chat", chatPayload);
    sendGlobalAwareNodeChatPayload({
      context,
      sessionKey,
      agentId,
      event: "chat",
      payload: chatPayload,
    });

    respond(true, { ok: true, messageId: appended.messageId });
  },
};

// oxlint-disable max-lines -- deferred split, see docs/adr/0006-deferred-monster-splits.md
/**
 * OpenAI-compatible streaming transport.
 *
 * Handles Chat Completions, Responses, Azure variants, tool-call replay, reasoning events, and
 * provider-specific payload policy before converting SDK streams into OpenClaw assistant events.
 */
import { createHash, randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import OpenAI, { AzureOpenAI } from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItemList,
  ResponseInput,
  ResponseInputItem,
  ResponseInputMessageContentList,
} from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../../llm/env-api-keys.js";
import { calculateCost } from "../../llm/model-utils.js";
import { resolveAzureDeploymentNameFromMap } from "../../llm/providers/azure-deployment-map.js";
import { convertMessages } from "../../llm/providers/openai-completions.js";
import { clampOpenAIPromptCacheKey } from "../../llm/providers/openai-prompt-cache.js";
import type { Api, Context, Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { parseStreamingJson } from "../../llm/utils/json-parse.js";
import type { ProviderRuntimeModel } from "../../plugins/providers/provider-runtime-model.types.js";
import { resolveProviderTransportTurnStateWithPlugin } from "../../plugins/providers/provider-runtime.js";
import { isOpenAICompatibleAzureResponsesBaseUrl } from "../../shared/azure-openai-responses-client-compat.js";
import {
  isResponsesTextContentPartType,
  isResponsesTextDeltaEventType,
} from "../../shared/openai-responses-stream-compat.js";
import { createReasoningTagTextPartitioner } from "../../shared/text/reasoning-tag-text-partitioner.js";
import { supportsModelTools } from "../models/model-tool-support.js";
import {
  emitModelTransportDebug,
  resolveModelPayloadDebugMode,
  resolveModelSseDebugMode,
} from "../models/model-transport-debug.js";
import { formatModelTransportDebugBaseUrl } from "../models/model-transport-url.js";
import { stripSystemPromptCacheBoundary } from "../prompt/system-prompt-cache-boundary.js";
import type { StreamFn } from "../runtime/index.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./copilot-dynamic-headers.js";
import { createDeepSeekTextFilter } from "./deepseek-text-filter.js";
import { hasOpenAICompatibleConversationTurn } from "./openai-compatible-conversation-turn.js";
import { detectOpenAICompletionsCompat } from "./openai-completions-compat.js";
import {
  flattenCompletionMessagesToStringContent,
  stripCompletionMessagesToRoleContent,
} from "./openai-completions-string-content.js";
import {
  isOpenAIGpt54MiniModel,
  isOpenAIGpt55Model,
  normalizeOpenAIReasoningEffort,
  resolveOpenAIReasoningEffortForModel,
  type OpenAIApiReasoningEffort,
} from "./openai-reasoning-effort.js";
import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "./openai-responses-payload-policy.js";
import { resolveReplayableResponsesMessageId } from "./openai-responses-replay.js";
import { resolveOpenAIStrictToolSetting } from "./openai-strict-tool-setting.js";
import {
  reconcileOpenAICompletionsToolChoice,
  reconcileOpenAIResponsesToolChoice,
} from "./openai-tool-projection.js";
import {
  buildResponsesInputMessage,
  ensureOpenAICodexResponsesInput,
  isOpenAICodexResponsesModel,
  resolveOpenAICodexResponsesInstructions,
  resolveOpenAIResponsesTextFormat,
  sanitizeOpenAICodexResponsesParams,
  usesNativeOpenAICodexResponsesBackend,
} from "./openai-transport-stream.codex.js";
import { getCompat } from "./openai-transport-stream.compat.js";
import {
  sanitizeCompletionsReasoningReplayFields,
  shouldPreserveOpenRouterReasoningReplay,
  shouldPreserveReasoningContentReplay,
} from "./openai-transport-stream.completions-reasoning-replay.js";
import {
  applyQwenOpenAICompletionsThinkingParams,
  applyTogetherOpenAICompletionsThinkingParams,
  estimateOpenAICompletionsInputTokens,
  resolveOpenAICompletionsEffectiveContextTokens,
  resolveOpenAICompletionsMaxTokens,
  resolveOpenAICompletionsModelMaxTokens,
  resolveOpenAICompletionsReasoningEffort,
  shouldEmitOpenAICompletionsReasoning,
  shouldEmitOpenAICompletionsReasoningForModel,
} from "./openai-transport-stream.completions-tokens.js";
import {
  AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS,
  DEFAULT_AZURE_OPENAI_API_VERSION,
  MODEL_STREAM_COOPERATIVE_YIELD_INTERVAL_MS,
  MODEL_STREAM_COOPERATIVE_YIELD_MAX_EVENTS,
  OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY,
  OPENAI_RESPONSES_REASONING_REPLAY_META_KEY,
  OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH,
  log,
} from "./openai-transport-stream.constants.js";
import {
  type RecoveredDeepSeekDsmlToolCall,
  createDeepSeekDsmlToolCallRecoverer,
  shouldFilterDeepSeekDsmlText,
} from "./openai-transport-stream.deepseek-dsml.js";
import {
  applyServiceTierPricing,
  assertCodeModeResponsesToolSurface,
  enforceCodeModeResponsesToolSurface,
  responseInputRoles,
  responseInputTextChars,
  safeDebugValue,
  stringifyJsonLike,
  stringifyRedactedEvent,
  stringifyRedactedPayload,
  stringifyUnknown,
  summarizeResponsesTools,
} from "./openai-transport-stream.payload-debug.js";
import {
  buildResponsesFailedNoDetailsObservation,
  logResponsesFailedNoDetails,
  normalizeResponsesFailedEvent,
  summarizeResponsesFailedNoDetailsObservation,
} from "./openai-transport-stream.responses-failed.js";
import {
  convertResponsesTools,
  convertTools,
  extractGoogleThoughtSignature,
  injectToolCallThoughtSignatures,
} from "./openai-transport-stream.tool-signatures.js";
import type {
  BaseStreamOptions,
  MutableAssistantOutput,
  OpenAICompletionsOptions,
  OpenAIModeModel,
  OpenAIResponsesOptions,
  OpenAIResponsesReasoningReplayMetadata,
  OpenAIResponsesReplayContext,
  ReplayableResponseOutputMessage,
  ReplayableResponseReasoningItem,
} from "./openai-transport-stream.types.js";
import { resolveProviderEndpoint } from "./provider-attribution.js";
import { resolveProviderRequestPolicyConfig } from "./provider-request-config.js";
import {
  buildGuardedModelFetch,
  resolveModelRequestTimeoutMs,
} from "./provider-transport-fetch.js";
import { sanitizeResponsesImagePayload } from "./responses-image-payload-sanitizer.js";
import { transformTransportMessages } from "./transport-message-transform.js";
import {
  assignTransportErrorDetails,
  mergeTransportMetadata,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";

type ResponsesClientLike = ReturnType<typeof createOpenAIResponsesClient>;

type ModelStreamCooperativeScheduler = {
  afterEvent: () => Promise<void>;
};

function throwIfModelStreamAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Request was aborted");
  }
}

function createModelStreamCooperativeScheduler(
  signal?: AbortSignal,
): ModelStreamCooperativeScheduler {
  let lastYieldedAt = Date.now();
  let eventsSinceYield = 0;
  return {
    async afterEvent() {
      throwIfModelStreamAborted(signal);
      eventsSinceYield += 1;
      const now = Date.now();
      if (
        eventsSinceYield < MODEL_STREAM_COOPERATIVE_YIELD_MAX_EVENTS &&
        now - lastYieldedAt < MODEL_STREAM_COOPERATIVE_YIELD_INTERVAL_MS
      ) {
        return;
      }
      eventsSinceYield = 0;
      lastYieldedAt = now;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      throwIfModelStreamAborted(signal);
    },
  };
}

export { sanitizeTransportPayloadText } from "./transport-stream-shared.js";

function summarizeResponsesPayload(params: unknown): string {
  if (!params || typeof params !== "object") {
    return "payload=non-object";
  }
  const record = params as Record<string, unknown>;
  const input = record.input;
  const reasoning =
    record.reasoning && typeof record.reasoning === "object"
      ? (record.reasoning as Record<string, unknown>)
      : undefined;
  const text =
    record.text && typeof record.text === "object"
      ? (record.text as Record<string, unknown>)
      : undefined;
  const parts = [
    `fields=${Object.keys(record).toSorted().join(",")}`,
    `model=${safeDebugValue(record.model)}`,
    `stream=${safeDebugValue(record.stream)}`,
    `inputItems=${Array.isArray(input) ? input.length : typeof input}`,
    `inputRoles=${responseInputRoles(input) || "none"}`,
    `inputTextChars=${responseInputTextChars(input)}`,
    `tools=${summarizeResponsesTools(record.tools)}`,
    `reasoningEffort=${safeDebugValue(reasoning?.effort)}`,
    `reasoningSummary=${safeDebugValue(reasoning?.summary)}`,
    `textVerbosity=${safeDebugValue(text?.verbosity)}`,
    `serviceTier=${safeDebugValue(record.service_tier)}`,
    `store=${safeDebugValue(record.store)}`,
    `promptCacheKey=${record.prompt_cache_key === undefined ? "absent" : "present"}`,
    `metadataKeys=${
      record.metadata && typeof record.metadata === "object"
        ? Object.keys(record.metadata).toSorted().join(",")
        : "none"
    }`,
  ];
  if (resolveModelPayloadDebugMode() === "full-redacted") {
    parts.push(`payload=${stringifyRedactedPayload(record)}`);
  }
  return parts.join(" ");
}

function summarizeOpenAITransportError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return `type=${typeof error} message=${safeDebugValue(error)}`;
  }
  const record = error as Record<string, unknown>;
  const cause =
    record.cause && typeof record.cause === "object"
      ? (record.cause as Record<string, unknown>)
      : undefined;
  return [
    `name=${safeDebugValue(record.name)}`,
    `status=${safeDebugValue(record.status)}`,
    `code=${safeDebugValue(record.code)}`,
    `type=${safeDebugValue(record.type)}`,
    `causeName=${safeDebugValue(cause?.name)}`,
    `causeCode=${safeDebugValue(cause?.code)}`,
    `message=${error instanceof Error ? error.message : safeDebugValue(error)}`,
  ].join(" ");
}

function isInvalidEncryptedContentError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: unknown; message?: unknown };
  if (record.code === "invalid_encrypted_content" || record.code === "thinking_signature_invalid") {
    return true;
  }
  return (
    typeof record.message === "string" &&
    (record.message.includes("invalid_encrypted_content") ||
      record.message.includes("thinking_signature_invalid"))
  );
}

function stripEncryptedContentFields(value: unknown): { value: unknown; changed: boolean } {
  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const stripped = stripEncryptedContentFields(item);
      changed ||= stripped.changed;
      return stripped.value;
    });
    return changed ? { value: next, changed: true } : { value, changed: false };
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "encrypted_content") {
      changed = true;
      continue;
    }
    const stripped = stripEncryptedContentFields(child);
    changed ||= stripped.changed;
    next[key] = stripped.value;
  }
  return changed ? { value: next, changed: true } : { value, changed: false };
}

function stripResponsesRequestEncryptedContent(
  params: OpenAIResponsesRequestParams,
): OpenAIResponsesRequestParams {
  const stripped = stripEncryptedContentFields(params.input);
  if (!stripped.changed) {
    return params;
  }
  return {
    ...params,
    input: stripped.value as ResponseInput,
  };
}

function hashOptionalReplayContextValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? shortHash(normalized) : undefined;
}

function buildOpenAIResponsesReplayContext(
  model: Model,
  options?: Pick<BaseStreamOptions, "authProfileId" | "sessionId">,
): OpenAIResponsesReplayContext {
  return {
    provider: model.provider,
    api: model.api,
    model: model.id,
    baseUrlHash: hashOptionalReplayContextValue(model.baseUrl),
    sessionHash: hashOptionalReplayContextValue(options?.sessionId),
    authProfileHash: hashOptionalReplayContextValue(options?.authProfileId),
  };
}

function buildOpenAIResponsesReasoningReplayMetadata(
  model: Model,
  options?: Pick<BaseStreamOptions, "authProfileId" | "sessionId">,
): OpenAIResponsesReasoningReplayMetadata {
  return {
    v: 1,
    source: "openai-responses",
    ...buildOpenAIResponsesReplayContext(model, options),
  };
}

function tagOpenAIResponsesReasoningReplayItem(
  item: Record<string, unknown>,
  model: Model,
  options?: Pick<BaseStreamOptions, "authProfileId" | "sessionId">,
): Record<string, unknown> {
  if (!("encrypted_content" in item)) {
    return item;
  }
  return {
    ...item,
    [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]: buildOpenAIResponsesReasoningReplayMetadata(
      model,
      options,
    ),
  };
}

function isOpenAIResponsesReasoningReplayMetadata(
  value: unknown,
): value is OpenAIResponsesReasoningReplayMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    record.source === "openai-responses" &&
    typeof record.provider === "string" &&
    typeof record.api === "string" &&
    typeof record.model === "string" &&
    (record.baseUrlHash === undefined || typeof record.baseUrlHash === "string") &&
    (record.sessionHash === undefined || typeof record.sessionHash === "string") &&
    (record.authProfileHash === undefined || typeof record.authProfileHash === "string")
  );
}

function encryptedReasoningReplayMetadataMatches(
  metadata: OpenAIResponsesReasoningReplayMetadata | undefined,
  context: OpenAIResponsesReplayContext,
): boolean {
  if (!metadata) {
    return false;
  }
  return (
    metadata.provider === context.provider &&
    metadata.api === context.api &&
    metadata.model === context.model &&
    metadata.baseUrlHash === context.baseUrlHash &&
    metadata.sessionHash === context.sessionHash &&
    metadata.authProfileHash === context.authProfileHash
  );
}

function readOpenAIResponsesReasoningReplayBlockMetadata(
  block: Record<string, unknown>,
): OpenAIResponsesReasoningReplayMetadata | undefined {
  const value = block[OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY];
  return isOpenAIResponsesReasoningReplayMetadata(value) ? value : undefined;
}

function normalizeOpenAIResponsesReasoningReplayItem(
  item: ReplayableResponseReasoningItem,
): ReplayableResponseReasoningItem {
  const record = item as ReplayableResponseReasoningItem & Record<string, unknown>;
  if (record.type !== "reasoning" || Array.isArray(record.summary)) {
    return item;
  }
  return { ...record, summary: [] } as ReplayableResponseReasoningItem;
}

function prepareOpenAIResponsesReasoningItemForReplay(
  item: ReplayableResponseReasoningItem,
  context: OpenAIResponsesReplayContext,
  blockMetadata?: OpenAIResponsesReasoningReplayMetadata,
): ReplayableResponseReasoningItem {
  const { [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]: rawMetadata, ...rest } =
    item as ReplayableResponseReasoningItem & Record<string, unknown>;
  if (!("encrypted_content" in rest)) {
    return normalizeOpenAIResponsesReasoningReplayItem(rest as ReplayableResponseReasoningItem);
  }
  const metadata =
    blockMetadata ??
    (isOpenAIResponsesReasoningReplayMetadata(rawMetadata) ? rawMetadata : undefined);
  if (encryptedReasoningReplayMetadataMatches(metadata, context)) {
    return normalizeOpenAIResponsesReasoningReplayItem(rest as ReplayableResponseReasoningItem);
  }
  const stripped = stripEncryptedContentFields(rest);
  return normalizeOpenAIResponsesReasoningReplayItem(
    stripped.value as ReplayableResponseReasoningItem,
  );
}

async function createResponsesStreamWithEncryptedContentRetry(params: {
  client: ResponsesClientLike;
  request: OpenAIResponsesRequestParams;
  requestOptions: unknown;
  model: Model;
}): Promise<AsyncIterable<unknown>> {
  try {
    return (await params.client.responses.create(
      params.request as never,
      params.requestOptions as never,
    )) as unknown as AsyncIterable<unknown>;
  } catch (error) {
    const retryRequest = stripResponsesRequestEncryptedContent(params.request);
    if (!isInvalidEncryptedContentError(error) || retryRequest === params.request) {
      throw error;
    }
    log.warn(
      `[responses] retrying without encrypted reasoning content provider=${params.model.provider} ` +
        `api=${params.model.api} model=${params.model.id}`,
    );
    return (await params.client.responses.create(
      retryRequest as never,
      params.requestOptions as never,
    )) as unknown as AsyncIterable<unknown>;
  }
}

export function resolveAzureOpenAIApiVersion(env = process.env): string {
  return env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeResponsesReplayItemId(
  id: string | undefined,
  prefix: string,
): string | undefined {
  if (!id) {
    return undefined;
  }
  if (id.length <= OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH) {
    return id;
  }
  return `${prefix}_${shortHash(id)}`;
}

function isSafeResponsesReplayItemId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH
  );
}

function encodeTextSignatureV1(id: string, phase?: "commentary" | "final_answer"): string {
  return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) });
}

function parseTextSignature(
  signature: string | undefined,
): { id?: string; phase?: "commentary" | "final_answer" } | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown };
      if (parsed.v === 1) {
        const id = typeof parsed.id === "string" ? parsed.id : undefined;
        const phase =
          parsed.phase === "commentary" || parsed.phase === "final_answer"
            ? parsed.phase
            : undefined;
        // A reasoning-dropped replay keeps the phase but omits the paired id.
        if (id !== undefined || phase !== undefined) {
          return { id, phase };
        }
        return undefined;
      }
    } catch {
      // Keep legacy plain-string behavior below.
    }
  }
  return { id: signature };
}

function convertResponsesMessages(
  model: Model,
  context: Context,
  allowedToolCallProviders: Set<string>,
  options?: {
    includeSystemPrompt?: boolean;
    supportsDeveloperRole?: boolean;
    replayReasoningItems?: boolean;
    replayResponsesItemIds?: boolean;
    sessionId?: string;
    authProfileId?: string;
  },
): ResponseInput {
  const messages: ResponseInput = [];
  const shouldReplayReasoningItems = options?.replayReasoningItems ?? true;
  const shouldReplayResponsesItemIds = options?.replayResponsesItemIds ?? true;
  const replayContext = buildOpenAIResponsesReplayContext(model, {
    sessionId: options?.sessionId,
    authProfileId: options?.authProfileId,
  });
  const shouldNormalizeSameModelToolCallIds = model.provider === "github-copilot";
  const sanitizeIdPart = (part: string) => part.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+$/, "");
  const normalizeIdPart = (part: string) => {
    const sanitized = sanitizeIdPart(part);
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };
  const buildForeignResponsesItemId = (itemId: string) => {
    const normalized = `fc_${shortHash(itemId)}`;
    return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
  };
  const buildSameProviderCopilotResponsesItemId = (itemId: string) => {
    const sanitized = sanitizeIdPart(itemId);
    const candidate = sanitized.startsWith("fc_") ? sanitized : `fc_${sanitized}`;
    return candidate.length > 64 ? buildForeignResponsesItemId(itemId) : candidate;
  };
  const normalizeToolCallId = (
    id: string,
    _targetModel: Model,
    source: { provider: string; api: Api },
  ) => {
    if (!allowedToolCallProviders.has(model.provider)) {
      return normalizeIdPart(id);
    }
    if (!id.includes("|")) {
      return normalizeIdPart(id);
    }
    const [callId, itemId] = id.split("|");
    const normalizedCallId = normalizeIdPart(callId);
    const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
    let normalizedItemId = isForeignToolCall
      ? buildForeignResponsesItemId(itemId)
      : model.provider === "github-copilot"
        ? buildSameProviderCopilotResponsesItemId(itemId)
        : normalizeIdPart(itemId);
    if (!normalizedItemId.startsWith("fc_")) {
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    }
    return `${normalizedCallId}|${normalizedItemId}`;
  };
  const transformedMessages = transformTransportMessages(
    context.messages,
    model,
    normalizeToolCallId,
    { normalizeSameModelToolCallIds: shouldNormalizeSameModelToolCallIds },
  );
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    messages.push(
      buildResponsesInputMessage(
        model.reasoning && options?.supportsDeveloperRole !== false ? "developer" : "system",
        [
          {
            type: "input_text",
            text: sanitizeTransportPayloadText(
              stripSystemPromptCacheBoundary(context.systemPrompt),
            ),
          },
        ],
      ),
    );
  }
  let msgIndex = 0;
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push(
          buildResponsesInputMessage("user", [
            { type: "input_text", text: sanitizeTransportPayloadText(msg.content) },
          ]),
        );
      } else {
        const content = (
          msg.content.map((item) =>
            item.type === "text"
              ? { type: "input_text", text: sanitizeTransportPayloadText(item.text) }
              : {
                  type: "input_image",
                  detail: "auto",
                  image_url: `data:${item.mimeType};base64,${item.data}`,
                },
          ) as ResponseInputMessageContentList
        ).filter((item) => model.input.includes("image") || item.type !== "input_image");
        if (content.length > 0) {
          messages.push(buildResponsesInputMessage("user", content));
        }
      }
    } else if (msg.role === "assistant") {
      const output: ResponseInput = [];
      let textFallbackOrdinal = 0;
      let previousReplayItemWasReasoning = false;
      const isDifferentModel =
        msg.model !== model.id && msg.provider === model.provider && msg.api === model.api;
      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (
            shouldReplayReasoningItems &&
            block.thinkingSignature &&
            block.thinkingSignature.startsWith("{")
          ) {
            // openai-completions plain-text reasoning paths persist a
            // provenance tag (e.g. "reasoning", "reasoning_details", "content")
            // as thinkingSignature rather than a JSON-encoded reasoning item.
            // Replaying those values would corrupt the next request payload
            // (OpenRouter returns HTTP 500), so skip non-JSON signatures.
            const reasoningItem = JSON.parse(
              block.thinkingSignature,
            ) as ReplayableResponseReasoningItem;
            const replayableReasoningItem = prepareOpenAIResponsesReasoningItemForReplay(
              reasoningItem,
              replayContext,
              readOpenAIResponsesReasoningReplayBlockMetadata(
                block as unknown as Record<string, unknown>,
              ),
            );
            if (!shouldReplayResponsesItemIds) {
              delete replayableReasoningItem.id;
            }
            if (
              shouldReplayResponsesItemIds &&
              model.provider === "github-copilot" &&
              !isSafeResponsesReplayItemId(replayableReasoningItem.id)
            ) {
              continue;
            }
            output.push(replayableReasoningItem as ResponseInputItem);
            previousReplayItemWasReasoning = true;
          }
        } else if (block.type === "text") {
          const textSignature = parseTextSignature(block.textSignature);
          let msgId = resolveReplayableResponsesMessageId({
            replayResponsesItemIds: shouldReplayResponsesItemIds,
            textSignatureId: textSignature?.id,
            fallbackId: `msg_${msgIndex}`,
            fallbackOrdinal: textFallbackOrdinal,
            previousReplayItemWasReasoning,
          });
          if (!textSignature?.id) {
            textFallbackOrdinal += 1;
          }
          msgId = normalizeResponsesReplayItemId(msgId, "msg");
          const messageItem: ReplayableResponseOutputMessage = {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: sanitizeTransportPayloadText(block.text),
                annotations: [],
              },
            ],
            status: "completed",
            ...(msgId ? { id: msgId } : {}),
            phase: textSignature?.phase,
          };
          output.push(messageItem as ResponseInputItem);
          previousReplayItemWasReasoning = false;
        } else if (block.type === "toolCall") {
          const [callId, itemIdRaw] = block.id.split("|");
          const itemId =
            shouldReplayResponsesItemIds && !(isDifferentModel && itemIdRaw?.startsWith("fc_"))
              ? itemIdRaw
              : undefined;
          output.push({
            type: "function_call",
            ...(itemId ? { id: itemId } : {}),
            call_id: callId,
            name: block.name,
            arguments:
              typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments ?? {}),
          });
          previousReplayItemWasReasoning = false;
        }
      }
      if (output.length > 0) {
        messages.push(...output);
      }
    } else if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const hasImages = msg.content.some((item) => item.type === "image");
      const [callId] = msg.toolCallId.split("|");
      messages.push({
        type: "function_call_output",
        call_id: callId,
        output:
          hasImages && model.input.includes("image")
            ? ([
                ...(textResult
                  ? [{ type: "input_text", text: sanitizeTransportPayloadText(textResult) }]
                  : []),
                ...msg.content
                  .filter((item) => item.type === "image")
                  .map((item) => ({
                    type: "input_image",
                    detail: "auto",
                    image_url: `data:${item.mimeType};base64,${item.data}`,
                  })),
              ] as ResponseFunctionCallOutputItemList)
            : sanitizeTransportPayloadText(textResult || "(see attached image)"),
      });
    }
    msgIndex += 1;
  }
  return messages;
}

function createResponsesFirstEventTimeoutError(model: Model, timeoutMs: number): Error {
  return new Error(
    `Azure OpenAI Responses stream did not deliver a first event within ${timeoutMs}ms after HTTP streaming headers. ` +
      `provider=${model.provider} model=${model.id}. ` +
      "The provider may be stalled while parsing the tool payload; retry with a smaller tool surface or enable OPENCLAW_DEBUG_MODEL_PAYLOAD=tools to inspect exposed tools.",
  );
}

function withResponsesFirstEventTimeout(
  openaiStream: AsyncIterable<unknown>,
  model: Model,
  timeoutMs: number | undefined,
): AsyncIterable<unknown> {
  if (timeoutMs === undefined || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return openaiStream;
  }
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = openaiStream[Symbol.asyncIterator]();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clear = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      try {
        const first = await new Promise<IteratorResult<unknown>>((resolve, reject) => {
          timer = setTimeout(
            () => reject(createResponsesFirstEventTimeoutError(model, timeoutMs)),
            timeoutMs,
          );
          iterator.next().then(resolve, reject);
        }).finally(clear);
        if (first.done) {
          return;
        }
        yield first.value;
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            return;
          }
          yield next.value;
        }
      } catch (error) {
        void iterator.return?.().catch(() => undefined);
        throw error;
      } finally {
        clear();
      }
    },
  };
}

async function processResponsesStream(
  openaiStream: AsyncIterable<unknown>,
  output: MutableAssistantOutput,
  stream: { push(event: unknown): void },
  model: Model,
  options?: {
    serviceTier?: ResponseCreateParamsStreaming["service_tier"];
    applyServiceTierPricing?: (
      usage: MutableAssistantOutput["usage"],
      serviceTier?: ResponseCreateParamsStreaming["service_tier"],
    ) => void;
    firstEventTimeoutMs?: number;
    signal?: AbortSignal;
    sessionId?: string;
    authProfileId?: string;
  },
) {
  let currentItem: Record<string, unknown> | null = null;
  let currentBlock: Record<string, unknown> | null = null;
  const streamStartedAt = Date.now();
  let eventCount = 0;
  const eventTypes = new Map<string, number>();
  const sseDebugMode = resolveModelSseDebugMode();
  const blockIndex = () => output.content.length - 1;
  const appendCompletedResponseTextItem = (item: Record<string, unknown>) => {
    const text = readResponsesOutputMessageText(item);
    if (!text) {
      return;
    }
    const block: Record<string, unknown> = {
      type: "text",
      text,
      textSignature: encodeTextSignatureV1(
        stringifyUnknown(item.id),
        (item.phase as "commentary" | "final_answer" | undefined) ?? undefined,
      ),
    };
    output.content.push(block);
    stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
    stream.push({
      type: "text_end",
      contentIndex: blockIndex(),
      content: text,
      partial: output,
    });
  };
  const appendCompletedResponseToolCallItem = (item: Record<string, unknown>) => {
    const args = parseStreamingJson(stringifyJsonLike(item.arguments, "{}"));
    const block = {
      type: "toolCall",
      id: `${stringifyUnknown(item.call_id)}|${stringifyUnknown(item.id)}`,
      name: stringifyUnknown(item.name),
      arguments: args,
      partialJson: stringifyJsonLike(item.arguments, "{}"),
    };
    output.content.push(block);
    stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
    stream.push({
      type: "toolcall_end",
      contentIndex: blockIndex(),
      toolCall: {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: args,
      },
      partial: output,
    });
  };
  const backfillCompletedResponseOutput = (response: Record<string, unknown> | undefined) => {
    if (output.content.length > 0 || !Array.isArray(response?.output)) {
      return;
    }
    for (const rawItem of response.output) {
      if (!isRecord(rawItem)) {
        continue;
      }
      if (rawItem.type === "message") {
        appendCompletedResponseTextItem(rawItem);
      } else if (rawItem.type === "function_call") {
        appendCompletedResponseToolCallItem(rawItem);
      }
    }
  };
  const guardedStream = withResponsesFirstEventTimeout(
    openaiStream,
    model,
    options?.firstEventTimeoutMs,
  );
  const cooperativeScheduler = createModelStreamCooperativeScheduler(options?.signal);
  for await (const rawEvent of guardedStream) {
    throwIfModelStreamAborted(options?.signal);
    const event = rawEvent as Record<string, unknown>;
    const type = stringifyUnknown(event.type);
    eventCount += 1;
    eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
    if (eventCount === 1) {
      emitModelTransportDebug(
        log,
        `[responses] first_event provider=${model.provider} api=${model.api} model=${model.id} ` +
          `elapsedMs=${Date.now() - streamStartedAt} type=${type}`,
      );
    }
    if (sseDebugMode === "peek" && eventCount <= 5) {
      emitModelTransportDebug(
        log,
        `[responses] event_peek provider=${model.provider} api=${model.api} model=${model.id} ` +
          `index=${eventCount} type=${type} event=${stringifyRedactedEvent(event)}`,
      );
    }
    if (type === "response.created") {
      output.responseId = stringifyUnknown((event.response as { id?: string } | undefined)?.id);
    } else if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "reasoning") {
        currentItem = item;
        currentBlock = { type: "thinking", thinking: "" };
        output.content.push(currentBlock);
        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "message") {
        currentItem = item;
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock);
        stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "function_call") {
        currentItem = item;
        currentBlock = {
          type: "toolCall",
          id: `${stringifyUnknown(item.call_id)}|${stringifyUnknown(item.id)}`,
          name: stringifyUnknown(item.name),
          arguments: {},
          partialJson: stringifyJsonLike(item.arguments),
        };
        output.content.push(currentBlock);
        stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
      }
    } else if (type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking = `${stringifyUnknown(currentBlock.thinking)}${stringifyUnknown(event.delta)}`;
        stream.push({
          type: "thinking_delta",
          contentIndex: blockIndex(),
          delta: stringifyUnknown(event.delta),
          partial: output,
        });
      }
    } else if (isResponsesTextDeltaEventType(type) || type === "response.refusal.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = `${stringifyUnknown(currentBlock.text)}${stringifyUnknown(event.delta)}`;
        stream.push({
          type: "text_delta",
          contentIndex: blockIndex(),
          delta: stringifyUnknown(event.delta),
        });
      }
    } else if (type === "response.function_call_arguments.delta") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson = `${stringifyJsonLike(currentBlock.partialJson)}${stringifyJsonLike(event.delta)}`;
        currentBlock.arguments = parseStreamingJson(stringifyJsonLike(currentBlock.partialJson));
        stream.push({
          type: "toolcall_delta",
          contentIndex: blockIndex(),
          delta: stringifyJsonLike(event.delta),
          partial: output,
        });
      }
    } else if (type === "response.output_item.done") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        const summary = Array.isArray(item.summary)
          ? item.summary
              .map((part) => {
                const summaryPart = part as { text?: string };
                return summaryPart.text ?? "";
              })
              .join("\n\n")
          : "";
        currentBlock.thinking = summary;
        currentBlock.thinkingSignature = JSON.stringify(item);
        if ("encrypted_content" in item) {
          currentBlock[OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY] =
            buildOpenAIResponsesReasoningReplayMetadata(model, {
              authProfileId: options?.authProfileId,
              sessionId: options?.sessionId,
            });
        }
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: stringifyUnknown(currentBlock.thinking),
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "message" && currentBlock?.type === "text") {
        const content = Array.isArray(item.content) ? item.content : [];
        currentBlock.text = content
          .map((part) => {
            const contentPart = part as { type?: string; text?: string; refusal?: string };
            return isResponsesTextContentPartType(contentPart.type)
              ? (contentPart.text ?? "")
              : (contentPart.refusal ?? "");
          })
          .join("");
        currentBlock.textSignature = encodeTextSignatureV1(
          stringifyUnknown(item.id),
          (item.phase as "commentary" | "final_answer" | undefined) ?? undefined,
        );
        stream.push({
          type: "text_end",
          contentIndex: blockIndex(),
          content: stringifyUnknown(currentBlock.text),
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "function_call") {
        const args =
          currentBlock?.type === "toolCall" && currentBlock.partialJson
            ? parseStreamingJson(stringifyJsonLike(currentBlock.partialJson, "{}"))
            : parseStreamingJson(stringifyJsonLike(item.arguments, "{}"));
        stream.push({
          type: "toolcall_end",
          contentIndex: blockIndex(),
          toolCall: {
            type: "toolCall",
            id: `${stringifyUnknown(item.call_id)}|${stringifyUnknown(item.id)}`,
            name: stringifyUnknown(item.name),
            arguments: args,
          },
          partial: output,
        });
        currentBlock = null;
      }
    } else if (type === "response.completed") {
      const response = event.response as Record<string, unknown> | undefined;
      if (typeof response?.id === "string") {
        output.responseId = response.id;
      }
      backfillCompletedResponseOutput(response);
      const usage = response?.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            total_tokens?: number;
            input_tokens_details?: { cached_tokens?: number };
            output_tokens_details?: { reasoning_tokens?: number };
            service_tier?: ResponseCreateParamsStreaming["service_tier"];
            status?: string;
          }
        | undefined;
      if (usage) {
        const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
        const input = Math.max(0, inputTokens - cachedTokens);
        output.usage = {
          input,
          output: outputTokens,
          cacheRead: cachedTokens,
          cacheWrite: 0,
          ...(typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens)
            ? { reasoningTokens }
            : {}),
          totalTokens: input + outputTokens + cachedTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }
      calculateCost(model as never, output.usage as never);
      if (options?.applyServiceTierPricing) {
        options.applyServiceTierPricing(
          output.usage,
          (response?.service_tier as ResponseCreateParamsStreaming["service_tier"] | undefined) ??
            options.serviceTier,
        );
      }
      output.stopReason = mapResponsesStopReason(response?.status as string | undefined);
      if (
        output.content.some((block) => block.type === "toolCall") &&
        output.stopReason === "stop"
      ) {
        output.stopReason = "toolUse";
      }
    } else if (type === "error") {
      throw new Error(
        `Error Code ${stringifyUnknown(event.code, "unknown")}: ${stringifyUnknown(event.message, "Unknown error")}`,
      );
    } else if (type === "response.failed") {
      const failure = normalizeResponsesFailedEvent(event, model);
      if (failure.responseId) {
        output.responseId = failure.responseId;
      }
      if (failure.observation) {
        logResponsesFailedNoDetails(failure.observation);
      }
      throw new Error(failure.message);
    }
    await cooperativeScheduler.afterEvent();
  }
  const eventTypeSummary = [...eventTypes.entries()]
    .slice(0, 12)
    .map(([eventType, count]) => `${eventType}:${count}`)
    .join(",");
  emitModelTransportDebug(
    log,
    `[responses] stream_done provider=${model.provider} api=${model.api} model=${model.id} ` +
      `elapsedMs=${Date.now() - streamStartedAt} events=${eventCount} types=${eventTypeSummary} ` +
      `stopReason=${output.stopReason ?? "unset"} contentBlocks=${output.content.length}`,
  );
}

function mapResponsesStopReason(status: string | undefined): string {
  if (!status) {
    return "stop";
  }
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "in_progress":
    case "queued":
      return "stop";
    default:
      throw new Error(`Unhandled stop reason: ${status}`);
  }
}

function readResponsesOutputMessageText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      if (part.type === "output_text" || part.type === "text") {
        return stringifyUnknown(part.text);
      }
      if (part.type === "refusal") {
        return stringifyUnknown(part.refusal);
      }
      return "";
    })
    .join("");
}

function buildOpenAIClientHeaders(
  model: Model,
  context: Context,
  optionHeaders?: Record<string, string>,
  turnHeaders?: Record<string, string>,
): Record<string, string> {
  const providerHeaders = { ...model.headers };
  if (model.provider === "github-copilot") {
    Object.assign(
      providerHeaders,
      buildCopilotDynamicHeaders({
        messages: context.messages,
        hasImages: hasCopilotVisionInput(context.messages),
      }),
    );
  }
  const callerHeaders = { ...optionHeaders, ...turnHeaders };
  const headers = resolveProviderRequestPolicyConfig({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "llm",
    transport: "stream",
    providerHeaders,
    callerHeaders: Object.keys(callerHeaders).length > 0 ? callerHeaders : undefined,
    precedence: "caller-wins",
  }).headers;
  return headers ?? {};
}

function resolveProviderTransportTurnState(
  model: Model,
  params: {
    sessionId?: string;
    turnId: string;
    attempt: number;
    transport: "stream" | "websocket";
  },
) {
  const normalizedProvider = model.provider.trim().toLowerCase();
  const allowRuntimePluginLoad =
    normalizedProvider === "openai" ||
    normalizedProvider === "azure-openai" ||
    normalizedProvider === "azure-openai-responses";
  return resolveProviderTransportTurnStateWithPlugin({
    provider: model.provider,
    modelId: model.id,
    allowRuntimePluginLoad,
    context: {
      provider: model.provider,
      modelId: model.id,
      model: model as ProviderRuntimeModel,
      sessionId: params.sessionId,
      turnId: params.turnId,
      attempt: params.attempt,
      transport: params.transport,
    },
  });
}

function resolveOpenAISdkTimeoutMs(model: Model): number | undefined {
  return resolveModelRequestTimeoutMs(model, undefined);
}

function buildOpenAISdkClientOptions(model: Model): { timeout?: number } {
  const timeout = resolveOpenAISdkTimeoutMs(model);
  return timeout === undefined ? {} : { timeout };
}

function buildOpenAISdkRequestOptions(
  model: Model,
  signal?: AbortSignal,
  options?: { stream?: boolean },
): { signal?: AbortSignal; timeout?: number; headers?: Record<string, string> } | undefined {
  const timeout = resolveOpenAISdkTimeoutMs(model);
  const headers =
    options?.stream === true && usesNativeOpenAICodexResponsesBackend(model)
      ? { Accept: "text/event-stream" }
      : undefined;
  if (timeout === undefined && !signal && !headers) {
    return undefined;
  }
  return {
    ...(headers ? { headers } : {}),
    ...(signal ? { signal } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

function createOpenAIResponsesClient(
  model: Model,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
  turnHeaders?: Record<string, string>,
) {
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders),
    fetch: buildGuardedModelFetch(model),
    ...buildOpenAISdkClientOptions(model),
  });
}

export function createOpenAIResponsesTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const responsesOptions = options as OpenAIResponsesOptions | undefined;
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const turnState = resolveProviderTransportTurnState(model, {
          sessionId: options?.sessionId,
          turnId: randomUUID(),
          attempt: 1,
          transport: "stream",
        });
        const client = createOpenAIResponsesClient(
          model,
          context,
          apiKey,
          options?.headers,
          turnState?.headers,
        );
        let params = buildOpenAIResponsesParams(
          model,
          context,
          responsesOptions,
          turnState?.metadata,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        if (!isOpenAICodexResponsesModel(model)) {
          params = mergeTransportMetadata(params, turnState?.metadata);
        }
        params = sanitizeOpenAICodexResponsesParams(
          model,
          params as Record<string, unknown>,
        ) as typeof params;
        params = sanitizeResponsesImagePayload(params as Record<string, unknown>) as typeof params;
        if (
          (options as { openclawCodeModeToolSurface?: unknown } | undefined)
            ?.openclawCodeModeToolSurface === true
        ) {
          enforceCodeModeResponsesToolSurface(params);
          assertCodeModeResponsesToolSurface(params);
        }
        const requestStartedAt = Date.now();
        const requestOptions = buildOpenAISdkRequestOptions(model, options?.signal, {
          stream: true,
        });
        emitModelTransportDebug(
          log,
          `[responses] start provider=${model.provider} api=${model.api} model=${model.id} ` +
            `baseUrl=${formatModelTransportDebugBaseUrl(model.baseUrl)} timeoutMs=${safeDebugValue(requestOptions?.timeout)} ` +
            `apiKey=${apiKey ? "present" : "missing"} ${summarizeResponsesPayload(params)}`,
        );
        const responseStream = await createResponsesStreamWithEncryptedContentRetry({
          client,
          request: params,
          requestOptions,
          model,
        });
        emitModelTransportDebug(
          log,
          `[responses] headers provider=${model.provider} api=${model.api} model=${model.id} ` +
            `elapsedMs=${Date.now() - requestStartedAt}`,
        );
        stream.push({ type: "start", partial: output as never });
        await processResponsesStream(responseStream, output, stream, model, {
          serviceTier: responsesOptions?.serviceTier,
          applyServiceTierPricing,
          signal: options?.signal,
          authProfileId: responsesOptions?.authProfileId,
          sessionId: options?.sessionId,
        });
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error("An unknown error occurred");
        }
        stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
        stream.end();
      } catch (error) {
        log.warn(
          `[responses] error provider=${model.provider} api=${model.api} model=${model.id} ` +
            summarizeOpenAITransportError(error),
        );
        assignTransportErrorDetails(output, error, options?.signal);
        stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
        stream.end();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

function resolveCacheRetention(cacheRetention: string | undefined): "short" | "long" | "none" {
  if (cacheRetention === "short" || cacheRetention === "long" || cacheRetention === "none") {
    return cacheRetention;
  }
  if (typeof process !== "undefined" && process.env.OPENCLAW_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}

function resolvePromptCacheKey(
  options: Pick<BaseStreamOptions, "promptCacheKey" | "sessionId"> | undefined,
  cacheRetention: "short" | "long" | "none",
): string | undefined {
  if (cacheRetention === "none") {
    return undefined;
  }
  return clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId);
}

function getPromptCacheRetention(
  baseUrl: string | undefined,
  cacheRetention: "short" | "long" | "none",
) {
  if (cacheRetention !== "long") {
    return undefined;
  }
  return baseUrl?.includes("api.openai.com") ? "24h" : undefined;
}

function resolveOpenAIReasoningEffort(
  options: OpenAIResponsesOptions | undefined,
): OpenAIApiReasoningEffort {
  return normalizeOpenAIReasoningEffort(
    options?.reasoningEffort ?? options?.reasoning ?? "high",
  ) as OpenAIApiReasoningEffort;
}

function hasResponsesWebSearchTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }
  return tools.some((tool) => {
    if (!isRecord(tool)) {
      return false;
    }
    if (tool.type === "web_search") {
      return true;
    }
    if (tool.type === "function" && tool.name === "web_search") {
      return true;
    }
    const fn = tool.function;
    return isRecord(fn) && fn.name === "web_search";
  });
}

function raiseMinimalReasoningForResponsesWebSearch(params: {
  model: Model;
  effort: OpenAIApiReasoningEffort;
  tools: unknown;
}): OpenAIApiReasoningEffort {
  if (params.effort !== "minimal" || !hasResponsesWebSearchTool(params.tools)) {
    return params.effort;
  }
  for (const effort of ["low", "medium", "high"] as const) {
    const resolved = resolveOpenAIReasoningEffortForModel({
      model: params.model,
      effort,
    });
    if (resolved && resolved !== "none" && resolved !== "minimal") {
      return resolved;
    }
  }
  return params.effort;
}

export function buildOpenAIResponsesParams(
  model: Model,
  context: Context,
  options: OpenAIResponsesOptions | undefined,
  metadata?: Record<string, string>,
) {
  const isCodexResponses = isOpenAICodexResponsesModel(model);
  const isNativeCodexResponses = usesNativeOpenAICodexResponsesBackend(model);
  const compat = getCompat(model as OpenAIModeModel);
  const supportsDeveloperRole =
    typeof compat.supportsDeveloperRole === "boolean" ? compat.supportsDeveloperRole : undefined;
  const payloadPolicy = resolveOpenAIResponsesPayloadPolicy(model, {
    storeMode: "disable",
  });
  const policyAllowsReplayIds =
    payloadPolicy.explicitStore !== false && !payloadPolicy.shouldStripStore;
  const replayResponsesItemIds =
    !isNativeCodexResponses && (options?.replayResponsesItemIds ?? policyAllowsReplayIds);
  const messages = convertResponsesMessages(
    model,
    context,
    new Set(["openai", "opencode", "azure-openai-responses", "github-copilot"]),
    {
      includeSystemPrompt: !isCodexResponses,
      supportsDeveloperRole,
      replayReasoningItems: true,
      replayResponsesItemIds,
      authProfileId: options?.authProfileId,
      sessionId: options?.sessionId,
    },
  );
  if (isCodexResponses) {
    ensureOpenAICodexResponsesInput(messages, context);
  }
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const promptCacheKey = resolvePromptCacheKey(options, cacheRetention);
  const params: OpenAIResponsesRequestParams = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key: promptCacheKey,
    prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
    ...(isCodexResponses
      ? { instructions: resolveOpenAICodexResponsesInstructions(model, context) }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
  const effectiveMaxTokens = options?.maxTokens || model.maxTokens;
  if (effectiveMaxTokens) {
    params.max_output_tokens = effectiveMaxTokens;
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (options?.topP !== undefined) {
    params.top_p = options.topP;
  }
  if (options?.responseFormat !== undefined) {
    params.text = {
      ...params.text,
      format: resolveOpenAIResponsesTextFormat(options.responseFormat),
    };
  }
  if (options?.serviceTier !== undefined && payloadPolicy.allowsServiceTier) {
    params.service_tier = options.serviceTier;
  }
  if (context.tools) {
    const converted = convertResponsesTools(context.tools, model as OpenAIModeModel, {
      strict: resolveOpenAIStrictToolSetting(model as OpenAIModeModel, {
        transport: "stream",
      }),
    });
    if (
      converted.tools.length > 0 ||
      (converted.projection.inputToolCount === 0 && converted.projection.diagnostics.length === 0)
    ) {
      params.tools = converted.tools;
    }
    if (options?.toolChoice) {
      const toolChoice = reconcileOpenAIResponsesToolChoice(
        options.toolChoice,
        converted.projection,
      );
      if (toolChoice !== undefined) {
        params.tool_choice = toolChoice;
      }
    }
  }
  if (model.reasoning) {
    if (options?.reasoningEffort || options?.reasoning || options?.reasoningSummary) {
      const requestedReasoningEffort = resolveOpenAIReasoningEffort(options);
      const resolvedReasoningEffort = resolveOpenAIReasoningEffortForModel({
        model,
        effort: requestedReasoningEffort,
      });
      const reasoningEffort = resolvedReasoningEffort
        ? raiseMinimalReasoningForResponsesWebSearch({
            model,
            effort: resolvedReasoningEffort,
            tools: params.tools,
          })
        : undefined;
      if (reasoningEffort) {
        params.reasoning = {
          effort: reasoningEffort,
          ...(reasoningEffort === "none" ? {} : { summary: options?.reasoningSummary || "auto" }),
        };
        if (reasoningEffort !== "none") {
          params.include = ["reasoning.encrypted_content"];
        }
      }
    } else if (model.provider !== "github-copilot") {
      const reasoningEffort = resolveOpenAIReasoningEffortForModel({
        model,
        effort: "none",
      });
      if (reasoningEffort) {
        params.reasoning = {
          effort: reasoningEffort,
        };
      }
    }
  }
  applyOpenAIResponsesPayloadPolicy(params as Record<string, unknown>, payloadPolicy);
  return sanitizeOpenAICodexResponsesParams(
    model,
    params as Record<string, unknown>,
  ) as typeof params;
}

export function createAzureOpenAIResponsesTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const responsesOptions = options as OpenAIResponsesOptions | undefined;
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant" as const,
        content: [],
        api: "azure-openai-responses",
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const turnState = resolveProviderTransportTurnState(model, {
          sessionId: options?.sessionId,
          turnId: randomUUID(),
          attempt: 1,
          transport: "stream",
        });
        const client = createAzureOpenAIClient(
          model,
          context,
          apiKey,
          options?.headers,
          turnState?.headers,
        );
        const deploymentName = resolveAzureDeploymentName(model);
        let params = buildAzureOpenAIResponsesParams(
          model,
          context,
          responsesOptions,
          deploymentName,
          turnState?.metadata,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        if (!isOpenAICodexResponsesModel(model)) {
          params = mergeTransportMetadata(params, turnState?.metadata);
        }
        params = sanitizeOpenAICodexResponsesParams(
          model,
          params as Record<string, unknown>,
        ) as typeof params;
        params = sanitizeResponsesImagePayload(params as Record<string, unknown>) as typeof params;
        if (
          (options as { openclawCodeModeToolSurface?: unknown } | undefined)
            ?.openclawCodeModeToolSurface === true
        ) {
          enforceCodeModeResponsesToolSurface(params);
          assertCodeModeResponsesToolSurface(params);
        }
        const requestStartedAt = Date.now();
        const requestOptions = buildOpenAISdkRequestOptions(model, options?.signal);
        emitModelTransportDebug(
          log,
          `[responses] start provider=${model.provider} api=${model.api} model=${model.id} ` +
            `baseUrl=${formatModelTransportDebugBaseUrl(model.baseUrl)} timeoutMs=${safeDebugValue(requestOptions?.timeout)} ` +
            `apiKey=${apiKey ? "present" : "missing"} ${summarizeResponsesPayload(params)}`,
        );
        const responseStream = (await client.responses.create(
          params as never,
          requestOptions,
        )) as unknown as AsyncIterable<unknown>;
        emitModelTransportDebug(
          log,
          `[responses] headers provider=${model.provider} api=${model.api} model=${model.id} ` +
            `elapsedMs=${Date.now() - requestStartedAt}`,
        );
        stream.push({ type: "start", partial: output as never });
        await processResponsesStream(responseStream, output, stream, model, {
          firstEventTimeoutMs: AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS,
          signal: options?.signal,
          authProfileId: responsesOptions?.authProfileId,
          sessionId: options?.sessionId,
        });
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error("An unknown error occurred");
        }
        stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
        stream.end();
      } catch (error) {
        log.warn(
          `[responses] error provider=${model.provider} api=${model.api} model=${model.id} ` +
            summarizeOpenAITransportError(error),
        );
        assignTransportErrorDetails(output, error, options?.signal);
        stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
        stream.end();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

function normalizeAzureBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function resolveAzureDeploymentName(model: Model): string {
  return resolveAzureDeploymentNameFromMap({
    modelId: model.id,
    deploymentMap: process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP,
  });
}

function createAzureOpenAIClient(
  model: Model,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
  turnHeaders?: Record<string, string>,
) {
  const baseURL = normalizeAzureBaseUrl(model.baseUrl);
  const clientOptions = {
    apiKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders),
    baseURL,
    fetch: buildGuardedModelFetch(model),
    ...buildOpenAISdkClientOptions(model),
  };

  if (isOpenAICompatibleAzureResponsesBaseUrl(baseURL)) {
    return new OpenAI(clientOptions);
  }

  return new AzureOpenAI({
    ...clientOptions,
    apiVersion: resolveAzureOpenAIApiVersion(),
  });
}

function buildAzureOpenAIResponsesParams(
  model: Model,
  context: Context,
  options: OpenAIResponsesOptions | undefined,
  deploymentName: string,
  metadata?: Record<string, string>,
) {
  const params = buildOpenAIResponsesParams(model, context, options, metadata);
  params.model = deploymentName;
  delete params.store;
  return params;
}

function hasToolHistory(messages: Context["messages"]): boolean {
  return messages.some(
    (message) =>
      message.role === "toolResult" ||
      // Assistant content can be a raw string from transcript replay; a string
      // never carries tool calls, so it should not count toward tool history.
      (message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === "toolCall")),
  );
}

function assertOpenAICompletionsPayloadHasConversationTurn(
  params: Record<string, unknown>,
  model: Model,
): void {
  const messages = params.messages;
  if (!Array.isArray(messages) || hasOpenAICompatibleConversationTurn(messages)) {
    return;
  }
  throw new Error(
    `OpenAI-compatible chat payload for ${model.provider}/${model.id} contains no non-empty user or assistant messages after compaction and transport transforms; refusing to send a system/tool-only request. Start a new user turn or repair the compacted session history.`,
  );
}

function createOpenAICompletionsClient(
  model: Model,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
) {
  const clientConfig = buildOpenAICompletionsClientConfig(model, context, optionHeaders);
  return new OpenAI({
    apiKey,
    baseURL: clientConfig.baseURL,
    dangerouslyAllowBrowser: true,
    defaultHeaders: clientConfig.defaultHeaders,
    defaultQuery: clientConfig.defaultQuery,
    fetch: buildGuardedModelFetch(model),
    ...buildOpenAISdkClientOptions(model),
  });
}

function isAzureOpenAICompatibleHost(hostname: string): boolean {
  return (
    hostname.endsWith(".openai.azure.com") ||
    hostname.endsWith(".services.ai.azure.com") ||
    hostname.endsWith(".cognitiveservices.azure.com")
  );
}

function isKnownOpenAICompletionsEndpoint(model: Pick<Model, "baseUrl">): boolean {
  if (!model.baseUrl.trim()) {
    return true;
  }
  const endpointClass = resolveProviderEndpoint(model.baseUrl).endpointClass;
  if (endpointClass === "openai-public" || endpointClass === "azure-openai") {
    return true;
  }
  try {
    return isAzureOpenAICompatibleHost(new URL(model.baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function buildOpenAICompletionsClientConfig(
  model: Model,
  context: Context,
  optionHeaders?: Record<string, string>,
): {
  baseURL: string;
  defaultHeaders: Record<string, string>;
  defaultQuery?: Record<string, string>;
} {
  const headers = buildOpenAIClientHeaders(model, context, optionHeaders);
  const defaultQuery: Record<string, string> = {};
  let baseURL = model.baseUrl;
  let isAzureHost = false;

  try {
    const parsed = new URL(model.baseUrl);
    isAzureHost = isAzureOpenAICompatibleHost(parsed.hostname.toLowerCase());
    parsed.searchParams.forEach((value, key) => {
      if (value) {
        defaultQuery[key] = value;
      }
    });
    parsed.search = "";
    baseURL = parsed.toString().replace(/\/$/, "");
  } catch {
    // Keep the configured base URL unchanged; the OpenAI SDK will surface invalid URLs.
  }

  if (isAzureHost) {
    const apiVersionHeader = Object.keys(headers).find(
      (key) => key.toLowerCase() === "api-version",
    );
    if (apiVersionHeader) {
      const apiVersion = headers[apiVersionHeader]?.trim();
      delete headers[apiVersionHeader];
      if (apiVersion && !defaultQuery["api-version"]) {
        defaultQuery["api-version"] = apiVersion;
      }
    }
  }

  return {
    baseURL,
    defaultHeaders: headers,
    defaultQuery: Object.keys(defaultQuery).length > 0 ? defaultQuery : undefined,
  };
}

export function createOpenAICompletionsTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const client = createOpenAICompletionsClient(model, context, apiKey, options?.headers);
        let params = buildOpenAICompletionsParams(
          model as OpenAIModeModel,
          context,
          options as OpenAICompletionsOptions | undefined,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        if (
          (options as { openclawCodeModeToolSurface?: unknown } | undefined)
            ?.openclawCodeModeToolSurface === true
        ) {
          enforceCodeModeResponsesToolSurface(params);
          assertCodeModeResponsesToolSurface(params);
        }
        const compat = getCompat(model as OpenAIModeModel);
        if (compat.requiresNonEmptyUserOrAssistantMessage) {
          assertOpenAICompletionsPayloadHasConversationTurn(params, model);
        }
        const emitReasoning = shouldEmitOpenAICompletionsReasoning(
          model as OpenAIModeModel,
          options as OpenAICompletionsOptions | undefined,
        );
        const responseStream = (await client.chat.completions.create(
          params as never,
          buildOpenAISdkRequestOptions(model, options?.signal),
        )) as unknown as AsyncIterable<ChatCompletionChunk>;
        stream.push({ type: "start", partial: output as never });
        await processOpenAICompletionsStream(responseStream, output, model, stream, {
          signal: options?.signal,
          emitReasoning,
        });
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
        stream.end();
      } catch (error) {
        assignTransportErrorDetails(output, error, options?.signal);
        stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
        stream.end();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

async function processOpenAICompletionsStream(
  responseStream: AsyncIterable<ChatCompletionChunk>,
  output: MutableAssistantOutput,
  model: Model,
  stream: { push(event: unknown): void },
  options?: { signal?: AbortSignal; emitReasoning?: boolean },
) {
  const MAX_POST_TOOL_CALL_BUFFER_BYTES = 256_000;
  const MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES = 256_000;
  const emitReasoning = options?.emitReasoning ?? true;
  const compat = getCompat(model as OpenAIModeModel);
  const deepSeekTextFilter = shouldFilterDeepSeekDsmlText(compat)
    ? createDeepSeekTextFilter()
    : null;
  const deepSeekToolCallRecoverer = shouldFilterDeepSeekDsmlText(compat)
    ? createDeepSeekDsmlToolCallRecoverer()
    : null;
  const reasoningTagTextPartitioner = createReasoningTagTextPartitioner();
  type ToolCallBlock = {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    partialArgs: string;
    thoughtSignature?: string;
  };
  let currentBlock:
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; thinkingSignature?: string }
    | ToolCallBlock
    | null = null;
  let pendingPostToolCallDeltas: CompletionsReasoningDelta[] = [];
  let pendingPostToolCallBytes = 0;
  let isFlushingPendingPostToolCallDeltas = false;
  let recoveredDeepSeekToolCallIndex = 0;
  const toolCallBlocksByIndex = new Map<number, ToolCallBlock>();
  const toolCallBlocksById = new Map<string, ToolCallBlock>();
  const toolCallBlockBytes = new WeakMap<ToolCallBlock, number>();
  let sawStopFinishReason = false;
  const blockIndex = () => output.content.length - 1;
  const measureUtf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");
  let chunkPushedEvent = false;
  const pushStreamEvent = (event: unknown) => {
    chunkPushedEvent = true;
    stream.push(event);
  };
  const finishCurrentBlock = () => {
    if (!currentBlock) {
      return;
    }
    if (currentBlock.type === "toolCall") {
      currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
    }
  };
  const finishAllToolCallBlocks = () => {
    for (const block of toolCallBlocksByIndex.values()) {
      block.arguments = parseStreamingJson(block.partialArgs);
    }
  };
  const queuePostToolCallDelta = (next: CompletionsReasoningDelta) => {
    const nextBytes = measureUtf8Bytes(next.text);
    if (pendingPostToolCallBytes + nextBytes > MAX_POST_TOOL_CALL_BUFFER_BYTES) {
      throw new Error("Exceeded post-tool-call delta buffer limit");
    }
    pendingPostToolCallBytes += nextBytes;
    const previous = pendingPostToolCallDeltas[pendingPostToolCallDeltas.length - 1];
    if (!previous || previous.kind !== next.kind) {
      pendingPostToolCallDeltas.push(next);
      return;
    }
    if (next.kind === "thinking" && previous.kind === "thinking") {
      if (previous.signature !== next.signature) {
        pendingPostToolCallDeltas.push(next);
        return;
      }
      previous.text += next.text;
      return;
    }
    previous.text += next.text;
  };
  const appendThinkingDeltaInternal = (reasoningDelta: { signature: string; text: string }) => {
    if (!currentBlock || currentBlock.type !== "thinking") {
      finishCurrentBlock();
      currentBlock = {
        type: "thinking",
        thinking: "",
        ...(reasoningDelta.signature ? { thinkingSignature: reasoningDelta.signature } : {}),
      };
      output.content.push(currentBlock);
      pushStreamEvent({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
    }
    currentBlock.thinking += reasoningDelta.text;
    pushStreamEvent({
      type: "thinking_delta",
      contentIndex: blockIndex(),
      delta: reasoningDelta.text,
      partial: output,
    });
  };
  const appendTextDeltaInternal = (text: string) => {
    if (!currentBlock || currentBlock.type !== "text") {
      finishCurrentBlock();
      currentBlock = { type: "text", text: "" };
      output.content.push(currentBlock);
      pushStreamEvent({ type: "text_start", contentIndex: blockIndex(), partial: output });
    }
    currentBlock.text += text;
    pushStreamEvent({
      type: "text_delta",
      contentIndex: blockIndex(),
      delta: text,
    });
  };
  const flushPendingPostToolCallDeltas = () => {
    if (
      isFlushingPendingPostToolCallDeltas ||
      currentBlock?.type === "toolCall" ||
      pendingPostToolCallDeltas.length === 0
    ) {
      return;
    }
    isFlushingPendingPostToolCallDeltas = true;
    const bufferedDeltas = pendingPostToolCallDeltas;
    pendingPostToolCallDeltas = [];
    pendingPostToolCallBytes = 0;
    for (const delta of bufferedDeltas) {
      if (delta.kind === "text") {
        appendTextDeltaInternal(delta.text);
      } else if (emitReasoning) {
        appendThinkingDeltaInternal(delta);
      }
    }
    isFlushingPendingPostToolCallDeltas = false;
  };
  const appendThinkingDelta = (reasoningDelta: { signature: string; text: string }) => {
    flushPendingPostToolCallDeltas();
    appendThinkingDeltaInternal(reasoningDelta);
  };
  const appendTextDelta = (text: string) => {
    flushPendingPostToolCallDeltas();
    appendTextDeltaInternal(text);
  };
  const appendVisibleTextDelta = (text: string) => {
    if (!text) {
      return;
    }
    if (currentBlock?.type === "toolCall") {
      queuePostToolCallDelta({ kind: "text", text });
    } else {
      appendTextDelta(text);
    }
  };
  const appendRecoveredToolCall = (toolCall: RecoveredDeepSeekDsmlToolCall) => {
    const switchingToolCall = currentBlock?.type === "toolCall";
    finishCurrentBlock();
    if (switchingToolCall) {
      currentBlock = null;
      flushPendingPostToolCallDeltas();
    }
    output.stopReason = "toolUse";
    recoveredDeepSeekToolCallIndex += 1;
    const block: ToolCallBlock = {
      type: "toolCall",
      id: `call_deepseek_dsml_${recoveredDeepSeekToolCallIndex}`,
      name: toolCall.name,
      arguments: toolCall.arguments,
      partialArgs: toolCall.partialArgs,
    };
    currentBlock = block;
    output.content.push(block);
    pushStreamEvent({
      type: "toolcall_start",
      contentIndex: output.content.indexOf(block),
      partial: output,
    });
    pushStreamEvent({
      type: "toolcall_delta",
      contentIndex: output.content.indexOf(block),
      delta: toolCall.partialArgs,
      partial: output,
    });
  };
  const appendFilteredVisibleTextDelta = (text: string) => {
    const recoveredParts = deepSeekToolCallRecoverer?.push(text) ?? [
      { kind: "text" as const, text },
    ];
    for (const recoveredPart of recoveredParts) {
      if (recoveredPart.kind === "toolCall") {
        appendRecoveredToolCall(recoveredPart);
        continue;
      }
      const parts = deepSeekTextFilter?.push(recoveredPart.text) ?? [recoveredPart.text];
      for (const part of parts) {
        appendVisibleTextDelta(part);
      }
    }
  };
  const flushDeepSeekToolCallRecovererAtEnd = () => {
    const recoveredParts = deepSeekToolCallRecoverer?.flush();
    if (!recoveredParts) {
      return;
    }
    for (const recoveredPart of recoveredParts) {
      if (recoveredPart.kind === "toolCall") {
        appendRecoveredToolCall(recoveredPart);
        continue;
      }
      const parts = deepSeekTextFilter?.push(recoveredPart.text) ?? [recoveredPart.text];
      for (const part of parts) {
        appendVisibleTextDelta(part);
      }
    }
  };
  const flushDeepSeekTextFilterAtEnd = () => {
    const parts = deepSeekTextFilter?.flush();
    if (!parts) {
      return;
    }
    for (const part of parts) {
      appendVisibleTextDelta(part);
    }
  };
  const appendRoutedContentDelta = (delta: CompletionsReasoningDelta) => {
    if (delta.kind === "text") {
      appendFilteredVisibleTextDelta(delta.text);
      return;
    }
    if (!emitReasoning) {
      return;
    }
    if (currentBlock?.type === "toolCall") {
      queuePostToolCallDelta(delta);
    } else {
      appendThinkingDelta(delta);
    }
  };
  const appendPartitionedVisibleDelta = (delta: { kind: "text" | "thinking"; text: string }) => {
    if (delta.kind === "text") {
      appendFilteredVisibleTextDelta(delta.text);
    }
  };
  const emitReasoningUsageActivity = (hasReasoningUsageActivity: boolean) => {
    if (!hasReasoningUsageActivity || chunkPushedEvent || !emitReasoning) {
      return;
    }
    const latestBlock = output.content[output.content.length - 1];
    if (currentBlock?.type === "text" || currentBlock?.type === "toolCall") {
      return;
    }
    if (latestBlock?.type === "text" || latestBlock?.type === "toolCall") {
      return;
    }
    appendThinkingDelta({ signature: "", text: "" });
  };
  const flushReasoningTagTextPartitionerAtEnd = () => {
    for (const delta of reasoningTagTextPartitioner.flush()) {
      appendPartitionedVisibleDelta(delta);
    }
  };
  const cooperativeScheduler = createModelStreamCooperativeScheduler(options?.signal);
  for await (const rawChunk of responseStream as AsyncIterable<unknown>) {
    throwIfModelStreamAborted(options?.signal);
    chunkPushedEvent = false;
    if (!rawChunk || typeof rawChunk !== "object") {
      await cooperativeScheduler.afterEvent();
      continue;
    }
    const chunk = rawChunk as ChatCompletionChunk;
    output.responseId ||= chunk.id;
    let hasReasoningUsageActivity = false;
    if (chunk.usage) {
      output.usage = parseTransportChunkUsage(chunk.usage, model);
      hasReasoningUsageActivity = hasOpenAICompletionsReasoningUsageActivity(chunk.usage);
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) {
      emitReasoningUsageActivity(hasReasoningUsageActivity);
      await cooperativeScheduler.afterEvent();
      continue;
    }
    const choiceUsage = (choice as unknown as { usage?: ChatCompletionChunk["usage"] }).usage;
    if (!chunk.usage && choiceUsage) {
      output.usage = parseTransportChunkUsage(choiceUsage, model);
      hasReasoningUsageActivity = hasOpenAICompletionsReasoningUsageActivity(choiceUsage);
    }
    if (choice.finish_reason) {
      const finishReasonResult = mapStopReason(choice.finish_reason);
      output.stopReason = finishReasonResult.stopReason;
      if (finishReasonResult.stopReason === "stop") {
        sawStopFinishReason = true;
      }
      if (finishReasonResult.errorMessage) {
        output.errorMessage = finishReasonResult.errorMessage;
      }
    }
    const choiceDelta =
      choice.delta ??
      (choice as unknown as { message?: ChatCompletionChunk["choices"][number]["delta"] }).message;
    if (!choiceDelta) {
      emitReasoningUsageActivity(hasReasoningUsageActivity);
      await cooperativeScheduler.afterEvent();
      continue;
    }
    const reasoningDeltas = getCompletionsReasoningDeltas(
      choiceDelta as Record<string, unknown>,
      compat.visibleReasoningDetailTypes,
    );
    const hasMirroredReasoning = reasoningDeltas.some((delta) => delta.kind === "thinking");
    if (hasMirroredReasoning) {
      reasoningTagTextPartitioner.markStrict();
    }
    if (choiceDelta.content) {
      // Structured content can contain visible text and thinking blocks in the
      // same delta, so route each extracted block through the normal stream path.
      const contentDeltas = getCompletionsContentDeltas(choiceDelta.content);
      for (const contentDelta of contentDeltas) {
        if (contentDelta.kind === "text") {
          const routedDeltas = hasMirroredReasoning
            ? reasoningTagTextPartitioner.push(contentDelta.text)
            : reasoningTagTextPartitioner.pushVisible(contentDelta.text);
          for (const routedDelta of routedDeltas) {
            appendPartitionedVisibleDelta(routedDelta);
          }
        } else {
          reasoningTagTextPartitioner.markStrict();
          appendRoutedContentDelta(contentDelta);
        }
      }
    }
    for (const reasoningDelta of reasoningDeltas) {
      if (reasoningDelta.kind === "thinking" && !emitReasoning) {
        continue;
      }
      if (currentBlock?.type === "toolCall") {
        queuePostToolCallDelta({ ...reasoningDelta });
        continue;
      }
      if (reasoningDelta.kind === "text") {
        appendTextDelta(reasoningDelta.text);
      } else if (emitReasoning) {
        appendThinkingDelta(reasoningDelta);
      }
    }
    if (choiceDelta.tool_calls && choiceDelta.tool_calls.length > 0) {
      flushReasoningTagTextPartitionerAtEnd();
      for (const toolCall of choiceDelta.tool_calls) {
        const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
        let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
        if (!block && toolCall.id) {
          block = toolCallBlocksById.get(toolCall.id);
        }
        if (!block) {
          const switchingToolCall = currentBlock?.type === "toolCall";
          finishCurrentBlock();
          if (switchingToolCall) {
            currentBlock = null;
            flushPendingPostToolCallDeltas();
          }
          const initialSig = extractGoogleThoughtSignature(toolCall);
          block = {
            type: "toolCall",
            id: toolCall.id || "",
            name: toolCall.function?.name || "",
            arguments: {},
            partialArgs: "",
            ...(initialSig ? { thoughtSignature: initialSig } : {}),
          };
          output.content.push(block);
          pushStreamEvent({
            type: "toolcall_start",
            contentIndex: output.content.indexOf(block),
            partial: output,
          });
        }
        if (streamIndex !== undefined && !toolCallBlocksByIndex.has(streamIndex)) {
          toolCallBlocksByIndex.set(streamIndex, block);
        }
        if (toolCall.id) {
          block.id = toolCall.id;
          toolCallBlocksById.set(toolCall.id, block);
        }
        currentBlock = block;
        if (toolCall.function?.name) {
          block.name = toolCall.function.name;
        }
        const deltaSig = extractGoogleThoughtSignature(toolCall);
        if (deltaSig) {
          block.thoughtSignature = deltaSig;
        }
        if (toolCall.function?.arguments) {
          const nextArgumentBytes = measureUtf8Bytes(toolCall.function.arguments);
          const currentBlockArgBytes = toolCallBlockBytes.get(block) ?? 0;
          if (currentBlockArgBytes + nextArgumentBytes > MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES) {
            throw new Error("Exceeded tool-call argument buffer limit");
          }
          toolCallBlockBytes.set(block, currentBlockArgBytes + nextArgumentBytes);
          block.partialArgs += toolCall.function.arguments;
          block.arguments = parseStreamingJson(block.partialArgs);
          pushStreamEvent({
            type: "toolcall_delta",
            contentIndex: output.content.indexOf(block),
            delta: toolCall.function.arguments,
            partial: output,
          });
        }
      }
    }
    flushPendingPostToolCallDeltas();
    emitReasoningUsageActivity(hasReasoningUsageActivity);
    await cooperativeScheduler.afterEvent();
  }
  flushReasoningTagTextPartitionerAtEnd();
  flushDeepSeekToolCallRecovererAtEnd();
  flushDeepSeekTextFilterAtEnd();
  finishAllToolCallBlocks();
  currentBlock = null;
  flushPendingPostToolCallDeltas();
  const hasToolCalls = output.content.some((block) => block.type === "toolCall");
  const hasVisibleText = output.content.some(
    (block) =>
      block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
  );
  if (output.stopReason === "toolUse" && !hasToolCalls) {
    output.stopReason = "stop";
  }
  if (sawStopFinishReason && output.stopReason === "stop" && hasToolCalls && !hasVisibleText) {
    output.stopReason = "toolUse";
  }
  if (hasToolCalls && output.stopReason !== "toolUse") {
    output.content = output.content.filter((block) => block.type !== "toolCall");
  }
}

type CompletionsReasoningDelta =
  | {
      kind: "thinking";
      signature: string;
      text: string;
    }
  | {
      kind: "text";
      text: string;
    };

function getCompletionsContentDeltas(content: unknown): CompletionsReasoningDelta[] {
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content.flatMap((item) => getCompletionsContentDeltas(item));
  }
  if (!content || typeof content !== "object") {
    return [];
  }
  const record = content as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  // Some OpenAI-compatible providers, notably Mistral thinking models, stream
  // `delta.content` as typed objects. Never coerce those objects directly or
  // they become persisted visible text like "[object Object]".
  const extractText = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => extractText(item)).join("");
    }
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      return extractText(nested.text ?? nested.content ?? nested.thinking);
    }
    return "";
  };
  const text = extractText(record.text ?? record.content ?? record.thinking);
  if (!text) {
    return [];
  }
  // Preserve provider reasoning as OpenClaw thinking blocks so channel/UI
  // surfaces can decide whether to show it instead of leaking it as answer text.
  if (type.includes("thinking") || type.includes("reasoning")) {
    return [{ kind: "thinking", signature: "content", text }];
  }
  if (type === "text" || type === "output_text" || type.endsWith(".output_text")) {
    return [{ kind: "text", text }];
  }
  return [];
}

function getCompletionsReasoningDeltas(
  delta: Record<string, unknown>,
  visibleReasoningDetailTypes: readonly string[],
): CompletionsReasoningDelta[] {
  const output: CompletionsReasoningDelta[] = [];
  const pushDelta = (next: CompletionsReasoningDelta) => {
    const previous = output[output.length - 1];
    if (!previous || previous.kind !== next.kind) {
      output.push(next);
      return;
    }
    if (next.kind === "thinking" && previous.kind === "thinking") {
      if (previous.signature !== next.signature) {
        output.push(next);
        return;
      }
      previous.text += next.text;
      return;
    }
    previous.text += next.text;
  };
  const reasoningDetails = delta.reasoning_details;
  let usedReasoningThinkingDetails = false;
  if (Array.isArray(reasoningDetails)) {
    const visibleTypes = new Set(visibleReasoningDetailTypes);
    for (const item of reasoningDetails) {
      const detail = item as { type?: unknown; text?: unknown };
      if (typeof detail.text !== "string" || !detail.text) {
        continue;
      }
      if (detail.type === "reasoning.text") {
        usedReasoningThinkingDetails = true;
        pushDelta({ kind: "thinking", signature: "reasoning_details", text: detail.text });
        continue;
      }
      if (typeof detail.type === "string" && visibleTypes.has(detail.type)) {
        pushDelta({ kind: "text", text: detail.text });
      }
    }
  }
  if (!usedReasoningThinkingDetails) {
    const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;
    for (const field of reasoningFields) {
      const value = delta[field];
      if (typeof value === "string" && value.length > 0) {
        pushDelta({ kind: "thinking", signature: field, text: value });
        break;
      }
    }
  }
  return output;
}

type OpenAIResponsesRequestParams = {
  model: string;
  input: ResponseInput;
  stream: true;
  instructions?: string;
  prompt_cache_key?: string;
  prompt_cache_retention?: "24h";
  metadata?: Record<string, string>;
  store?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  text?: ResponseCreateParamsStreaming["text"];
  service_tier?: ResponseCreateParamsStreaming["service_tier"];
  tools?: FunctionTool[];
  tool_choice?: ResponseCreateParamsStreaming["tool_choice"];
  reasoning?:
    | { effort: OpenAIApiReasoningEffort }
    | {
        effort: OpenAIApiReasoningEffort;
        summary: NonNullable<OpenAIResponsesOptions["reasoningSummary"]>;
      };
  include?: string[];
};

export function buildOpenAICompletionsParams(
  model: OpenAIModeModel,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
) {
  const compat = getCompat(model);
  const compatDetection = detectOpenAICompletionsCompat(model);
  const completionsContext = context.systemPrompt
    ? {
        ...context,
        systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt),
      }
    : context;
  let messages = convertMessages(model as never, completionsContext, compat as never);
  injectToolCallThoughtSignatures(messages as unknown[], context, model);
  sanitizeCompletionsReasoningReplayFields(messages, {
    preserveOpenRouterReasoning:
      compat.thinkingFormat === "openrouter" && shouldPreserveOpenRouterReasoningReplay(model),
    preserveReasoningContent: shouldPreserveReasoningContentReplay(model, compat),
  });
  if (compat.strictMessageKeys) {
    messages = stripCompletionMessagesToRoleContent(messages) as typeof messages;
  }
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const promptCacheKey = resolvePromptCacheKey(options, cacheRetention);
  const params: Record<string, unknown> = {
    model: model.id,
    messages: compat.requiresStringContent
      ? flattenCompletionMessagesToStringContent(messages)
      : messages,
    stream: true,
  };
  if (compat.supportsUsageInStreaming) {
    params.stream_options = { include_usage: true };
  }
  if (compat.supportsStore) {
    params.store = false;
  }
  if (compat.supportsPromptCacheKey && promptCacheKey) {
    params.prompt_cache_key = promptCacheKey;
    // When the caller explicitly opted into long retention, forward the
    // canonical prompt_cache_retention value alongside the cache key so
    // OpenAI-compatible completions backends (oMLX, llama.cpp, official
    // OpenAI, etc.) can honor the 24h prefix-cache lifetime. Without this
    // the key reaches the wire but the retention preference is silently
    // dropped (issue #81281).
    if (cacheRetention === "long" && compat.supportsLongCacheRetention) {
      params.prompt_cache_retention = "24h";
    }
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (options?.topP !== undefined) {
    params.top_p = options.topP;
  }
  if (options?.responseFormat !== undefined) {
    params.response_format = options.responseFormat;
  }
  if (options?.frequencyPenalty !== undefined) {
    params.frequency_penalty = options.frequencyPenalty;
  }
  if (options?.presencePenalty !== undefined) {
    params.presence_penalty = options.presencePenalty;
  }
  if (options?.seed !== undefined) {
    params.seed = options.seed;
  }
  if (options?.stop !== undefined && options.stop.length > 0) {
    params.stop = options.stop;
  }
  if (supportsModelTools(model)) {
    if (context.tools) {
      const converted = convertTools(context.tools, compat, model);
      if (
        converted.tools.length > 0 ||
        (converted.projection.inputToolCount === 0 && converted.projection.diagnostics.length === 0)
      ) {
        params.tools = converted.tools;
      } else if (hasToolHistory(context.messages)) {
        params.tools = [];
      }
      if (options?.toolChoice) {
        const toolChoice = reconcileOpenAICompletionsToolChoice(
          options.toolChoice,
          converted.projection,
        );
        if (toolChoice !== undefined) {
          params.tool_choice = toolChoice;
        }
      } else if (
        compatDetection.capabilities.usesExplicitProxyLikeEndpoint &&
        Array.isArray(params.tools) &&
        params.tools.length > 0
      ) {
        params.tool_choice = "auto";
      }
    } else if (hasToolHistory(context.messages)) {
      params.tools = [];
    }
    if (
      compatDetection.capabilities.usesExplicitProxyLikeEndpoint &&
      Array.isArray(params.tools) &&
      params.tools.length === 0
    ) {
      delete params.tools;
      delete params.tool_choice;
    }
  }
  {
    const maxTokenBudget = resolveOpenAICompletionsMaxTokens(model, options);
    const effectiveMaxTokens = maxTokenBudget.maxTokens;
    const effectiveContextTokens = resolveOpenAICompletionsEffectiveContextTokens(model);
    let clampedMaxTokens = effectiveMaxTokens;
    const modelMaxTokens = resolveOpenAICompletionsModelMaxTokens(model);
    if (
      maxTokenBudget.clampToModelMaxTokens &&
      clampedMaxTokens !== undefined &&
      modelMaxTokens !== undefined &&
      clampedMaxTokens > modelMaxTokens
    ) {
      clampedMaxTokens = modelMaxTokens;
      emitModelTransportDebug(
        log,
        `[completions] clamp_max_tokens provider=${model.provider} api=${model.api} ` +
          `model=${model.id} requested=${effectiveMaxTokens} output=${clampedMaxTokens} ` +
          `modelMaxTokens=${modelMaxTokens}`,
      );
    }
    if (
      compatDetection.capabilities.usesExplicitProxyLikeEndpoint &&
      clampedMaxTokens !== undefined &&
      effectiveContextTokens !== undefined
    ) {
      const estimatedInputTokens = estimateOpenAICompletionsInputTokens(params);
      const remainingBudget = Math.max(1, effectiveContextTokens - estimatedInputTokens - 1);
      if (clampedMaxTokens > remainingBudget) {
        clampedMaxTokens = remainingBudget;
        emitModelTransportDebug(
          log,
          `[completions] clamp_max_tokens provider=${model.provider} api=${model.api} ` +
            `model=${model.id} requested=${effectiveMaxTokens} output=${clampedMaxTokens} ` +
            `effectiveContext=${effectiveContextTokens} estimatedInput=${estimatedInputTokens}`,
        );
      }
    }
    if (clampedMaxTokens) {
      if (compat.maxTokensField === "max_tokens") {
        params.max_tokens = clampedMaxTokens;
      } else {
        params.max_completion_tokens = clampedMaxTokens;
      }
    }
  }
  const completionsReasoningEffort = resolveOpenAICompletionsReasoningEffort(options);
  const resolvedCompletionsReasoningEffort = completionsReasoningEffort
    ? resolveOpenAIReasoningEffortForModel({
        model,
        effort: completionsReasoningEffort,
        fallbackMap: compat.reasoningEffortMap,
      })
    : undefined;
  const omitChatCompletionsToolReasoningEffort =
    Array.isArray(params.tools) &&
    params.tools.length > 0 &&
    (isOpenAIGpt54MiniModel(model) ||
      (isOpenAIGpt55Model(model) && isKnownOpenAICompletionsEndpoint(model)));
  const handledQwenThinkingFormat = applyQwenOpenAICompletionsThinkingParams({
    compatThinkingFormat: compat.thinkingFormat,
    modelReasoning: model.reasoning,
    payload: params,
    requestedEffort: completionsReasoningEffort,
  });
  applyTogetherOpenAICompletionsThinkingParams({
    compatThinkingFormat: compat.thinkingFormat,
    modelReasoning: model.reasoning,
    payload: params,
    requestedEffort: completionsReasoningEffort,
  });
  if (
    compat.thinkingFormat === "openrouter" &&
    model.reasoning &&
    resolvedCompletionsReasoningEffort
  ) {
    params.reasoning = {
      effort: resolvedCompletionsReasoningEffort,
    };
  } else if (
    resolvedCompletionsReasoningEffort &&
    model.reasoning &&
    compat.supportsReasoningEffort &&
    !handledQwenThinkingFormat &&
    !omitChatCompletionsToolReasoningEffort
  ) {
    params.reasoning_effort = resolvedCompletionsReasoningEffort;
  }
  return params;
}

export function parseTransportChunkUsage(
  rawUsage: NonNullable<ChatCompletionChunk["usage"]>,
  model: Model,
) {
  const cachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
  const promptTokens = rawUsage.prompt_tokens || 0;
  const input = Math.max(0, promptTokens - cachedTokens);
  const outputTokens = rawUsage.completion_tokens || 0;
  const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens;
  const usage = {
    input,
    output: outputTokens,
    cacheRead: cachedTokens,
    cacheWrite: 0,
    ...(typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens)
      ? { reasoningTokens }
      : {}),
    totalTokens: input + outputTokens + cachedTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model as never, usage as never);
  return usage;
}

function hasOpenAICompletionsReasoningUsageActivity(
  rawUsage: NonNullable<ChatCompletionChunk["usage"]>,
) {
  const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens;
  return (
    typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens) && reasoningTokens > 0
  );
}

function mapStopReason(reason: string | null) {
  if (reason === null) {
    return { stopReason: "stop" };
  }
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
    default:
      return {
        stopReason: "error",
        errorMessage: `Provider finish_reason: ${reason}`,
      };
  }
}

export const testing = {
  getCompat,
  assertCodeModeResponsesToolSurface,
  buildOpenAIClientHeaders,
  buildOpenAISdkClientOptions,
  buildOpenAISdkRequestOptions,
  createAzureOpenAIClient,
  createOpenAICompletionsClient,
  createOpenAIResponsesClient,
  enforceCodeModeResponsesToolSurface,
  sanitizeOpenAICodexResponsesParams,
  buildOpenAICompletionsClientConfig,
  processOpenAICompletionsStream,
  processResponsesStream,
  shouldEmitOpenAICompletionsReasoningForModel,
  formatModelTransportDebugBaseUrl,
  buildResponsesFailedNoDetailsObservation,
  buildOpenAIResponsesReasoningReplayMetadata,
  normalizeResponsesFailedEvent,
  prepareOpenAIResponsesReasoningItemForReplay,
  createResponsesStreamWithEncryptedContentRetry,
  stripResponsesRequestEncryptedContent,
  tagOpenAIResponsesReasoningReplayItem,
  summarizeResponsesFailedNoDetailsObservation,
  summarizeResponsesPayload,
  summarizeResponsesTools,
  withResponsesFirstEventTimeout,
};
export { testing as __testing };

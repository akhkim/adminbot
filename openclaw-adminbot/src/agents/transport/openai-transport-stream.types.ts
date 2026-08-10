import type {
  ResponseCreateParamsStreaming,
  ResponseOutputMessage,
  ResponseReasoningItem,
} from "openai/resources/responses/responses.js";
import type { ModelCompatConfig } from "../../config/types/models.js";
/**
 * Shared option and payload types for the OpenAI-compatible transport.
 *
 * Kept separate from the stream entry so the concern-specific fragments can share
 * them without importing the entry back — the transport's own modules would
 * otherwise form a cycle through it.
 */
import type { Api, Model } from "../../llm/types.js";
import type { OpenAIReasoningEffort } from "./openai-reasoning-effort.js";
import type { OpenAICompletionsToolChoice } from "./openai-tool-projection.js";
import { OPENAI_RESPONSES_REASONING_REPLAY_META_KEY } from "./openai-transport-stream.constants.js";

export type ReplayableResponseOutputMessage = Omit<ResponseOutputMessage, "id"> & { id?: string };
export type OpenAIResponsesReasoningReplayMetadata = {
  v: 1;
  source: "openai-responses";
  provider: string;
  api: Api;
  model: string;
  baseUrlHash?: string;
  sessionHash?: string;
  authProfileHash?: string;
};
export type ReplayableResponseReasoningItem = Omit<ResponseReasoningItem, "id"> & {
  id?: string;
  [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]?: OpenAIResponsesReasoningReplayMetadata;
};

export type BaseStreamOptions = {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  signal?: AbortSignal;
  apiKey?: string;
  cacheRetention?: "none" | "short" | "long";
  sessionId?: string;
  promptCacheKey?: string;
  authProfileId?: string;
  onPayload?: (payload: unknown, model: Model) => unknown;
  headers?: Record<string, string>;
  openclawCodeModeToolSurface?: boolean;
  responseFormat?: Record<string, unknown>;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
};

export type OpenAIResponsesOptions = BaseStreamOptions & {
  reasoning?: OpenAIReasoningEffort;
  reasoningEffort?: OpenAIReasoningEffort;
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  replayResponsesItemIds?: boolean;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
};

export type OpenAIResponsesReplayContext = {
  provider: string;
  api: Api;
  model: string;
  baseUrlHash?: string;
  sessionHash?: string;
  authProfileHash?: string;
};

export type OpenAICompletionsOptions = BaseStreamOptions & {
  toolChoice?: OpenAICompletionsToolChoice;
  reasoning?: OpenAIReasoningEffort;
  reasoningEffort?: OpenAIReasoningEffort;
};

export type OpenAIModeCompatInput = Omit<ModelCompatConfig, "thinkingFormat"> & {
  thinkingFormat?: string;
};

export type OpenAIModeModel = Omit<Model, "compat"> & {
  compat?: OpenAIModeCompatInput | null;
};

export type MutableAssistantOutput = {
  role: "assistant";
  content: Array<Record<string, unknown>>;
  api: Api;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoningTokens?: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: string;
  timestamp: number;
  responseId?: string;
  errorMessage?: string;
  errorCode?: string;
  errorType?: string;
  errorBody?: string;
};

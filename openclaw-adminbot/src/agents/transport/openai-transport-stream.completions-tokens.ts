import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../shared/cjk-chars.js";
import { resolveMaxTokensParam } from "../models/model-max-tokens-params.js";
/**
 * OpenAI-completions payload: token budget and thinking parameters.
 *
 * max_tokens has to be derived from an estimate of the input because the
 * completions API budgets input and output against one context window. The
 * estimate is deliberately conservative — a safety margin on the char/token
 * ratio and a flat per-image charge — since underestimating truncates the reply.
 */
import type { OpenAIReasoningEffort } from "./openai-reasoning-effort.js";
import { COMPLETIONS_REASONING_REPLAY_FIELDS } from "./openai-transport-stream.completions-reasoning-replay.js";
import type { OpenAICompletionsOptions, OpenAIModeModel } from "./openai-transport-stream.types.js";

export function resolveOpenAICompletionsReasoningEffort(
  options: OpenAICompletionsOptions | undefined,
) {
  return options?.reasoningEffort ?? options?.reasoning ?? "high";
}

export function shouldEmitOpenAICompletionsReasoning(
  model: OpenAIModeModel,
  options: OpenAICompletionsOptions | undefined,
) {
  if (!model.reasoning) {
    return false;
  }
  const effort = resolveOpenAICompletionsReasoningEffort(options);
  if (!effort || !isOpenAICompletionsThinkingEnabled(effort)) {
    return false;
  }
  return true;
}

export function shouldEmitOpenAICompletionsReasoningForModel(
  model: OpenAIModeModel,
  options: OpenAICompletionsOptions | undefined,
) {
  return shouldEmitOpenAICompletionsReasoning(model, options);
}

export function resolveOpenAICompletionsMaxTokens(
  model: OpenAIModeModel,
  options: OpenAICompletionsOptions | undefined,
): { maxTokens: number | undefined; clampToModelMaxTokens: boolean } {
  if (options?.maxTokens) {
    return { maxTokens: options.maxTokens, clampToModelMaxTokens: true };
  }
  const paramsMaxTokens = resolveMaxTokensParam(
    (model as { params?: Record<string, unknown> }).params,
  );
  if (paramsMaxTokens) {
    return { maxTokens: paramsMaxTokens, clampToModelMaxTokens: false };
  }
  return { maxTokens: model.maxTokens, clampToModelMaxTokens: false };
}

export function resolveOpenAICompletionsModelMaxTokens(model: OpenAIModeModel): number | undefined {
  return typeof model.maxTokens === "number" &&
    Number.isFinite(model.maxTokens) &&
    model.maxTokens > 0
    ? Math.floor(model.maxTokens)
    : undefined;
}

export const OPENAI_COMPLETIONS_INPUT_TOKEN_SAFETY_MARGIN = 1.25;
export const OPENAI_COMPLETIONS_IMAGE_CHAR_ESTIMATE = 8_000;

// Used only to bound `max_completion_tokens` below the effective context cap
// for strict OpenAI-compatible servers (e.g. vLLM, StepFun). The CJK-aware
// helper avoids undercounting non-Latin prompts enough to trigger server-side
// context rejections; wrong-high here just trims output a little. Estimate the
// final shaped payload, not the raw context, so compat transforms and dropped
// replay turns are reflected in the output cap.
export function estimateOpenAICompletionsInputTokens(payload: {
  messages?: unknown;
  tools?: unknown;
  response_format?: unknown;
}): number {
  let adjustedChars = 0;
  adjustedChars += estimateOpenAICompletionsMessagesChars(payload.messages);
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    try {
      adjustedChars += estimateStringChars(JSON.stringify(payload.tools));
    } catch {
      adjustedChars += 1024;
    }
  }
  if (payload.response_format !== undefined) {
    try {
      adjustedChars += estimateStringChars(JSON.stringify(payload.response_format));
    } catch {
      adjustedChars += 256;
    }
  }
  return Math.ceil(
    (adjustedChars / CHARS_PER_TOKEN_ESTIMATE) * OPENAI_COMPLETIONS_INPUT_TOKEN_SAFETY_MARGIN,
  );
}

export function estimateOpenAICompletionsMessagesChars(messages: unknown): number {
  if (!Array.isArray(messages)) {
    return 0;
  }
  let adjustedChars = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    adjustedChars += estimateOpenAICompletionsContentChars(record.content);
    for (const field of COMPLETIONS_REASONING_REPLAY_FIELDS) {
      adjustedChars += estimateOpenAICompletionsContentChars(record[field]);
    }
    if (record.tool_calls !== undefined) {
      try {
        adjustedChars += estimateStringChars(JSON.stringify(record.tool_calls));
      } catch {
        adjustedChars += 256;
      }
    }
  }
  return adjustedChars;
}

export function estimateOpenAICompletionsContentChars(value: unknown): number {
  if (typeof value === "string") {
    return estimateStringChars(value);
  }
  if (!Array.isArray(value)) {
    return 0;
  }
  let adjustedChars = 0;
  for (const block of value) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "image_url" || record.type === "input_image") {
      adjustedChars += OPENAI_COMPLETIONS_IMAGE_CHAR_ESTIMATE;
      continue;
    }
    const text = record.text;
    if (typeof text === "string") {
      adjustedChars += estimateStringChars(text);
      continue;
    }
    try {
      adjustedChars += estimateStringChars(JSON.stringify(block));
    } catch {
      adjustedChars += 256;
    }
  }
  return adjustedChars;
}

export function resolveOpenAICompletionsEffectiveContextTokens(
  model: OpenAIModeModel,
): number | undefined {
  const contextTokens = (model as { contextTokens?: number }).contextTokens;
  if (typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0) {
    return contextTokens;
  }
  return typeof model.contextWindow === "number" &&
    Number.isFinite(model.contextWindow) &&
    model.contextWindow > 0
    ? model.contextWindow
    : undefined;
}

export function isQwenOpenAICompletionsThinkingFormat(format: string): boolean {
  return format === "qwen" || format === "qwen-chat-template";
}

export function isOpenAICompletionsThinkingEnabled(effort: OpenAIReasoningEffort): boolean {
  const normalized = effort.trim().toLowerCase();
  return normalized !== "off" && normalized !== "none";
}

export function setQwenChatTemplateThinking(
  params: Record<string, unknown>,
  enabled: boolean,
): void {
  const existing = params.chat_template_kwargs;
  params.chat_template_kwargs =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>), enable_thinking: enabled }
      : { enable_thinking: enabled };
}

export function applyQwenOpenAICompletionsThinkingParams(params: {
  compatThinkingFormat: string;
  modelReasoning: boolean;
  payload: Record<string, unknown>;
  requestedEffort: OpenAIReasoningEffort;
}): boolean {
  if (
    !params.modelReasoning ||
    !isQwenOpenAICompletionsThinkingFormat(params.compatThinkingFormat)
  ) {
    return false;
  }
  const enabled = isOpenAICompletionsThinkingEnabled(params.requestedEffort);
  if (params.compatThinkingFormat === "qwen-chat-template") {
    setQwenChatTemplateThinking(params.payload, enabled);
  } else {
    params.payload.enable_thinking = enabled;
  }
  return true;
}

export function applyTogetherOpenAICompletionsThinkingParams(params: {
  compatThinkingFormat: string;
  modelReasoning: boolean;
  payload: Record<string, unknown>;
  requestedEffort: OpenAIReasoningEffort;
}): boolean {
  if (!params.modelReasoning || params.compatThinkingFormat !== "together") {
    return false;
  }
  params.payload.reasoning = {
    enabled: isOpenAICompletionsThinkingEnabled(params.requestedEffort),
  };
  return true;
}

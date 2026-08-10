/**
 * OpenAI-completions payload: reasoning replay sanitization.
 *
 * Replayed assistant turns may carry provider reasoning fields that only the
 * originating provider can validate. Sending them back to a different provider
 * (or a different tier of the same model) is rejected, so they are stripped
 * unless the model is known to round-trip its own reasoning — the model-id
 * candidates strip tier suffixes so a -free/-paid variant still matches.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenAIModeModel } from "./openai-transport-stream.types.js";

export const COMPLETIONS_REASONING_REPLAY_FIELDS = [
  "reasoning_details",
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const;

export function stripCompletionsReasoningReplayFields(record: Record<string, unknown>): void {
  for (const field of COMPLETIONS_REASONING_REPLAY_FIELDS) {
    if (field in record) {
      delete record[field];
    }
  }
}

export function sanitizeOpenRouterReasoningReplayFields(record: Record<string, unknown>): void {
  const reasoningDetails = record.reasoning_details;
  if (typeof reasoningDetails === "string") {
    if (reasoningDetails.length > 0 && typeof record.reasoning !== "string") {
      record.reasoning = reasoningDetails;
    }
    delete record.reasoning_details;
  } else if (reasoningDetails !== undefined && !Array.isArray(reasoningDetails)) {
    delete record.reasoning_details;
  }

  // Empty reasoning artifacts are rejected by OpenRouter/DeepSeek replay.
  if ("reasoning" in record && (typeof record.reasoning !== "string" || record.reasoning === "")) {
    delete record.reasoning;
  }
  if (
    "reasoning_content" in record &&
    (typeof record.reasoning_content !== "string" || record.reasoning_content === "")
  ) {
    delete record.reasoning_content;
  }

  const reasoningText = record.reasoning_text;
  if (
    typeof reasoningText === "string" &&
    reasoningText.length > 0 &&
    typeof record.reasoning !== "string" &&
    typeof record.reasoning_content !== "string"
  ) {
    record.reasoning = reasoningText;
  }
  if ("reasoning_text" in record) {
    delete record.reasoning_text;
  }
}

export function sanitizeReasoningContentReplayFields(record: Record<string, unknown>): void {
  if ("reasoning_content" in record && typeof record.reasoning_content !== "string") {
    delete record.reasoning_content;
  }
  delete record.reasoning_details;
  delete record.reasoning;
  delete record.reasoning_text;
}

export const REASONING_CONTENT_REPLAY_MODEL_IDS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "kimi-for-coding",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k2-thinking",
  "kimi-k2-thinking-turbo",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-pro",
]);

// Tier/access suffixes that some providers append to otherwise identical model
// ids (OpenCode Zen exposes `deepseek-v4-flash-free`, OpenRouter exposes
// `:free` / `:cloud`, etc.). The base model id before the suffix still owns
// the same DeepSeek-style reasoning_content replay contract, so reasoning
// replay must not be stripped just because the catalog id grew a marketing
// suffix (#87575).
export const REASONING_CONTENT_REPLAY_TIER_SUFFIXES = ["-free", "-paid", "-trial"] as const;

export function stripReasoningContentReplayTierSuffix(modelId: string): string {
  for (const suffix of REASONING_CONTENT_REPLAY_TIER_SUFFIXES) {
    if (modelId.length > suffix.length && modelId.endsWith(suffix)) {
      return modelId.slice(0, -suffix.length);
    }
  }
  return modelId;
}

export function getReasoningContentReplayModelIdCandidates(modelId: unknown): string[] {
  if (typeof modelId !== "string") {
    return [];
  }
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const parts = normalized.split("/").filter(Boolean);
  const finalPart = parts[parts.length - 1] ?? normalized;
  const candidates = [finalPart];
  const colonParts = finalPart.split(":").filter(Boolean);
  if (colonParts.length > 1) {
    candidates.push(colonParts[0] ?? "", colonParts[colonParts.length - 1] ?? "");
  }
  const baseCount = candidates.length;
  for (let index = 0; index < baseCount; index += 1) {
    const candidate = candidates[index];
    if (typeof candidate !== "string") {
      continue;
    }
    const stripped = stripReasoningContentReplayTierSuffix(candidate);
    if (stripped !== candidate) {
      candidates.push(stripped);
    }
  }
  return uniqueStrings(candidates.filter(Boolean));
}

export function shouldPreserveReasoningContentReplay(
  model: OpenAIModeModel,
  compat: { requiresReasoningContentOnAssistantMessages: boolean; thinkingFormat: string },
): boolean {
  if (
    compat.requiresReasoningContentOnAssistantMessages ||
    compat.thinkingFormat === "deepseek" ||
    compat.thinkingFormat === "zai" ||
    shouldTrustReasoningContentReplayMetadata(model)
  ) {
    return true;
  }
  return getReasoningContentReplayModelIdCandidates(model.id).some((modelId) =>
    REASONING_CONTENT_REPLAY_MODEL_IDS.has(modelId),
  );
}

export function shouldPreserveOpenRouterReasoningReplay(model: OpenAIModeModel): boolean {
  if (model.provider !== "openrouter") {
    return true;
  }
  const normalizedModelId = model.id.trim().toLowerCase();
  return !(normalizedModelId.startsWith("anthropic/") || normalizedModelId.startsWith("x-ai/"));
}

export function shouldTrustReasoningContentReplayMetadata(model: OpenAIModeModel): boolean {
  if (!model.reasoning) {
    return false;
  }
  const provider = model.provider.trim().toLowerCase();
  if (provider === "openai") {
    return false;
  }
  return shouldPreserveOpenRouterReasoningReplay(model);
}

// OpenAI Chat Completions assistant-message input does not define reasoning
// replay fields, while OpenRouter and DeepSeek-style providers document
// compatible pass-back contracts. Keep valid provider-owned replay fields, but
// strip them for stock OpenAI before a follow-up request hits the wire.
export function sanitizeCompletionsReasoningReplayFields(
  messages: unknown,
  options: { preserveOpenRouterReasoning: boolean; preserveReasoningContent: boolean },
): void {
  if (!Array.isArray(messages)) {
    return;
  }
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const record = msg as Record<string, unknown>;
    if (record.role !== "assistant") {
      continue;
    }
    if (options.preserveOpenRouterReasoning) {
      sanitizeOpenRouterReasoningReplayFields(record);
    } else if (options.preserveReasoningContent) {
      sanitizeReasoningContentReplayFields(record);
    } else {
      stripCompletionsReasoningReplayFields(record);
    }
  }
}

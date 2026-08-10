import type {
  ResponseFormatTextConfig,
  ResponseInput,
  ResponseInputItem,
  ResponseInputMessageContentList,
} from "openai/resources/responses/responses.js";
/**
 * Responses payload: OpenAI Codex backend compatibility.
 *
 * The native Codex Responses backend rejects several parameters the standard
 * Responses API accepts, and requires a non-empty input and explicit
 * instructions. Detection is by base URL rather than by model id, because the
 * same model id is served by both backends.
 */
import type { Context, Model } from "../../llm/types.js";
import { stripSystemPromptCacheBoundary } from "../prompt/system-prompt-cache-boundary.js";
import {
  OPENAI_CODEX_RESPONSES_DEFAULT_INSTRUCTIONS,
  OPENAI_CODEX_RESPONSES_EMPTY_INPUT_TEXT,
  OPENAI_CODEX_RESPONSES_PROVIDERS,
} from "./openai-transport-stream.constants.js";
import { sanitizeTransportPayloadText } from "./transport-stream-shared.js";

export function buildResponsesInputMessage(
  role: "user" | "system" | "developer",
  content: ResponseInputMessageContentList,
): ResponseInputItem.Message {
  return { type: "message", role, content };
}

export function isOpenAICodexResponsesModel(model: Model): boolean {
  return (
    OPENAI_CODEX_RESPONSES_PROVIDERS.has(model.provider) &&
    (model.api === "openai-chatgpt-responses" ||
      model.api === "openclaw-openai-responses-transport")
  );
}

export function isNativeOpenAICodexResponsesBaseUrl(baseUrl?: string): boolean {
  const trimmed = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!trimmed) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    if (url.hostname.toLowerCase() !== "chatgpt.com") {
      return false;
    }
    const pathname = url.pathname.replace(/\/+$/u, "").toLowerCase();
    return [
      "/backend-api",
      "/backend-api/v1",
      "/backend-api/codex",
      "/backend-api/codex/v1",
    ].includes(pathname);
  } catch {
    return false;
  }
}

export function usesNativeOpenAICodexResponsesBackend(model: Model): boolean {
  return isOpenAICodexResponsesModel(model) && isNativeOpenAICodexResponsesBaseUrl(model.baseUrl);
}

export const OPENAI_CODEX_RESPONSES_UNSUPPORTED_PARAMS = [
  "max_output_tokens",
  "metadata",
  "prompt_cache_retention",
  "service_tier",
  "temperature",
  "top_p",
] as const;

export function stripOpenAICodexResponsesUnsupportedTextFields(
  params: Record<string, unknown>,
): void {
  const text = params.text;
  if (!text || typeof text !== "object" || Array.isArray(text)) {
    return;
  }
  const sanitizedText = { ...(text as Record<string, unknown>) };
  delete sanitizedText.format;
  if (Object.keys(sanitizedText).length > 0) {
    params.text = sanitizedText;
  } else {
    delete params.text;
  }
}

export function sanitizeOpenAICodexResponsesParams<T extends Record<string, unknown>>(
  model: Model,
  params: T,
): T {
  if (!usesNativeOpenAICodexResponsesBackend(model)) {
    return params;
  }
  for (const key of OPENAI_CODEX_RESPONSES_UNSUPPORTED_PARAMS) {
    delete params[key];
  }
  stripOpenAICodexResponsesUnsupportedTextFields(params);
  return params;
}

export function buildOpenAICodexResponsesInstructions(context: Context): string | undefined {
  if (!context.systemPrompt) {
    return undefined;
  }
  return sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt));
}

export function resolveOpenAICodexResponsesInstructions(
  model: Model,
  context: Context,
): string | undefined {
  const instructions = buildOpenAICodexResponsesInstructions(context);
  if (instructions && instructions.trim().length > 0) {
    return instructions;
  }
  return usesNativeOpenAICodexResponsesBackend(model)
    ? OPENAI_CODEX_RESPONSES_DEFAULT_INSTRUCTIONS
    : undefined;
}

export function ensureOpenAICodexResponsesInput(messages: ResponseInput, context: Context): void {
  if (messages.length > 0 || !context.systemPrompt) {
    return;
  }
  const text = buildOpenAICodexResponsesInstructions(context);
  if (!text) {
    throw new Error(
      "OpenAI Codex Responses requires non-empty input when only systemPrompt is provided.",
    );
  }
  messages.push(
    buildResponsesInputMessage("user", [
      { type: "input_text", text: OPENAI_CODEX_RESPONSES_EMPTY_INPUT_TEXT },
    ]),
  );
}

export function resolveOpenAIResponsesTextFormat(
  responseFormat: Record<string, unknown>,
): ResponseFormatTextConfig {
  if (
    responseFormat.type === "json_schema" &&
    responseFormat.json_schema &&
    typeof responseFormat.json_schema === "object" &&
    !Array.isArray(responseFormat.json_schema)
  ) {
    return {
      ...(responseFormat.json_schema as Record<string, unknown>),
      type: "json_schema",
    } as unknown as ResponseFormatTextConfig;
  }
  return responseFormat as unknown as ResponseFormatTextConfig;
}

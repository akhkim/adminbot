/**
 * Model compatibility resolution for the OpenAI-compatible transport.
 *
 * A model's explicit `compat` config always wins; anything it leaves unset falls
 * back to what the endpoint was detected to support. The two-layer merge is why
 * these are separate functions — detection must stay independent of the override
 * so a config that sets one flag does not suppress the rest.
 */
import { detectOpenAICompletionsCompat } from "./openai-completions-compat.js";
import { resolveOpenAIReasoningEffortMap } from "./openai-reasoning-compat.js";
import type { OpenAIModeModel } from "./openai-transport-stream.types.js";

export function detectCompat(model: OpenAIModeModel) {
  const { defaults: compatDefaults } = detectOpenAICompletionsCompat(model);
  return {
    supportsStore: compatDefaults.supportsStore,
    supportsDeveloperRole: compatDefaults.supportsDeveloperRole,
    supportsReasoningEffort: compatDefaults.supportsReasoningEffort,
    reasoningEffortMap: {},
    supportsUsageInStreaming: compatDefaults.supportsUsageInStreaming,
    maxTokensField: compatDefaults.maxTokensField,
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    thinkingFormat: compatDefaults.thinkingFormat,
    visibleReasoningDetailTypes: compatDefaults.visibleReasoningDetailTypes,
    openRouterRouting: {},
    vercelGatewayRouting: {},
    supportsStrictMode: compatDefaults.supportsStrictMode,
    requiresReasoningContentOnAssistantMessages:
      compatDefaults.requiresReasoningContentOnAssistantMessages,
    requiresNonEmptyUserOrAssistantMessage: compatDefaults.requiresNonEmptyUserOrAssistantMessage,
  };
}

export function getCompat(model: OpenAIModeModel): {
  supportsStore: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  reasoningEffortMap: Record<string, string>;
  supportsUsageInStreaming: boolean;
  maxTokensField: string;
  requiresToolResultName: boolean;
  requiresAssistantAfterToolResult: boolean;
  requiresThinkingAsText: boolean;
  thinkingFormat: string;
  openRouterRouting: Record<string, unknown>;
  vercelGatewayRouting: Record<string, unknown>;
  supportsStrictMode: boolean;
  supportsPromptCacheKey: boolean;
  supportsLongCacheRetention: boolean;
  requiresStringContent: boolean;
  strictMessageKeys: boolean;
  visibleReasoningDetailTypes: string[];
  requiresReasoningContentOnAssistantMessages: boolean;
  requiresNonEmptyUserOrAssistantMessage: boolean;
} {
  const detected = detectCompat(model);
  const compat = model.compat ?? {};
  const supportsStore =
    typeof compat.supportsStore === "boolean" ? compat.supportsStore : detected.supportsStore;
  const supportsReasoningEffort =
    typeof compat.supportsReasoningEffort === "boolean"
      ? compat.supportsReasoningEffort
      : detected.supportsReasoningEffort;
  return {
    supportsStore,
    supportsDeveloperRole: compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsReasoningEffort,
    reasoningEffortMap: resolveOpenAIReasoningEffortMap(model, detected.reasoningEffortMap),
    supportsUsageInStreaming: compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
    maxTokensField: (compat.maxTokensField as string | undefined) ?? detected.maxTokensField,
    requiresToolResultName: compat.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText: compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
    thinkingFormat: compat.thinkingFormat ?? detected.thinkingFormat,
    openRouterRouting: (compat.openRouterRouting as Record<string, unknown> | undefined) ?? {},
    vercelGatewayRouting:
      (compat.vercelGatewayRouting as Record<string, unknown> | undefined) ??
      detected.vercelGatewayRouting,
    supportsStrictMode: compat.supportsStrictMode ?? detected.supportsStrictMode,
    supportsPromptCacheKey: compat.supportsPromptCacheKey === true,
    supportsLongCacheRetention: compat.supportsLongCacheRetention !== false,
    requiresStringContent: compat.requiresStringContent ?? false,
    strictMessageKeys: compat.strictMessageKeys === true,
    visibleReasoningDetailTypes:
      compat.visibleReasoningDetailTypes ?? detected.visibleReasoningDetailTypes,
    requiresReasoningContentOnAssistantMessages:
      compat.requiresReasoningContentOnAssistantMessages ??
      detected.requiresReasoningContentOnAssistantMessages,
    requiresNonEmptyUserOrAssistantMessage: detected.requiresNonEmptyUserOrAssistantMessage,
  };
}

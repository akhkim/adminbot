import { createHash } from "node:crypto";
import type { FunctionTool } from "openai/resources/responses/responses.js";
/**
 * Transport payload: tool projection and Google thought signatures.
 *
 * Google's OpenAI-compatible endpoint requires each replayed tool call to carry
 * back the thought signature it issued. A truncated signature is worse than an
 * absent one — it is rejected rather than ignored — so signatures showing a
 * truncation footprint (ellipsis, non-base64) are dropped instead of replayed.
 */
import type { Context, Model } from "../../llm/types.js";
import { detectOpenAICompletionsCompat } from "./openai-completions-compat.js";
import { resolveOpenAIStrictToolSetting } from "./openai-strict-tool-setting.js";
import { type OpenAIToolProjection, projectOpenAITools } from "./openai-tool-projection.js";
import {
  findOpenAIStrictToolProjectionDiagnostics,
  normalizeOpenAIStrictToolParameters,
  resolveOpenAIProjectedToolsStrictToolFlag,
} from "./openai-tool-schema.js";
import { getCompat } from "./openai-transport-stream.compat.js";
import {
  GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP,
  MAX_OPENAI_STRICT_TOOL_DOWNGRADE_DIAGNOSTIC_KEYS,
  log,
  loggedOpenAIStrictToolDowngradeDiagnosticKeys,
} from "./openai-transport-stream.constants.js";
import type { OpenAIModeModel } from "./openai-transport-stream.types.js";

export function convertResponsesTools(
  tools: NonNullable<Context["tools"]>,
  model: OpenAIModeModel,
  options?: { strict?: boolean | null },
): { projection: OpenAIToolProjection; tools: FunctionTool[] } {
  const projection = projectOpenAITools(tools);
  const strict = resolveOpenAIStrictToolFlagWithDiagnostics(projection, options?.strict, {
    transport: "responses",
    model,
  });
  return {
    projection,
    tools: sortTransportToolsByName(projection.tools).map((tool): FunctionTool => {
      const result = {
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: normalizeOpenAIStrictToolParameters(
          tool.parameters,
          strict === true,
          model.compat,
        ),
      } as FunctionTool;
      if (strict !== undefined) {
        result.strict = strict;
      }
      return result;
    }),
  };
}

export function resolveOpenAIStrictToolFlagWithDiagnostics(
  projection: OpenAIToolProjection,
  strictSetting: boolean | null | undefined,
  context: { transport: "responses" | "completions"; model: OpenAIModeModel },
): boolean | undefined {
  const strict = resolveOpenAIProjectedToolsStrictToolFlag(projection, strictSetting);
  if (strictSetting === true && strict === false && log.isEnabled("debug", "any")) {
    const diagnostics = findOpenAIStrictToolProjectionDiagnostics(projection);
    if (!shouldLogOpenAIStrictToolDowngradeDiagnostic(diagnostics, context)) {
      return strict;
    }
    const sample = diagnostics.slice(0, 5).map((entry) => ({
      tool: entry.toolName ?? `tool[${entry.toolIndex}]`,
      violations: entry.violations.slice(0, 8),
    }));
    log.debug(
      `OpenAI ${context.transport} tool schema strict mode downgraded to strict=false for ` +
        `${context.model.provider ?? "unknown"}/${context.model.id ?? "unknown"} ` +
        `because ${diagnostics.length} tool schema(s) are not strict-compatible`,
      {
        transport: context.transport,
        provider: context.model.provider,
        model: context.model.id,
        incompatibleToolCount: diagnostics.length,
        sample,
      },
    );
  }
  return strict;
}

export function buildOpenAIStrictToolDowngradeDiagnosticKey(
  diagnostics: ReturnType<typeof findOpenAIStrictToolProjectionDiagnostics>,
  context: { transport: "responses" | "completions"; model: OpenAIModeModel },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        transport: context.transport,
        provider: context.model.provider ?? null,
        model: context.model.id ?? null,
        diagnostics: diagnostics.map((entry) => ({
          toolIndex: entry.toolIndex,
          toolName: entry.toolName ?? null,
          violations: entry.violations,
        })),
      }),
    )
    .digest("hex");
}

export function shouldLogOpenAIStrictToolDowngradeDiagnostic(
  diagnostics: ReturnType<typeof findOpenAIStrictToolProjectionDiagnostics>,
  context: { transport: "responses" | "completions"; model: OpenAIModeModel },
): boolean {
  const key = buildOpenAIStrictToolDowngradeDiagnosticKey(diagnostics, context);
  if (loggedOpenAIStrictToolDowngradeDiagnosticKeys.has(key)) {
    return false;
  }
  if (
    loggedOpenAIStrictToolDowngradeDiagnosticKeys.size >=
    MAX_OPENAI_STRICT_TOOL_DOWNGRADE_DIAGNOSTIC_KEYS
  ) {
    loggedOpenAIStrictToolDowngradeDiagnosticKeys.clear();
  }
  loggedOpenAIStrictToolDowngradeDiagnosticKeys.add(key);
  return true;
}

export function convertTools(
  tools: NonNullable<Context["tools"]>,
  compat: ReturnType<typeof getCompat>,
  model: OpenAIModeModel,
) {
  const projection = projectOpenAITools(tools);
  const strict = resolveOpenAIStrictToolFlagWithDiagnostics(
    projection,
    resolveOpenAIStrictToolSetting(model, {
      transport: "stream",
      supportsStrictMode: compat?.supportsStrictMode,
    }),
    {
      transport: "completions",
      model,
    },
  );
  return {
    projection,
    tools: sortTransportToolsByName(projection.tools).map((tool) => {
      const functionTool: {
        name: string;
        description: string | undefined;
        parameters: ReturnType<typeof normalizeOpenAIStrictToolParameters>;
        strict?: boolean;
      } = {
        name: tool.name,
        description: tool.description,
        parameters: normalizeOpenAIStrictToolParameters(
          tool.parameters,
          strict === true,
          model.compat,
        ),
      };
      if (strict !== undefined) {
        functionTool.strict = strict;
      }
      return {
        type: "function",
        function: functionTool,
      };
    }),
  };
}

export function compareTransportToolText(
  left: string | undefined,
  right: string | undefined,
): number {
  const leftText = left ?? "";
  const rightText = right ?? "";
  if (leftText < rightText) {
    return -1;
  }
  if (leftText > rightText) {
    return 1;
  }
  return 0;
}

export function sortTransportToolsByName<T extends { name?: string; description?: string }>(
  tools: readonly T[],
): T[] {
  return tools.toSorted(
    (left, right) =>
      compareTransportToolText(left.name, right.name) ||
      compareTransportToolText(left.description, right.description),
  );
}

export function extractGoogleThoughtSignature(toolCall: unknown): string | undefined {
  const tc = toolCall as Record<string, unknown> | undefined;
  if (!tc) {
    return undefined;
  }
  const extra = (tc.extra_content as Record<string, unknown> | undefined)?.google as
    | Record<string, unknown>
    | undefined;
  const fromExtra = extra?.thought_signature;
  if (typeof fromExtra === "string" && fromExtra.length > 0) {
    return fromExtra;
  }
  const fromFunction = (tc.function as { thought_signature?: unknown } | undefined)
    ?.thought_signature;
  return typeof fromFunction === "string" && fromFunction.length > 0 ? fromFunction : undefined;
}

export function isGoogleOpenAICompatModel(model: OpenAIModeModel): boolean {
  const endpointClass = detectOpenAICompletionsCompat(model as Model<"openai-completions">)
    .capabilities.endpointClass;
  return (
    model.provider === "google" ||
    endpointClass === "google-generative-ai" ||
    endpointClass === "google-vertex"
  );
}

export function requiresGoogleCompatToolCallThoughtSignature(model: OpenAIModeModel): boolean {
  return model.id.toLowerCase().includes("gemini-3");
}

export const GOOGLE_COMPAT_THOUGHT_SIGNATURE_ELLIPSIS_RE = /[\u2026]|\.\.\./;
export const GOOGLE_COMPAT_THOUGHT_SIGNATURE_BASE64_RE = /^[A-Za-z0-9+/=]+$/;

export function hasGoogleCompatThoughtSignatureTruncationFootprint(value: string): boolean {
  return (
    GOOGLE_COMPAT_THOUGHT_SIGNATURE_ELLIPSIS_RE.test(value) ||
    (GOOGLE_COMPAT_THOUGHT_SIGNATURE_BASE64_RE.test(value) && value.length % 4 !== 0)
  );
}

export function injectToolCallThoughtSignatures(
  outgoingMessages: unknown[],
  context: Context,
  model: OpenAIModeModel,
): void {
  if (!isGoogleOpenAICompatModel(model)) {
    return;
  }
  const sigById = new Map<string, string>();
  const fallbackSig = requiresGoogleCompatToolCallThoughtSignature(model)
    ? GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP
    : undefined;
  for (const msg of context.messages ?? []) {
    if ((msg as { role?: string }).role !== "assistant") {
      continue;
    }
    const source = msg as { api?: string; provider?: string; model?: string; content?: unknown };
    if (!Array.isArray(source.content)) {
      continue;
    }
    for (const block of source.content as Array<Record<string, unknown>>) {
      if (block.type !== "toolCall") {
        continue;
      }
      const id = block.id;
      const sig = block.thoughtSignature;
      if (typeof id === "string" && typeof sig === "string" && sig.length > 0) {
        const isSameRoute =
          source.api === model.api &&
          source.provider === model.provider &&
          source.model === model.id;
        if (!isSameRoute && !fallbackSig) {
          continue;
        }
        sigById.set(id, isSameRoute ? sig : (fallbackSig ?? sig));
      }
    }
  }
  if (sigById.size === 0 && !fallbackSig) {
    return;
  }
  for (const message of outgoingMessages) {
    const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(toolCalls)) {
      continue;
    }
    for (const toolCall of toolCalls as Array<Record<string, unknown>>) {
      const id = toolCall.id;
      if (typeof id !== "string") {
        continue;
      }
      let sig: string | undefined = sigById.get(id) ?? fallbackSig;
      if (typeof sig === "string" && sig.length > 0) {
        const trimmed = sig.trim();
        if (hasGoogleCompatThoughtSignatureTruncationFootprint(trimmed)) {
          sig = fallbackSig;
        }
      }
      if (typeof sig !== "string" || sig.length === 0) {
        continue;
      }
      const extra =
        toolCall.extra_content && typeof toolCall.extra_content === "object"
          ? (toolCall.extra_content as Record<string, unknown>)
          : {};
      toolCall.extra_content = extra;
      const google =
        extra.google && typeof extra.google === "object"
          ? (extra.google as Record<string, unknown>)
          : {};
      extra.google = google;
      google.thought_signature = sig;
    }
  }
}

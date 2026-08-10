/**
 * Run stage: initial model and thinking level.
 *
 * Resolves what the first attempt will ask for, before any failover or live-switch
 * logic runs. An explicit provider+model pair is taken verbatim; a bare model
 * string is put through the alias index so a configured alias still routes to its
 * real provider; neither means the agent's configured default.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../defaults.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../models/model-selection.js";
import { resolveThinkingDefault } from "../../models/model-thinking-default.js";
import type { RunEmbeddedAgentParams } from "./params.js";

export function resolveInitialThinkLevel(params: {
  requested?: ThinkLevel;
  config?: RunEmbeddedAgentParams["config"];
  provider: string;
  modelId: string;
  model: { reasoning?: boolean };
}): ThinkLevel {
  if (params.requested) {
    return params.requested;
  }
  return resolveThinkingDefault({
    cfg: params.config ?? {},
    provider: params.provider,
    model: params.modelId,
    catalog: [
      {
        provider: params.provider,
        id: params.modelId,
        name: params.modelId,
        reasoning: params.model.reasoning,
      },
    ],
  });
}

export function resolveInitialEmbeddedRunModel(params: {
  config: RunEmbeddedAgentParams["config"];
  agentId?: string;
  provider?: string;
  model?: string;
}): { provider: string; modelId: string } {
  const cfg = params.config ?? {};
  const configuredDefault = resolveDefaultModelForAgent({
    cfg,
    agentId: params.agentId,
  });
  const explicitProvider = normalizeOptionalString(params.provider);
  const explicitModel = normalizeOptionalString(params.model);
  const defaultProvider = configuredDefault.provider || DEFAULT_PROVIDER;

  if (explicitProvider && explicitModel) {
    return { provider: explicitProvider, modelId: explicitModel };
  }

  if (explicitModel) {
    const provider = explicitProvider ?? defaultProvider;
    const aliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: provider,
    });
    const resolved = resolveModelRefFromString({
      cfg,
      raw: explicitModel,
      defaultProvider: provider,
      aliasIndex,
    });
    return {
      provider: explicitProvider ?? resolved?.ref.provider ?? provider,
      modelId: resolved?.ref.model ?? explicitModel,
    };
  }

  return {
    provider: explicitProvider ?? defaultProvider,
    modelId: configuredDefault.model || DEFAULT_MODEL,
  };
}

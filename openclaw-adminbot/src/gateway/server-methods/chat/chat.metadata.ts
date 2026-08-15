import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatMetadataParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveDefaultAgentId } from "../../../agents/agent-scope.js";
import { modelCatalogBrowseRequiresFullDiscovery } from "../../../agents/models/model-catalog-browse.js";
import type { ModelCatalogEntry } from "../../../agents/models/model-catalog.types.js";
import type { OpenClawConfig } from "../../../config/types/openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
/**
 * chat.metadata subhandler.
 *
 * Answers chat.metadata and supplies the metadata block chat.startup embeds. The
 * model catalog load is optional and time-boxed: startup must answer even when
 * discovery is slow, so a missed deadline degrades to no catalog rather than
 * delaying the dashboard's first paint.
 */
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "../types.js";

export type ChatHistoryMethod = "chat.history" | "chat.startup";

export type ChatMetadataResult = {
  commands?: unknown[];
  models?: unknown[];
};

export async function handleChatMetadataRequest({
  params,
  respond,
  context,
}: GatewayRequestHandlerOptions): Promise<void> {
  if (!validateChatMetadataParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid chat.metadata params: ${formatValidationErrors(validateChatMetadataParams.errors)}`,
      ),
    );
    return;
  }
  const metadataParams = params;
  const cfg = context.getRuntimeConfig();
  const requestedAgentId =
    typeof metadataParams.agentId === "string" && metadataParams.agentId.trim()
      ? normalizeAgentId(metadataParams.agentId)
      : resolveDefaultAgentId(cfg);
  if (!listAgentIds(cfg).includes(requestedAgentId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${metadataParams.agentId}"`),
    );
    return;
  }
  try {
    respond(
      true,
      await buildChatMetadataResult({
        cfg,
        context,
        agentId: requestedAgentId,
      }),
    );
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
  }
}

export async function buildChatMetadataResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  agentId: string;
  preloadedModelCatalog?: ModelCatalogEntry[];
}): Promise<ChatMetadataResult> {
  const [{ buildModelsListResult }, { buildCommandsListResult }] = await Promise.all([
    import("../models-list-result.js"),
    import("../commands-list-result.js"),
  ]);
  const [models, commands] = await Promise.all([
    buildModelsListResult({
      context: params.context,
      agentId: params.agentId,
      params: { view: "configured" },
      preloadedCatalog: params.preloadedModelCatalog,
    }),
    Promise.resolve(
      buildCommandsListResult({
        cfg: params.cfg,
        agentId: params.agentId,
        includeArgs: true,
        scope: "text",
      }),
    ),
  ]);
  return { ...models, ...commands };
}

export async function buildChatStartupMetadataResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  agentId: string;
  modelCatalog: ModelCatalogEntry[] | undefined;
}): Promise<ChatMetadataResult | undefined> {
  if (!params.modelCatalog) {
    return undefined;
  }
  if (modelCatalogBrowseRequiresFullDiscovery({ cfg: params.cfg, view: "configured" })) {
    return undefined;
  }
  try {
    const { buildModelsListResult } = await import("../models-list-result.js");
    return await buildModelsListResult({
      context: params.context,
      agentId: params.agentId,
      params: { view: "configured" },
      preloadedCatalog: params.modelCatalog,
    });
  } catch (err) {
    params.context.logGateway.debug(
      `chat.startup continuing without metadata: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

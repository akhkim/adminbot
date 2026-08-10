/**
 * Lazy import boundary for effective-tool inventory helpers used by gateway RPCs.
 */
export {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
export {
  resolveEffectiveToolInventory,
  resolveEffectiveToolInventoryRuntimeModelContext,
} from "../../agents/tools/tools-effective-inventory.js";
export {
  buildBundleMcpToolsFromCatalog,
  peekSessionMcpRuntime,
  resolveSessionMcpConfigSummary,
} from "../../agents/mcp/agent-bundle-mcp-tools.js";
export { applyFinalEffectiveToolPolicy } from "../../agents/embedded-agent-runner/effective-tool-policy.js";
export { resolveReplyToMode } from "../../auto-reply/reply/reply-threading.js";
export { resolveRuntimeConfigCacheKey } from "../../config/config.js";
export {
  getActivePluginChannelRegistryVersion,
  getActivePluginRegistryVersion,
} from "../../plugins/runtime/runtime.js";
export { deliveryContextFromSession } from "../../shared/delivery-context.shared.js";
export { loadSessionEntry, resolveSessionModelRef } from "../sessions/session-utils.js";

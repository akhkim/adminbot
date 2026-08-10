/** Runtime facade for compact command dependencies. */
export {
  abortEmbeddedAgentRun,
  compactEmbeddedAgentSession,
  isEmbeddedAgentRunAbortableForCompaction,
  waitForEmbeddedAgentRunEnd,
} from "../../../agents/embedded/embedded-agent.js";
export {
  resolveFreshSessionTotalTokens,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../../config/sessions.js";
export { enqueueSystemEvent } from "../../../infra/system/system-events.js";
export { formatContextUsageShort, formatTokenCount } from "../../status.js";
export { incrementCompactionCount } from "../session/session-updates.js";

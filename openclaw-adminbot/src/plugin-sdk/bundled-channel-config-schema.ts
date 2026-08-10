/**
 * Bundled-channel config schemas for OpenClaw-maintained plugins.
 *
 * Third-party plugins should define plugin-local schemas and import primitives
 * from openclaw/plugin-sdk/channel-config-schema instead of depending on these
 * bundled channel schemas.
 */
export {
  AllowFromListSchema,
  buildChannelConfigSchema,
  buildCatchallMultiAccountChannelSchema,
  buildNestedDmConfigSchema,
} from "../channels/plugins/config-schema.js";
export {
  BlockStreamingCoalesceSchema,
  ContextVisibilityModeSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "../config/zod/core.js";
export { ToolPolicySchema } from "../config/zod/agent-runtime.js";
export {
  DiscordConfigSchema,
  IMessageConfigSchema,
  MSTeamsConfigSchema,
  SignalConfigSchema,
  SlackConfigSchema,
  TelegramConfigSchema,
} from "../config/zod/providers-core.js";
export { GoogleChatConfigSchema } from "../config/zod/providers-googlechat.js";
export { WhatsAppConfigSchema } from "../config/zod/providers-whatsapp.js";

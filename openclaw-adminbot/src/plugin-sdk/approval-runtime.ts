// Approval request/reply helpers for exec and plugin approval flows.

export {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalDecision,
  type ExecApprovalRequest,
  type ExecApprovalRequestPayload,
  type ExecApprovalResolved,
  type ExecHost,
} from "../infra/exec/exec-approvals.js";
export {
  buildExecApprovalPendingReplyPayload,
  getExecApprovalApproverDmNoticeText,
  getExecApprovalReplyMetadata,
  type ExecApprovalPendingReplyParams,
  type ExecApprovalReplyDecision,
  type ExecApprovalReplyMetadata,
} from "../infra/exec/exec-approval-reply.js";
export { resolveExecApprovalCommandDisplay } from "../infra/exec/exec-approval-command-display.js";
export { formatApprovalDisplayPath } from "../infra/approvals/approval-display-paths.js";
export {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
} from "./approval-native-helpers.js";
export {
  resolveApprovalRequestOriginTarget,
  resolveApprovalRequestSessionTarget,
  resolveExecApprovalSessionTarget,
  type ExecApprovalSessionTarget,
} from "../infra/exec/exec-approval-session-target.js";
export {
  doesApprovalRequestMatchChannelAccount,
  resolveApprovalRequestAccountId,
  resolveApprovalRequestChannelAccountId,
} from "../infra/approvals/approval-request-account-binding.js";
export {
  buildPluginApprovalExpiredMessage,
  buildPluginApprovalRequestMessage,
  buildPluginApprovalResolvedMessage,
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
  type PluginApprovalRequest,
  type PluginApprovalRequestPayload,
  type PluginApprovalResolved,
} from "../infra/plugin-approvals.js";
export { createResolvedApproverActionAuthAdapter } from "./approval-auth-helpers.js";
export {
  createChannelExecApprovalProfile,
  isChannelExecApprovalClientEnabledFromConfig,
  isChannelExecApprovalTargetRecipient,
} from "./approval-client-helpers.js";
export { createChannelNativeApprovalRuntime } from "../infra/approvals/approval-native-runtime.js";
export {
  createApproverRestrictedNativeApprovalAdapter,
  createApproverRestrictedNativeApprovalCapability,
  createChannelApprovalCapability,
  splitChannelApprovalCapability,
} from "./approval-delivery-helpers.js";
export { resolveApprovalApprovers } from "./approval-approvers.js";
export {
  matchesApprovalRequestFilters,
  matchesApprovalRequestSessionFilter,
  type ApprovalRequestFilterInput,
} from "../infra/approvals/approval-request-filters.js";
export {
  buildApprovalPendingReplyPayload,
  buildApprovalResolvedReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  buildPluginApprovalResolvedReplyPayload,
} from "./approval-renderers.js";

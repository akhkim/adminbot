/**
 * Runtime SDK subpath for native approval routing, target matching, and forwarding gates.
 */
export {
  createChannelApprovalForwardingEvaluator,
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createNativeApprovalChannelRouteGates,
  createNativeApprovalForwardingFallbackSuppressor,
  nativeApprovalTargetsMatch,
  resolveApprovalKind,
  shouldSuppressLocalNativeExecApprovalPrompt,
  type ChannelApprovalExplicitTargetEligibilityParams,
  type ChannelApprovalForwardingEligibilityParams,
  type ChannelApprovalPotentialRouteParams,
} from "./approval-native-helpers.js";
export {
  resolveApprovalRequestSessionConversation,
  resolveApprovalRequestOriginTarget,
  resolveApprovalRequestSessionTarget,
  resolveExecApprovalSessionTarget,
  type ApprovalRequestSessionConversation,
  type ExecApprovalSessionTarget,
} from "../infra/exec/exec-approval-session-target.js";
export { buildChannelApprovalNativeTargetKey } from "../infra/approvals/approval-native-target-key.js";
export {
  doesApprovalRequestMatchChannelAccount,
  resolveApprovalRequestAccountId,
  resolveApprovalRequestChannelAccountId,
} from "../infra/approvals/approval-request-account-binding.js";

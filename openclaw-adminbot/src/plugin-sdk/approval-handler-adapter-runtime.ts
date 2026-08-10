/**
 * Runtime SDK subpath for lazily adapting native channel approval handlers.
 */
export {
  CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
  createLazyChannelApprovalNativeRuntimeAdapter,
} from "../infra/approvals/approval-handler-adapter-runtime.js";

// AdminBot plugin public API surface.
export type {
  AdminBotActionProposal,
  AdminBotActionType,
  AdminBotAccessGrant,
  AdminBotApprovalRequirement,
  AdminBotAuditEvent,
  AdminBotEvidencePointer,
  AdminBotExecutionResult,
  AdminBotLabMember,
  AdminBotLabMemberInput,
  AdminBotPaperNudge,
  AdminBotPaperRecord,
  AdminBotPaperRecordInput,
  AdminBotPaperStep,
  AdminBotPrivacyTaskRequest,
  AdminBotPrivacyTaskResult,
  AdminBotOpenReviewCycleRecord,
  AdminBotOpenReviewMilestoneRecord,
  AdminBotOpenReviewRole,
  AdminBotPrivilegeLevel,
  AdminBotRiskTier,
  AdminBotSensitiveInfoRecord,
  AdminBotStoredProposal,
} from "./src/contracts/actions.js";
export { AdminBotService, payloadHash } from "./src/kernel/service.js";
export type { AdminBotActionExecutor } from "./src/kernel/service.js";
export { createGogAdminBotExecutor } from "./src/connectors/gog.js";
export { renderEmailBodyHtml } from "./src/connectors/email-html.js";
export { createAdminBotSocialExecutor } from "./src/connectors/social.js";
export { createLinkedInDraftRunner } from "./src/connectors/social-draft.js";
export { createAdminBotOverleafExecutor } from "./src/connectors/overleaf.js";
export { createAdminBotMessageExecutor } from "./src/connectors/message.js";
export { createAdminBotOpenReviewExecutor } from "./src/connectors/openreview.js";
export type { AdminBotOpenReviewExecutorOptions } from "./src/connectors/openreview.js";
export type {
  AdminBotOpenReviewWorkflow,
  AdminBotOpenReviewRunResult,
} from "./src/workflows/papers/openreview-workflow.js";
export { createCompositeAdminBotExecutor } from "./src/connectors/composite.js";
export { createAdminBotSqliteService, AdminBotSqliteStore } from "./src/persistence/sqlite.js";
export {
  createAdminBotMockService,
  type DevicePairingApprover,
  type DevicePairingApproval,
  type DeviceTokenIssuer,
  type DeviceTokenIssuance,
} from "./src/api/server.js";
export { createAdminBotSensitiveInfoDocument } from "./src/privacy/sensitive-info-doc.js";
export {
  createAdminBotPrivacyBroker,
  defaultAdminBotPrivacyBrokerConfig,
} from "./src/privacy/broker.js";
export type { AdminBotPrivacyBroker, AdminBotPrivacyBrokerConfig } from "./src/privacy/broker.js";
export { createAdminBotReimbursementWorkflow } from "./src/workflows/reimbursements/workflow.js";
export type {
  AdminBotReimbursementRequest,
  AdminBotReimbursementWorkflow,
  AdminBotReimbursementWorkflowOptions,
} from "./src/workflows/reimbursements/workflow.js";
export type { AdminBotSensitiveInfoDocument } from "./src/privacy/sensitive-info-doc.js";
export type {
  AdminBotPaperSocialPayload,
  AdminBotSocialPlatform,
} from "./src/workflows/papers/social-posting.js";
export type {
  AdminBotOverleafEditMode,
  AdminBotOverleafEditPayload,
} from "./src/workflows/papers/overleaf-editing.js";

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
  AdminBotPrivilegeLevel,
  AdminBotRiskTier,
  AdminBotSensitiveInfoRecord,
  AdminBotStoredProposal,
} from "./src/contracts.js";
export { AdminBotService, payloadHash } from "./src/service-core.js";
export type { AdminBotActionExecutor } from "./src/service-core.js";
export { createGogAdminBotExecutor } from "./src/gog-executor.js";
export { createAdminBotSocialExecutor } from "./src/social-executor.js";
export { createAdminBotOverleafExecutor } from "./src/overleaf-executor.js";
export { createAdminBotMessageExecutor } from "./src/message-executor.js";
export { createCompositeAdminBotExecutor } from "./src/composite-executor.js";
export { createAdminBotSqliteService, AdminBotSqliteStore } from "./src/service-sqlite.js";
export { createAdminBotMockService } from "./src/mock-service.js";
export { createAdminBotSensitiveInfoDocument } from "./src/sensitive-info-doc.js";
export {
  createAdminBotPrivacyBroker,
  defaultAdminBotPrivacyBrokerConfig,
} from "./src/privacy-broker.js";
export type { AdminBotPrivacyBroker, AdminBotPrivacyBrokerConfig } from "./src/privacy-broker.js";
export type { AdminBotSensitiveInfoDocument } from "./src/sensitive-info-doc.js";
export type { AdminBotPaperSocialPayload, AdminBotSocialPlatform } from "./src/social-posting.js";
export type {
  AdminBotOverleafEditMode,
  AdminBotOverleafEditPayload,
} from "./src/overleaf-editing.js";

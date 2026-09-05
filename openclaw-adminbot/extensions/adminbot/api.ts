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
  AdminBotMeetingAttendee,
  AdminBotMeetingRecord,
  AdminBotMeetingRecordInput,
  AdminBotMeetingSummary,
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
export { ensureAdminBotEmailReviewSchema } from "./src/persistence/email-review.js";
export type {
  AdminBotEmailReviewItem,
  AdminBotEmailReviewPaperflowCandidate,
  AdminBotEmailReviewResolution,
  AdminBotResolvedEmailReviewItem,
} from "./src/contracts/email-review.js";
// PaperFlow venue-cycle stages. Exported for scripts/adminbot-email-automation.ts, which reads the
// open stages to hand the classifier a closed set to choose from, and writes back the evidence
// when a bcc closes one.
export {
  adminBotPaperflowStages,
  adminBotPaperflowStageRegistry,
  adminBotPaperflowEvidenceMinConfidence,
  isAdminBotPaperflowStage,
} from "./src/contracts/paperflow-stages.js";
export type {
  AdminBotPaperflowEvidenceRecord,
  AdminBotPaperflowStage,
} from "./src/contracts/paperflow-stages.js";
export type { AdminBotPaperflowStageNudge } from "./src/kernel/service.js";
export {
  isFullMember,
  openPaperflowStage,
  paperflowRecipient,
  paperflowStageEmail,
} from "./src/workflows/papers/paperflow-stages.js";
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

// Meetings: the recorded-meeting pipeline the email and artifact crons drive. Everything exported
// here is pure -- Gmail and Drive are reached by the scripts, never from inside the extension.
export {
  artifactKind,
  matchArtifactToMeeting,
  noticeToMeeting,
  participantsUpdate,
  transcriptUpdate,
  type ArtifactKind,
  type DroppedFile,
  type IngestibleMessage,
} from "./src/workflows/meetings/ingest.js";
export {
  looksLikeZoomRecordingNotice,
  meetingRecordId,
  parseZoomRecordingNotice,
  type ZoomRecordingNotice,
} from "./src/workflows/meetings/zoom-email.js";
export { summarizeMeeting } from "./src/workflows/meetings/summarize.js";
export { parseVtt } from "./src/workflows/meetings/vtt.js";
export { parseParticipantCsv } from "./src/workflows/meetings/attendance.js";

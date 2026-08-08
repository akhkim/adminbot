import "../common/primitives.tsp";
import "../common/errors.tsp";
import "./policy.tsp";
import "./privacy.tsp";

using AdminBot.Contracts.Common;
using AdminBot.Contracts.Identity;
using AdminBot.Contracts.Policy;
using AdminBot.Contracts.Privacy;

namespace AdminBot.Contracts.Governance;

model ActionDefinitionRef {
  type: ActionType;
  version: SemVer;
}

model ActionDefinition extends ActionDefinitionRef {
  payloadSchema: SchemaRef;
  minimumRisk: RiskClass;
  operation: ConnectorOperationName;
  dataClass: DataClass;
  supportsDryRun: boolean;
}

model ActionEvidence {
  type: string;
  artifactId?: ArtifactId;
  digest?: Sha256;
  redactedSummary: string;
}

model ActionProposal {
  definition: ActionDefinitionRef;
  target?: ResourceRef;
  payload: unknown;
  summary: string;
  evidence: ActionEvidence[];
  requestedRisk?: RiskClass;
}

model ActionBase {
  id: ActionId;
  organizationId: OrganizationId;
  @minValue(1) revision: int32;
  definition: ActionDefinitionRef;
  target?: ResourceRef;
  canonicalPayload: unknown;
  payloadHash: Sha256;
  summary: string;
  evidence: ActionEvidence[];
  requestedBy: PrincipalId;
  requestedAt: utcDateTime;
  policy: PolicySnapshot;
}

model DraftAction extends ActionBase {
  state: "draft";
}
model ProposedAction extends ActionBase {
  state: "proposed";
}
model AwaitingApprovalAction extends ActionBase {
  state: "awaiting_approval";
  expiresAt?: utcDateTime;
}
model ApprovedAction extends ActionBase {
  state: "approved";
  approvedAt: utcDateTime;
  approvalIds: ApprovalId[];
}
model QueuedAction extends ActionBase {
  state: "queued";
  approvedAt: utcDateTime;
  approvalIds: ApprovalId[];
  executionId: ExecutionId;
}
model RunningAction extends ActionBase {
  state: "running";
  executionId: ExecutionId;
  startedAt: utcDateTime;
}
model SucceededAction extends ActionBase {
  state: "succeeded";
  executionId: ExecutionId;
  completedAt: utcDateTime;
}
model ResolvedSucceededAction extends ActionBase {
  state: "resolved_succeeded";
  executionId: ExecutionId;
  completedAt: utcDateTime;
}
model FailedAction extends ActionBase {
  state: "failed";
  executionId: ExecutionId;
  completedAt: utcDateTime;
  safeErrorCode: string;
}
model ResolvedFailedAction extends ActionBase {
  state: "resolved_failed";
  executionId: ExecutionId;
  completedAt: utcDateTime;
  safeErrorCode: string;
}
model UncertainAction extends ActionBase {
  state: "uncertain";
  executionId: ExecutionId;
  uncertainSince: utcDateTime;
  reconciliationHint: string;
}
model RejectedAction extends ActionBase {
  state: "rejected";
  closedAt: utcDateTime;
  safeReason: string;
}
model ExpiredAction extends ActionBase {
  state: "expired";
  closedAt: utcDateTime;
  safeReason: string;
}
model CancelledAction extends ActionBase {
  state: "cancelled";
  closedAt: utcDateTime;
  safeReason: string;
}

union Action {
  draft: DraftAction,
  proposed: ProposedAction,
  awaitingApproval: AwaitingApprovalAction,
  approved: ApprovedAction,
  queued: QueuedAction,
  running: RunningAction,
  succeeded: SucceededAction,
  resolvedSucceeded: ResolvedSucceededAction,
  failed: FailedAction,
  resolvedFailed: ResolvedFailedAction,
  uncertain: UncertainAction,
  rejected: RejectedAction,
  expired: ExpiredAction,
  cancelled: CancelledAction,
}

model Approval {
  id: ApprovalId;
  actionId: ActionId;
  @minValue(1) actionRevision: int32;
  payloadHash: Sha256;
  policyDecisionId: PolicyDecisionId;
  decision: "approve" | "reject";
  decidedBy: PersonId;
  roleBasis: string[];
  note?: string;
  decidedAt: utcDateTime;
}

model Execution {
  id: ExecutionId;
  actionId: ActionId;
  @minValue(1) actionRevision: int32;
  payloadHash: Sha256;
  requestedBy: PrincipalId;
  requestedAt: utcDateTime;
  state: "queued" | "running" | "succeeded" | "failed" | "uncertain";
  effectIds: EffectId[];
}

model EffectAttempt {
  @minValue(1) number: int32;
  startedAt: utcDateTime;
  completedAt?: utcDateTime;
  outcome?: "succeeded" | "failed" | "uncertain";
  safeResult?: Record<unknown>;
  safeErrorCode?: string;
}

model Effect {
  id: EffectId;
  executionId: ExecutionId;
  organizationId: OrganizationId;
  operation: ConnectorOperationName;
  input: unknown;
  inputHash: Sha256;
  idempotencyKey: IdempotencyKey;
  state: "queued" | "leased" | "succeeded" | "failed" | "uncertain";
  attempts: EffectAttempt[];
}

model ApprovalInput {
  actionId: ActionId;
  @minValue(1) actionRevision: int32;
  payloadHash: Sha256;
  decision: "approve" | "reject";
  note?: string;
}

model ApprovalProjection {
  id: ApprovalId;
  decision: "approve" | "reject";
  decidedBy: PersonId;
  decidedByName: string;
  roleBasis: RoleName[];
  note?: string;
  decidedAt: utcDateTime;
}

model GovernedActionProjection {
  id: ActionId;
  @minValue(1) revision: int32;
  actionType: ActionType;
  actionVersion: SemVer;
  state: "awaiting_approval" | "approved" | "rejected" | "cancelled" | "failed";
  summary: string;
  canonicalPayload: unknown;
  payloadHash: Sha256;
  requestedByPersonId: PersonId;
  requestedByName: string;
  requestedAt: utcDateTime;
  policyDecisionId: PolicyDecisionId;
  policyVersion: SemVer;
  risk: RiskClass;
  eligibleRoles: RoleName[];
  @minValue(1) approvalQuorum: int32;
  requesterMayApprove: boolean;
  distinctPeople: boolean;
  recentReauthenticationRequired: boolean;
  expiresAt: utcDateTime;
  approvals: ApprovalProjection[];
  safeFailureCode?: string;
}

model GovernanceWorkspaceProjection {
  viewerPersonId: PersonId;
  viewerRoles: RoleName[];
  actions: GovernedActionProjection[];
  reimbursementConnectorAvailable: boolean;
  asOf: utcDateTime;
}

model DecideGovernedActionCommand {
  @minValue(1) actionRevision: int32;
  payloadHash: Sha256;
  policyDecisionId: PolicyDecisionId;
  decision: "approve" | "reject";
  @maxLength(2000) note?: string;
}

model ExecuteGovernedActionCommand {
  @minValue(1) actionRevision: int32;
  payloadHash: Sha256;
  policyDecisionId: PolicyDecisionId;
}

interface GovernanceKernel {
  propose(actor: ActorContext, proposal: ActionProposal):
    | Action
    | ErrorResponse;
  decide(actor: ActorContext, input: ApprovalInput): Action | ErrorResponse;
  requestExecution(actor: ActorContext, actionId: ActionId):
    | Execution
    | ErrorResponse;
  cancel(actor: ActorContext, actionId: ActionId, reason: string):
    | Action
    | ErrorResponse;
}

import "../common/primitives.tsp";
import "./identity.tsp";
import "./privacy.tsp";

using AdminBot.Contracts.Common;
using AdminBot.Contracts.Identity;
using AdminBot.Contracts.Privacy;

namespace AdminBot.Contracts.Policy;

enum RiskClass {
  observe: "T0_observe",
  draft: "T1_draft",
  internal: "T2_internal",
  sensitive: "T3_sensitive",
  highConsequence: "T4_high_consequence",
}

model ApprovalRequirement {
  id: string;
  eligibleRoles: RoleName[];
  @minValue(1) quorum: int32;
  requesterMayApprove: boolean;
  distinctPeople: boolean;
  recentReauthenticationRequired: boolean;
}

model ExecutionConstraints {
  expiresAt?: utcDateTime;
  permittedOperation: ConnectorOperationName;
  @minValue(1) maximumAttempts: int32;
  requirePolicyRecheck: boolean;
}

model ActionCharacteristics {
  internal: boolean;
  external: boolean;
  public: boolean;
  financial: boolean;
  legal: boolean;
  aboutPerson: boolean;
  reversible: boolean;
}

model PolicyFacts {
  organizationId: OrganizationId;
  requesterId: PrincipalId;
  requesterPersonId?: PersonId;
  requesterRoles: RoleName[];
  actionType: ActionType;
  actionVersion: SemVer;
  target?: ResourceRef;
  minimumRisk: RiskClass;
  proposedRisk: RiskClass;
  dataClass: DataClass;
  operation: ConnectorOperationName;
  characteristics: ActionCharacteristics;
  thresholds: Record<unknown>;
  evidenceTypes: string[];
}

model PolicyDecisionBase {
  id: PolicyDecisionId;
  policyVersion: SemVer;
  ruleIds: string[];
  evaluatedAt: utcDateTime;
  factsDigest: Sha256;
}

model DenyDecision extends PolicyDecisionBase {
  outcome: "deny";
  reasonCode: string;
  safeMessage: string;
}

model DraftOnlyDecision extends PolicyDecisionBase {
  outcome: "allow_draft_only";
  reasonCode: string;
}

model ApprovalRequiredDecision extends PolicyDecisionBase {
  outcome: "require_approval";
  effectiveRisk: RiskClass;
  requirements: ApprovalRequirement[];
  constraints: ExecutionConstraints;
}

model AutoApproveDecision extends PolicyDecisionBase {
  outcome: "auto_approve";
  effectiveRisk: RiskClass;
  namedRule: string;
  constraints: ExecutionConstraints;
}

union PolicyDecision {
  deny: DenyDecision,
  draftOnly: DraftOnlyDecision,
  approvalRequired: ApprovalRequiredDecision,
  autoApprove: AutoApproveDecision,
}

model PolicySnapshot {
  decision: PolicyDecision;
  facts: PolicyFacts;
}

/** Administrator-managed, versioned policy data. The financial risk floor is not configurable. */
model AdministratorPolicySettings extends VersionedRecord {
  organizationId: OrganizationId;
  policyVersion: SemVer;
  reimbursementSubmissionEnabled: boolean;
  reimbursementApprovalRoles: RoleName[];
  @minValue(1) @maxValue(5) reimbursementApprovalQuorum: int32;
  reimbursementRequesterMayApprove: boolean;
  reimbursementDistinctApprovers: boolean;
  reimbursementRecentReauthenticationRequired: boolean;
  @minValue(1) @maxValue(168) reimbursementApprovalExpiryHours: int32;
  reimbursementDestinations: string[];
}

model ReplaceAdministratorPolicySettingsCommand {
  @minValue(1) expectedVersion: int32;
  reimbursementSubmissionEnabled: boolean;
  reimbursementApprovalRoles: RoleName[];
  @minValue(1) @maxValue(5) reimbursementApprovalQuorum: int32;
  reimbursementRequesterMayApprove: boolean;
  reimbursementDistinctApprovers: boolean;
  reimbursementRecentReauthenticationRequired: boolean;
  @minValue(1) @maxValue(168) reimbursementApprovalExpiryHours: int32;
  reimbursementDestinations: string[];
  @minLength(1) @maxLength(2000) reason: string;
}

interface PolicyEngine {
  evaluate(facts: PolicyFacts): PolicyDecision;
  recheck(snapshot: PolicySnapshot, currentFacts: PolicyFacts): PolicyDecision;
}

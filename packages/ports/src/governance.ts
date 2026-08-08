import type { AccessRoleName, JsonValue } from "./index.js";

export interface AdministratorPolicyRecord {
  readonly organizationId: string;
  readonly policyVersion: string;
  readonly reimbursementSubmissionEnabled: boolean;
  readonly reimbursementApprovalRoles: readonly AccessRoleName[];
  readonly reimbursementApprovalQuorum: number;
  readonly reimbursementRequesterMayApprove: boolean;
  readonly reimbursementDistinctApprovers: boolean;
  readonly reimbursementRecentReauthenticationRequired: boolean;
  readonly reimbursementApprovalExpiryHours: number;
  readonly reimbursementDestinations: readonly string[];
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly actionId: string;
  readonly actionRevision: number;
  readonly payloadHash: string;
  readonly policyDecisionId: string;
  readonly decision: "approve" | "reject";
  readonly decidedByPersonId: string;
  readonly decidedByName: string;
  readonly roleBasis: readonly AccessRoleName[];
  readonly note?: string;
  readonly decidedAt: Date;
}

export interface GovernedActionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly clientRequestId: string;
  readonly revision: number;
  readonly actionType: string;
  readonly actionVersion: string;
  readonly state: "awaiting_approval" | "approved" | "rejected" | "cancelled" | "failed";
  readonly summary: string;
  readonly canonicalPayload: JsonValue;
  readonly payloadHash: string;
  readonly requestedByAccountId: string;
  readonly requestedByPersonId: string;
  readonly requestedByName: string;
  readonly requestedAt: Date;
  readonly policyDecisionId: string;
  readonly policyVersion: string;
  readonly risk: "T3_sensitive" | "T4_high_consequence";
  readonly eligibleRoles: readonly AccessRoleName[];
  readonly approvalQuorum: number;
  readonly requesterMayApprove: boolean;
  readonly distinctPeople: boolean;
  readonly recentReauthenticationRequired: boolean;
  readonly expiresAt: Date;
  readonly approvals: readonly ApprovalRecord[];
  readonly safeFailureCode?: string;
  readonly updatedAt: Date;
}

export interface GovernanceRepository {
  getOrCreatePolicy(organizationId: string, now: Date): Promise<AdministratorPolicyRecord>;
  replacePolicy(input: Omit<AdministratorPolicyRecord, "policyVersion" | "version" | "createdAt" | "updatedAt"> & {
    readonly expectedVersion: number;
    readonly policyVersion: string;
    readonly now: Date;
  }): Promise<AdministratorPolicyRecord | "conflict">;
  listActions(organizationId: string): Promise<readonly GovernedActionRecord[]>;
  findAction(organizationId: string, actionId: string): Promise<GovernedActionRecord | undefined>;
  findActionByRequest(organizationId: string, clientRequestId: string): Promise<GovernedActionRecord | undefined>;
  createAction(input: Omit<GovernedActionRecord, "approvals" | "updatedAt"> & { readonly now: Date }): Promise<GovernedActionRecord | "request_conflict">;
  decide(input: {
    readonly organizationId: string;
    readonly actionId: string;
    readonly expectedRevision: number;
    readonly payloadHash: string;
    readonly policyDecisionId: string;
    readonly approval: Omit<ApprovalRecord, "decidedByName">;
    readonly nextState: "awaiting_approval" | "approved" | "rejected";
    readonly now: Date;
  }): Promise<GovernedActionRecord | "not_found" | "conflict" | "already_decided">;
  recordFailedExecution(input: {
    readonly organizationId: string;
    readonly actionId: string;
    readonly expectedRevision: number;
    readonly payloadHash: string;
    readonly policyDecisionId: string;
    readonly safeFailureCode: string;
    readonly now: Date;
  }): Promise<GovernedActionRecord | "not_found" | "conflict">;
}

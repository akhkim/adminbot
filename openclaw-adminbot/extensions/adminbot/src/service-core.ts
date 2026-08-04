import { createHash, randomUUID } from "node:crypto";
import type {
  AdminBotAccessGrant,
  AdminBotAccountRegistration,
  AdminBotActionProposal,
  AdminBotActionType,
  AdminBotApprovalRequest,
  AdminBotAuditEvent,
  AdminBotAuthSession,
  AdminBotRegistrationStatus,
  AdminBotExecutionRequest,
  AdminBotExecutionResult,
  AdminBotLabMember,
  AdminBotLabMemberInput,
  AdminBotMemberCredential,
  AdminBotMemberNudgeRequest,
  AdminBotMemberNudgeResult,
  AdminBotMemberNudgeSkip,
  AdminBotPaperNudge,
  AdminBotPaperRecord,
  AdminBotPaperRecordInput,
  AdminBotPaperStep,
  AdminBotPaperTimeline,
  AdminBotRemovePendingRequest,
  AdminBotRiskTier,
  AdminBotSettings,
  AdminBotSettingsInput,
  AdminBotStoredProposal,
  AdminBotPrivilegeLevel,
} from "./contracts.js";
import { adminBotMemberStatuses, adminBotTimeOffKinds } from "./contracts.js";
import { buildInitialOnboarding } from "./onboarding.js";

// Approver roles are privilege levels from the member roster, not a separate vocabulary: the
// service can only ever verify the level on the authenticated session, so anything else here
// would be unenforceable decoration.
type AdminBotApproverRole = Extract<AdminBotPrivilegeLevel, "admin" | "core_member">;

type AdminBotActionPolicy = {
  risk_tier: AdminBotRiskTier;
  requires_approval: boolean;
  approver_roles: AdminBotApproverRole[];
  min_approvals: number;
  auto_allowed?: boolean;
};

export type AdminBotServiceResponse<T> =
  | { ok: true; status: number; payload: T }
  | { ok: false; status: number; error: { message: string } };

export type AdminBotServiceStore = {
  saveProposal(proposal: AdminBotStoredProposal): void;
  getProposal(actionId: string): AdminBotStoredProposal | undefined;
  updateProposal(proposal: AdminBotStoredProposal): void;
  listPending(limit?: number): AdminBotStoredProposal[];
  saveExecutionResult(result: AdminBotExecutionResult): void;
  getExecutionResult(actionId: string): AdminBotExecutionResult | undefined;
  getExecutionResultByIdempotencyKey(idempotencyKey: string): AdminBotExecutionResult | undefined;
  saveLabMember(member: AdminBotLabMember): void;
  getLabMember(memberId: string): AdminBotLabMember | undefined;
  listLabMembers(): AdminBotLabMember[];
  savePaper(paper: AdminBotPaperRecord): void;
  getPaper(paperId: string): AdminBotPaperRecord | undefined;
  listPapers(): AdminBotPaperRecord[];
  deletePaper(paperId: string): boolean;
  getSettings(): AdminBotSettings | undefined;
  saveSettings(settings: AdminBotSettings): void;
  recordAudit(event: AdminBotAuditEvent): void;
  listAuditEvents(): AdminBotAuditEvent[];
  pruneAuditEventsBefore(cutoffIso: string): number;
  getCredentialByEmail(email: string): AdminBotMemberCredential | undefined;
  getCredentialByMemberId(memberId: string): AdminBotMemberCredential | undefined;
  saveCredential(credential: AdminBotMemberCredential): void;
  updateCredentialEmail(memberId: string, newEmail: string, updatedAt: string): void;
  saveAccountRegistration(registration: AdminBotAccountRegistration): void;
  getAccountRegistration(id: string): AdminBotAccountRegistration | undefined;
  listAccountRegistrations(status?: AdminBotRegistrationStatus): AdminBotAccountRegistration[];
  updateAccountRegistrationDecision(
    id: string,
    status: AdminBotRegistrationStatus,
    decidedBy: string,
    decidedAt: string,
  ): void;
  getPendingRegistrationByEmail(email: string): AdminBotAccountRegistration | undefined;
  getPendingRegistrationByMemberId(memberId: string): AdminBotAccountRegistration | undefined;
  saveSession(session: AdminBotAuthSession): void;
  getSession(tokenHash: string): AdminBotAuthSession | undefined;
  touchSession(tokenHash: string, lastSeenAt: string): void;
  revokeSession(tokenHash: string, revokedAt: string): void;
  pruneSessionsBefore(cutoffIso: string): number;
};

export type AdminBotActionExecutor = {
  execute(proposal: AdminBotStoredProposal): Promise<{ handled: boolean }>;
};

export type AdminBotServiceOptions = {
  auditRetentionDays?: number;
  executor?: AdminBotActionExecutor;
};

const DEFAULT_ACTION_POLICIES = {
  "candidate.accept_for_trial": approvalPolicy("T4", ["admin", "core_member"]),
  "candidate.accept_direct": approvalPolicy("T4", ["admin"]),
  "candidate.decline": approvalPolicy("T4", ["admin", "core_member"]),
  "slack.invite_guest": approvalPolicy("T3", ["admin", "core_member"]),
  "slack.invite_member": approvalPolicy("T3", ["admin", "core_member"]),
  "slack.send_message": approvalPolicy("T3", ["admin", "core_member"]),
  "vector.invite": approvalPolicy("T3", ["admin", "core_member"]),
  "calendar.create_tentative_hold": approvalPolicy("T2", ["admin"]),
  "calendar.send_invite": approvalPolicy("T3", ["admin", "core_member"]),
  "calendar.reschedule": approvalPolicy("T3", ["admin", "core_member"]),
  "calendar.cancel": approvalPolicy("T3", ["admin", "core_member"]),
  "email.draft": approvalPolicy("T1", ["admin"]),
  "email.send": approvalPolicy("T3", ["admin", "core_member"]),
  "recommendation_letter.draft": autoPolicy("T1"),
  "recommendation_letter.send": approvalPolicy("T4", ["admin"], 2),
  "reimbursement.prepare_packet": autoPolicy("T1"),
  "reimbursement.submit": approvalPolicy("T4", ["admin", "core_member"], 2),
  "social_media.draft": autoPolicy("T1"),
  "social_media.post_publicly": approvalPolicy("T4", ["admin", "core_member"], 2),
  "paper_publish.prepare": autoPolicy("T1"),
  "paper.overleaf_edit": approvalPolicy("T4", ["admin", "core_member"], 2),
  "paper_publish.submit": approvalPolicy("T4", ["admin"], 2),
  "paper_publish.nudge_author": approvalPolicy("T3", ["admin", "core_member"]),
  "paper_publish.escalate_to_pi": approvalPolicy("T3", ["admin", "core_member"]),
  "join_form.classify": autoPolicy("T0"),
  // Deliberately auto-approved, unlike every other outbound-message type (slack.send_message,
  // email.send, paper_publish.nudge_author are all T3/approval-required): creating this proposal
  // already requires a real admin/core_member session via POST /nudges/send (never reachable
  // through the shared service principal an agent chat authenticates as), so that admin gate is
  // the approval. resolvePolicy only honors auto_allowed below T2, hence T1 here.
  "member_nudge.send": autoPolicy("T1"),
} as const satisfies Record<AdminBotActionType, AdminBotActionPolicy>;

const PRIVILEGE_ACCESS: Record<AdminBotPrivilegeLevel, AdminBotAccessGrant[]> = {
  external_collaborator: [
    { service: "slack", access: "view", scope: "shared channels" },
    { service: "google_drive", access: "view", scope: "shared paper folders" },
    { service: "overleaf", access: "view", scope: "explicitly shared projects" },
  ],
  trial: [
    { service: "slack", access: "comment", scope: "trial channels" },
    { service: "google_drive", access: "comment", scope: "trial and shared paper folders" },
    { service: "overleaf", access: "edit", scope: "assigned paper projects" },
    { service: "calendar", access: "view", scope: "lab events" },
  ],
  member: [
    { service: "slack", access: "comment", scope: "member channels" },
    { service: "google_drive", access: "edit", scope: "member paper folders" },
    { service: "overleaf", access: "edit", scope: "paper projects" },
    { service: "calendar", access: "comment", scope: "lab events" },
    { service: "github", access: "edit", scope: "assigned repos" },
  ],
  core_member: [
    { service: "slack", access: "comment", scope: "core channels" },
    { service: "google_drive", access: "edit", scope: "core lab folders" },
    { service: "overleaf", access: "edit", scope: "lab projects" },
    { service: "calendar", access: "edit", scope: "lab events" },
    { service: "github", access: "edit", scope: "lab repos" },
    { service: "paper_pipeline", access: "edit", scope: "paper records" },
  ],
  admin: [
    { service: "slack", access: "admin", scope: "lab workspace" },
    { service: "google_drive", access: "admin", scope: "lab drive" },
    { service: "overleaf", access: "admin", scope: "lab projects" },
    { service: "calendar", access: "admin", scope: "lab calendars" },
    { service: "github", access: "admin", scope: "lab org" },
    { service: "paper_pipeline", access: "admin", scope: "all records" },
  ],
};

const DEFAULT_SETTINGS = {
  paper_escalation_business_days: 3,
} as const satisfies Omit<AdminBotSettings, "updated_at">;

// Least-privilege baseline for a member created without an explicit tier.
const DEFAULT_MEMBER_PRIVILEGE_LEVEL: AdminBotPrivilegeLevel = "external_collaborator";

export class AdminBotMemoryStore implements AdminBotServiceStore {
  private readonly proposals = new Map<string, AdminBotStoredProposal>();
  private readonly executionResults = new Map<string, AdminBotExecutionResult>();
  private readonly executionResultsByIdempotencyKey = new Map<string, AdminBotExecutionResult>();
  private readonly labMembers = new Map<string, AdminBotLabMember>();
  private readonly papers = new Map<string, AdminBotPaperRecord>();
  private settings: AdminBotSettings | undefined;
  private readonly auditEvents: AdminBotAuditEvent[] = [];
  private readonly credentialsByMemberId = new Map<string, AdminBotMemberCredential>();
  private readonly credentialsByEmail = new Map<string, AdminBotMemberCredential>();
  private readonly registrations = new Map<string, AdminBotAccountRegistration>();
  private readonly sessions = new Map<string, AdminBotAuthSession>();

  saveProposal(proposal: AdminBotStoredProposal): void {
    this.proposals.set(proposal.id, proposal);
  }

  getProposal(actionId: string): AdminBotStoredProposal | undefined {
    return this.proposals.get(actionId);
  }

  updateProposal(proposal: AdminBotStoredProposal): void {
    this.proposals.set(proposal.id, proposal);
  }

  listPending(limit?: number): AdminBotStoredProposal[] {
    const max = Number.isFinite(limit) && typeof limit === "number" ? limit : this.proposals.size;
    return [...this.proposals.values()].filter((entry) => entry.status === "pending").slice(0, max);
  }

  saveExecutionResult(result: AdminBotExecutionResult): void {
    this.executionResults.set(result.action_id, result);
    if (result.idempotency_key) {
      this.executionResultsByIdempotencyKey.set(result.idempotency_key, result);
    }
  }

  getExecutionResult(actionId: string): AdminBotExecutionResult | undefined {
    return this.executionResults.get(actionId);
  }

  getExecutionResultByIdempotencyKey(idempotencyKey: string): AdminBotExecutionResult | undefined {
    return this.executionResultsByIdempotencyKey.get(idempotencyKey);
  }

  saveLabMember(member: AdminBotLabMember): void {
    this.labMembers.set(member.id, member);
  }

  getLabMember(memberId: string): AdminBotLabMember | undefined {
    return this.labMembers.get(memberId);
  }

  listLabMembers(): AdminBotLabMember[] {
    return [...this.labMembers.values()].toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  savePaper(paper: AdminBotPaperRecord): void {
    this.papers.set(paper.id, paper);
  }

  getPaper(paperId: string): AdminBotPaperRecord | undefined {
    return this.papers.get(paperId);
  }

  listPapers(): AdminBotPaperRecord[] {
    return [...this.papers.values()].toSorted((left, right) =>
      left.title.localeCompare(right.title),
    );
  }

  deletePaper(paperId: string): boolean {
    return this.papers.delete(paperId);
  }

  getSettings(): AdminBotSettings | undefined {
    return this.settings;
  }

  saveSettings(settings: AdminBotSettings): void {
    this.settings = settings;
  }

  recordAudit(event: AdminBotAuditEvent): void {
    this.auditEvents.push(event);
  }

  listAuditEvents(): AdminBotAuditEvent[] {
    return [...this.auditEvents];
  }

  pruneAuditEventsBefore(cutoffIso: string): number {
    const before = this.auditEvents.length;
    const retained = this.auditEvents.filter((event) => event.timestamp >= cutoffIso);
    this.auditEvents.length = 0;
    this.auditEvents.push(...retained);
    return before - retained.length;
  }

  getCredentialByEmail(email: string): AdminBotMemberCredential | undefined {
    return this.credentialsByEmail.get(email.toLowerCase());
  }

  getCredentialByMemberId(memberId: string): AdminBotMemberCredential | undefined {
    return this.credentialsByMemberId.get(memberId);
  }

  saveCredential(credential: AdminBotMemberCredential): void {
    this.credentialsByMemberId.set(credential.member_id, credential);
    this.credentialsByEmail.set(credential.email.toLowerCase(), credential);
  }

  updateCredentialEmail(memberId: string, newEmail: string, updatedAt: string): void {
    const existing = this.credentialsByMemberId.get(memberId);
    if (!existing) {
      return;
    }
    // Drop the stale email->credential mapping so the old login email no longer resolves.
    this.credentialsByEmail.delete(existing.email.toLowerCase());
    const updated = { ...existing, email: newEmail.toLowerCase(), updated_at: updatedAt };
    this.credentialsByMemberId.set(memberId, updated);
    this.credentialsByEmail.set(updated.email, updated);
  }

  saveAccountRegistration(registration: AdminBotAccountRegistration): void {
    this.registrations.set(registration.id, registration);
  }

  getAccountRegistration(id: string): AdminBotAccountRegistration | undefined {
    return this.registrations.get(id);
  }

  listAccountRegistrations(status?: AdminBotRegistrationStatus): AdminBotAccountRegistration[] {
    const all = [...this.registrations.values()].toSorted((left, right) =>
      left.created_at.localeCompare(right.created_at),
    );
    return status ? all.filter((entry) => entry.status === status) : all;
  }

  updateAccountRegistrationDecision(
    id: string,
    status: AdminBotRegistrationStatus,
    decidedBy: string,
    decidedAt: string,
  ): void {
    const registration = this.registrations.get(id);
    if (registration) {
      registration.status = status;
      registration.decided_by = decidedBy;
      registration.decided_at = decidedAt;
    }
  }

  getPendingRegistrationByEmail(email: string): AdminBotAccountRegistration | undefined {
    const lowered = email.toLowerCase();
    return [...this.registrations.values()].find(
      (entry) => entry.status === "pending" && entry.email.toLowerCase() === lowered,
    );
  }

  getPendingRegistrationByMemberId(memberId: string): AdminBotAccountRegistration | undefined {
    return [...this.registrations.values()].find(
      (entry) => entry.status === "pending" && entry.member_id === memberId,
    );
  }

  saveSession(session: AdminBotAuthSession): void {
    this.sessions.set(session.token_hash, session);
  }

  getSession(tokenHash: string): AdminBotAuthSession | undefined {
    return this.sessions.get(tokenHash);
  }

  touchSession(tokenHash: string, lastSeenAt: string): void {
    const session = this.sessions.get(tokenHash);
    if (session) {
      session.last_seen_at = lastSeenAt;
    }
  }

  revokeSession(tokenHash: string, revokedAt: string): void {
    const session = this.sessions.get(tokenHash);
    if (session) {
      session.revoked_at = revokedAt;
    }
  }

  pruneSessionsBefore(cutoffIso: string): number {
    let removed = 0;
    for (const [tokenHash, session] of this.sessions) {
      if (session.expires_at < cutoffIso) {
        this.sessions.delete(tokenHash);
        removed += 1;
      }
    }
    return removed;
  }
}

export class AdminBotService {
  constructor(
    private readonly store: AdminBotServiceStore = new AdminBotMemoryStore(),
    private readonly options: AdminBotServiceOptions = {},
  ) {
    this.pruneRetainedAuditEvents();
  }

  // One connector call may mutate an external service. Share it across concurrent retries so
  // the durable idempotency record is written exactly once after the connector succeeds.
  private readonly executionsInFlight = new Map<
    string,
    Promise<AdminBotServiceResponse<AdminBotExecutionResult>>
  >();
  createProposal(
    proposal: AdminBotActionProposal,
  ): AdminBotServiceResponse<AdminBotStoredProposal> {
    if (!proposal.summary.trim()) {
      return serviceError(400, "summary is required");
    }
    const now = new Date().toISOString();
    const policy = resolvePolicy(proposal);
    const stored: AdminBotStoredProposal = {
      ...proposal,
      id: `act_${randomUUID()}`,
      risk_tier: policy.risk_tier,
      payload_hash: payloadHash({
        ...proposal,
        risk_tier: policy.risk_tier,
      }),
      status: policy.requires_approval ? "pending" : "approved",
      approval_requirement: {
        requires_approval: policy.requires_approval,
        approver_roles: policy.approver_roles,
        min_approvals: policy.min_approvals,
      },
      approvals: [],
      created_at: now,
      updated_at: now,
    };
    this.store.saveProposal(stored);
    this.recordAudit({
      type: "proposal.created",
      action_id: stored.id,
      details: {
        action_type: stored.type,
        risk_tier: stored.risk_tier,
        status: stored.status,
      },
    });
    if (!policy.requires_approval) {
      this.recordAudit({
        type: "proposal.auto_approved",
        action_id: stored.id,
        details: { risk_tier: stored.risk_tier },
      });
    }
    return { ok: true, status: 200, payload: stored };
  }

  listPending(limit?: number): AdminBotServiceResponse<{ proposals: AdminBotStoredProposal[] }> {
    return {
      ok: true,
      status: 200,
      payload: { proposals: this.store.listPending(limit) },
    };
  }

  removePending(
    actionId: string,
    request: AdminBotRemovePendingRequest,
  ): AdminBotServiceResponse<AdminBotStoredProposal> {
    const proposal = this.store.getProposal(actionId);
    if (!proposal) {
      return serviceError(404, "proposal not found");
    }
    if (proposal.status !== "pending" && proposal.status !== "approved") {
      return serviceError(409, "only pending or approved unexecuted proposals can be removed");
    }
    proposal.status = "rejected";
    proposal.updated_at = new Date().toISOString();
    this.store.updateProposal(proposal);
    this.recordAudit({
      type: "proposal.removed",
      action_id: proposal.id,
      actor: request.actor,
      details: {
        action_type: proposal.type,
        risk_tier: proposal.risk_tier,
        ...(request.note ? { note: request.note } : {}),
      },
    });
    return { ok: true, status: 200, payload: proposal };
  }

  approve(
    actionId: string,
    request: AdminBotApprovalRequest,
  ): AdminBotServiceResponse<AdminBotStoredProposal> {
    const proposal = this.store.getProposal(actionId);
    if (!proposal) {
      return serviceError(404, "proposal not found");
    }
    if (proposal.status === "executed") {
      return serviceError(409, "proposal is already executed");
    }
    if (proposal.status === "rejected") {
      return serviceError(409, "proposal is removed");
    }
    if (request.payload_hash !== proposal.payload_hash) {
      return serviceError(409, "payload hash mismatch");
    }
    const requirement = proposal.approval_requirement;
    if (
      requirement.requires_approval &&
      !requirement.approver_roles.includes(request.approver_role)
    ) {
      return serviceError(403, `approver role not allowed: ${request.approver_role}`);
    }
    if (!hasApproval(proposal.approvals, request)) {
      proposal.approvals.push(request);
    }
    // Quorum counts distinct approvers, not rows: a two-person rule that the same person can
    // satisfy twice by varying the role or note is not a two-person rule.
    if (distinctApprovers(proposal.approvals) >= requirement.min_approvals) {
      proposal.status = "approved";
    }
    proposal.updated_at = new Date().toISOString();
    this.store.updateProposal(proposal);
    this.recordAudit({
      type: "approval.recorded",
      action_id: proposal.id,
      actor: request.approver_id ?? request.approver_role,
      details: {
        approver_role: request.approver_role,
        approvals_recorded: proposal.approvals.length,
        min_approvals: requirement.min_approvals,
        status: proposal.status,
      },
    });
    return { ok: true, status: 200, payload: proposal };
  }

  async execute(
    actionId: string,
    request: AdminBotExecutionRequest,
  ): Promise<AdminBotServiceResponse<AdminBotExecutionResult>> {
    if (request.dry_run !== false) {
      return await this.executeOnce(actionId, request);
    }
    const existing = this.executionsInFlight.get(actionId);
    if (existing) {
      return await existing;
    }
    const pending = this.executeOnce(actionId, request).finally(() => {
      if (this.executionsInFlight.get(actionId) === pending) {
        this.executionsInFlight.delete(actionId);
      }
    });
    this.executionsInFlight.set(actionId, pending);
    return await pending;
  }

  private async executeOnce(
    actionId: string,
    request: AdminBotExecutionRequest,
  ): Promise<AdminBotServiceResponse<AdminBotExecutionResult>> {
    const proposal = this.store.getProposal(actionId);
    if (!proposal) {
      return serviceError(404, "proposal not found");
    }
    const idempotencyKey = request.idempotency_key;
    if (idempotencyKey) {
      const replay = this.store.getExecutionResultByIdempotencyKey(idempotencyKey);
      if (replay) {
        this.recordAudit({
          type: "execution.idempotent_replay",
          action_id: actionId,
          details: { idempotency_key: idempotencyKey },
        });
        return { ok: true, status: 200, payload: replay };
      }
    }
    const existingResult = this.store.getExecutionResult(actionId);
    if (existingResult) {
      return { ok: true, status: 200, payload: existingResult };
    }
    if (proposal.status !== "approved") {
      return serviceError(409, "proposal is not approved");
    }
    const requirement = proposal.approval_requirement;
    // Re-check quorum at execution rather than trusting the stored status: the requirement is
    // the contract, and a proposal marked approved under a weaker one must not execute.
    if (
      requirement.requires_approval &&
      distinctApprovers(proposal.approvals) < requirement.min_approvals
    ) {
      return serviceError(409, "proposal does not have the required approvals");
    }
    const now = new Date().toISOString();
    const dryRun = request.dry_run !== false;
    const baseResult = {
      action_id: actionId,
      dry_run: dryRun,
      executed_at: now,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    };
    if (dryRun) {
      const result: AdminBotExecutionResult = { ...baseResult, status: "simulated" };
      this.recordAudit({
        type: "execution.simulated",
        action_id: actionId,
        details: {
          action_type: proposal.type,
          risk_tier: proposal.risk_tier,
          idempotency_key: idempotencyKey,
        },
      });
      return { ok: true, status: 200, payload: result };
    }
    if (!this.options.executor) {
      return this.executionFailure(proposal, 501, "no live connector is configured");
    }
    let handled: boolean;
    try {
      ({ handled } = await this.options.executor.execute(proposal));
    } catch (error) {
      const message = error instanceof Error ? error.message : "connector execution failed";
      return this.executionFailure(proposal, 502, message);
    }
    if (!handled) {
      return this.executionFailure(
        proposal,
        501,
        `no live connector handles action type ${proposal.type}`,
      );
    }
    const result: AdminBotExecutionResult = {
      ...baseResult,
      status: "executed",
    };
    proposal.status = "executed";
    proposal.updated_at = now;
    this.store.updateProposal(proposal);
    this.store.saveExecutionResult(result);
    this.recordAudit({
      type: "execution.executed",
      action_id: actionId,
      details: {
        action_type: proposal.type,
        risk_tier: proposal.risk_tier,
        idempotency_key: idempotencyKey,
      },
    });
    return { ok: true, status: 200, payload: result };
  }

  private executionFailure(
    proposal: AdminBotStoredProposal,
    status: number,
    message: string,
  ): AdminBotServiceResponse<AdminBotExecutionResult> {
    this.recordAudit({
      type: "execution.failed",
      action_id: proposal.id,
      details: {
        action_type: proposal.type,
        risk_tier: proposal.risk_tier,
        error: message,
      },
    });
    return serviceError(status, message);
  }

  listAuditEvents(): AdminBotAuditEvent[] {
    return this.store.listAuditEvents();
  }

  getProposal(actionId: string): AdminBotStoredProposal | undefined {
    return this.store.getProposal(actionId);
  }

  getSettings(): AdminBotServiceResponse<AdminBotSettings> {
    return { ok: true, status: 200, payload: this.resolveSettings() };
  }

  updateSettings(settings: AdminBotSettingsInput): AdminBotServiceResponse<AdminBotSettings> {
    const validation = validateSettings(settings);
    if (validation) {
      return serviceError(400, validation);
    }
    const current = this.resolveSettings();
    const headProfessorMemberId = normalizeOptionalString(settings.head_professor_member_id);
    const applicantSheetId = normalizeOptionalString(settings.applicant_sheet_id);
    const applicantLastReviewedAt = normalizeOptionalString(settings.applicant_last_reviewed_at);
    const next: AdminBotSettings = {
      ...current,
      ...(typeof settings.paper_escalation_business_days === "number"
        ? { paper_escalation_business_days: settings.paper_escalation_business_days }
        : {}),
      ...(headProfessorMemberId ? { head_professor_member_id: headProfessorMemberId } : {}),
      ...(applicantSheetId ? { applicant_sheet_id: applicantSheetId } : {}),
      ...(applicantLastReviewedAt ? { applicant_last_reviewed_at: applicantLastReviewedAt } : {}),
      updated_at: new Date().toISOString(),
    };
    if (settings.head_professor_member_id !== undefined && !headProfessorMemberId) {
      delete next.head_professor_member_id;
    }
    if (settings.applicant_sheet_id !== undefined && !applicantSheetId) {
      delete next.applicant_sheet_id;
    }
    if (settings.applicant_last_reviewed_at !== undefined && !applicantLastReviewedAt) {
      delete next.applicant_last_reviewed_at;
    }
    this.store.saveSettings(next);
    this.recordAudit({
      type: "settings.updated",
      details: {
        paper_escalation_business_days: next.paper_escalation_business_days,
        has_head_professor_member_id: Boolean(next.head_professor_member_id),
        has_applicant_sheet_id: Boolean(next.applicant_sheet_id),
        ...(next.applicant_last_reviewed_at
          ? { applicant_last_reviewed_at: next.applicant_last_reviewed_at }
          : {}),
      },
    });
    return { ok: true, status: 200, payload: next };
  }

  upsertLabMember(member: AdminBotLabMemberInput): AdminBotServiceResponse<AdminBotLabMember> {
    const validation = validateLabMember(member);
    if (validation) {
      return serviceError(400, validation);
    }
    const existing = this.store.getLabMember(member.id);
    const privilegeLevel =
      member.privilege_level ?? existing?.privilege_level ?? DEFAULT_MEMBER_PRIVILEGE_LEVEL;
    const now = new Date().toISOString();
    const accessOverrides = member.access_overrides ?? existing?.access_overrides;
    const stored: AdminBotLabMember = {
      ...existing,
      ...member,
      privilege_level: privilegeLevel,
      ...(accessOverrides ? { access_overrides: accessOverrides } : {}),
      access: mergeAccessGrants(PRIVILEGE_ACCESS[privilegeLevel], accessOverrides),
      // Generated once at first creation and never regenerated on later edits — this is a
      // static onboarding checklist, not something profile updates should reset.
      onboarding: existing?.onboarding ?? buildInitialOnboarding(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      ...availabilityStamp(existing, member, now),
    };
    this.store.saveLabMember(stored);
    this.recordAudit({
      type: "lab_member.upserted",
      actor: member.id,
      details: {
        privilege_level: privilegeLevel,
      },
    });
    return { ok: true, status: 200, payload: stored };
  }

  listLabMembers(): AdminBotServiceResponse<{ members: AdminBotLabMember[] }> {
    return { ok: true, status: 200, payload: { members: this.store.listLabMembers() } };
  }

  // Self-service profile edit for a member principal. Only the whitelisted profile fields are
  // writable here; privilege_level/access_overrides/status/email are governance-owned and never
  // accepted from the member's own request so a member cannot escalate their own access.
  updateOwnProfile(
    memberId: string,
    input: Record<string, unknown>,
  ): AdminBotServiceResponse<AdminBotLabMember> {
    const existing = this.store.getLabMember(memberId);
    if (!existing) {
      return serviceError(404, "member not found");
    }
    for (const field of SELF_PROFILE_PRIVILEGED_FIELDS) {
      if (input[field] !== undefined) {
        return serviceError(400, `${field} cannot be changed from a self profile update`);
      }
    }
    const patch: Partial<AdminBotLabMemberInput> = {};
    for (const field of SELF_PROFILE_EDITABLE_FIELDS) {
      if (input[field] !== undefined) {
        (patch as Record<string, unknown>)[field] = input[field];
      }
    }
    const merged: AdminBotLabMemberInput = {
      ...existing,
      ...patch,
      id: memberId,
      privilege_level: existing.privilege_level,
    };
    return this.upsertLabMember(merged);
  }

  // Case-insensitive relevance match of a member's research focus against paper metadata.
  listPapersRelevantToMember(
    memberId: string,
  ): AdminBotServiceResponse<{ papers: AdminBotPaperRecord[] }> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    const needles = memberRelevanceNeedles(member);
    const papers = this.store.listPapers().filter((paper) => paperMatchesNeedles(paper, needles));
    return { ok: true, status: 200, payload: { papers: papers.map(withPaperTimeline) } };
  }

  upsertPaper(paper: AdminBotPaperRecordInput): AdminBotServiceResponse<AdminBotPaperRecord> {
    const validation = validatePaper(paper);
    if (validation) {
      return serviceError(400, validation);
    }
    const existing = this.store.getPaper(paper.id);
    const settings = this.resolveSettings();
    const now = new Date().toISOString();
    const headProfessorMemberId =
      paper.reminder?.head_professor_member_id ??
      existing?.reminder?.head_professor_member_id ??
      settings.head_professor_member_id;
    const stored: AdminBotPaperRecord = {
      ...existing,
      ...paper,
      artifacts: {
        ...existing?.artifacts,
        ...paper.artifacts,
      },
      checks: {
        ...existing?.checks,
        ...paper.checks,
      },
      reminder: {
        ...existing?.reminder,
        ...paper.reminder,
        escalation_after_business_days:
          paper.reminder?.escalation_after_business_days ??
          existing?.reminder?.escalation_after_business_days ??
          settings.paper_escalation_business_days,
        ...(headProfessorMemberId ? { head_professor_member_id: headProfessorMemberId } : {}),
      },
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.store.savePaper(stored);
    this.recordAudit({
      type: "paper.upserted",
      actor: paper.id,
      details: {
        current_step: paper.current_step,
        author_count: paper.authors.length,
      },
    });
    return { ok: true, status: 200, payload: stored };
  }

  listPapers(): AdminBotServiceResponse<{ papers: AdminBotPaperRecord[] }> {
    return {
      ok: true,
      status: 200,
      payload: { papers: this.store.listPapers().map(withPaperTimeline) },
    };
  }

  deletePaper(paperId: string): AdminBotServiceResponse<{ deleted: true; paper_id: string }> {
    const paper = this.store.getPaper(paperId);
    if (!paper) {
      return serviceError(404, "paper not found: " + paperId);
    }
    this.store.deletePaper(paperId);
    this.recordAudit({
      type: "paper.deleted",
      actor: paperId,
      details: { title: paper.title },
    });
    return { ok: true, status: 200, payload: { deleted: true, paper_id: paperId } };
  }

  listPaperNudges(nowIso = new Date().toISOString()): AdminBotServiceResponse<{
    nudges: AdminBotPaperNudge[];
  }> {
    return {
      ok: true,
      status: 200,
      payload: {
        nudges: this.store
          .listPapers()
          .map(withPaperTimeline)
          .flatMap((paper) => duePaperNudges(paper, nowIso)),
      },
    };
  }

  // Composes and immediately sends one `member_nudge.send` proposal per recipient (paper-flow
  // reminder or general announcement). Unlike every other outbound-message action type, this one
  // is auto-approved (see DEFAULT_ACTION_POLICIES) and executed inline instead of waiting in
  // Pending actions for a separate pi/lab_manager approval: creating it already requires a real
  // admin/core_member session (POST /nudges/send is gated the same way as /settings), so that
  // admin gate itself *is* the approval — a second review step would just be an invisible,
  // undiscoverable extra click for a tool only admins can reach in the first place. A member
  // missing the contact field the chosen channel needs, or whose send fails, is skipped with a
  // reason rather than failing the whole batch.
  async sendMemberNudge(
    request: AdminBotMemberNudgeRequest,
    actor: string,
  ): Promise<AdminBotServiceResponse<AdminBotMemberNudgeResult>> {
    const message = request.message.trim();
    if (!message) {
      return serviceError(400, "message is required");
    }
    if (request.recipient_member_ids.length === 0) {
      return serviceError(400, "recipient_member_ids must not be empty");
    }
    if (request.channel === "email" && !request.subject?.trim()) {
      return serviceError(400, "subject is required for the email channel");
    }
    const created: AdminBotStoredProposal[] = [];
    const skipped: AdminBotMemberNudgeSkip[] = [];
    for (const memberId of request.recipient_member_ids) {
      const member = this.store.getLabMember(memberId);
      if (!member) {
        skipped.push({ member_id: memberId, reason: "member not found" });
        continue;
      }
      const proposalInput =
        request.channel === "slack"
          ? member.slack_user_id
            ? {
                summary: `Nudge ${member.name} via Slack: ${truncateForSummary(message)}`,
                target: {
                  service: "slack",
                  channel: "slack",
                  target: member.slack_user_id,
                  recipientMemberId: member.id,
                },
                proposed_payload: {
                  channel: "slack",
                  tool: "message",
                  action: "send",
                  target: member.slack_user_id,
                  message,
                },
                undo_plan: "Send a Slack follow-up correcting or retracting the message.",
              }
            : undefined
          : member.email
            ? {
                summary: `Nudge ${member.name} via email: ${truncateForSummary(message)}`,
                target: {
                  service: "email",
                  channel: "email",
                  target: member.email,
                  recipientMemberId: member.id,
                },
                proposed_payload: {
                  channel: "email",
                  to: member.email,
                  subject: request.subject?.trim(),
                  body: message,
                },
                undo_plan: "Send an email follow-up correcting or retracting the message.",
              }
            : undefined;
      if (!proposalInput) {
        skipped.push({
          member_id: memberId,
          reason:
            request.channel === "slack" ? "member has no slack_user_id" : "member has no email",
        });
        continue;
      }
      const created_ = this.createProposal({ type: "member_nudge.send", ...proposalInput });
      if (!created_.ok) {
        skipped.push({ member_id: memberId, reason: created_.error.message });
        continue;
      }
      const executed = await this.execute(created_.payload.id, { dry_run: false });
      if (!executed.ok) {
        skipped.push({ member_id: memberId, reason: executed.error.message });
        continue;
      }
      created.push(this.store.getProposal(created_.payload.id) ?? created_.payload);
    }
    this.recordAudit({
      type: "member_nudge.sent",
      actor,
      details: {
        channel: request.channel,
        requested: request.recipient_member_ids.length,
        created: created.length,
        skipped: skipped.length,
      },
    });
    return { ok: true, status: 200, payload: { created, skipped } };
  }

  pruneAuditEventsBefore(cutoffIso: string): number {
    return this.store.pruneAuditEventsBefore(cutoffIso);
  }

  private recordAudit(event: Omit<AdminBotAuditEvent, "id" | "timestamp">): void {
    this.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      ...event,
    });
    this.pruneRetainedAuditEvents();
  }

  private pruneRetainedAuditEvents(): void {
    const retentionDays = this.options.auditRetentionDays;
    if (typeof retentionDays !== "number" || retentionDays < 0) {
      return;
    }
    this.store.pruneAuditEventsBefore(retentionCutoffIso(retentionDays));
  }

  private resolveSettings(): AdminBotSettings {
    return (
      this.store.getSettings() ?? {
        ...DEFAULT_SETTINGS,
        updated_at: new Date(0).toISOString(),
      }
    );
  }
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

const SELF_PROFILE_EDITABLE_FIELDS = [
  "name",
  "slack_user_id",
  "role",
  "research_branch",
  "research_topics",
  "projects",
  "hours_per_week",
  "capacity_percent",
  "location",
  "affiliation",
  "timezone",
  "personal_website",
  "notes",
  "availability",
  "time_off",
  "availability_doc_url",
] as const;

const SELF_PROFILE_PRIVILEGED_FIELDS = [
  "privilege_level",
  "access_overrides",
  "status",
  "email",
] as const;

function memberRelevanceNeedles(member: AdminBotLabMember): string[] {
  const values = [
    member.name,
    member.research_branch,
    ...(member.research_topics ?? []),
    ...(member.projects ?? []),
  ];
  return values
    .flatMap((value) => (typeof value === "string" ? [value.trim().toLowerCase()] : []))
    .filter((value) => value.length > 0);
}

function paperMatchesNeedles(paper: AdminBotPaperRecord, needles: string[]): boolean {
  if (needles.length === 0) {
    return false;
  }
  const haystack = [paper.title, paper.artifacts?.topic, ...paper.authors]
    .flatMap((value) => (typeof value === "string" ? [value.toLowerCase()] : []))
    .join("\n");
  return needles.some((needle) => haystack.includes(needle));
}

function truncateForSummary(message: string, maxLength = 80): string {
  return message.length > maxLength ? `${message.slice(0, maxLength - 1)}…` : message;
}

function resolvePolicy(proposal: AdminBotActionProposal): AdminBotActionPolicy {
  const defaults = DEFAULT_ACTION_POLICIES[proposal.type];
  const riskTier = proposal.risk_tier ?? defaults.risk_tier;
  const fallback = defaultPolicyForRiskTier(riskTier);
  return {
    ...fallback,
    ...defaults,
    risk_tier: riskTier,
    requires_approval:
      defaults.requires_approval || fallback.requires_approval || defaults.auto_allowed !== true,
  };
}

function defaultPolicyForRiskTier(riskTier: AdminBotRiskTier): AdminBotActionPolicy {
  if (riskTier === "T0" || riskTier === "T1") {
    return autoPolicy(riskTier);
  }
  if (riskTier === "T2" || riskTier === "T3") {
    return approvalPolicy(riskTier, ["admin", "core_member"]);
  }
  return approvalPolicy(riskTier, ["admin"], 2);
}

function autoPolicy(riskTier: AdminBotRiskTier): AdminBotActionPolicy {
  return {
    risk_tier: riskTier,
    requires_approval: false,
    approver_roles: [],
    min_approvals: 0,
    auto_allowed: true,
  };
}

function approvalPolicy(
  riskTier: AdminBotRiskTier,
  approverRoles: AdminBotApproverRole[],
  minApprovals = 1,
): AdminBotActionPolicy {
  return {
    risk_tier: riskTier,
    requires_approval: true,
    approver_roles: approverRoles,
    min_approvals: minApprovals,
  };
}

function serviceError<T>(status: number, message: string): AdminBotServiceResponse<T> {
  return { ok: false, status, error: { message } };
}

function validateLabMember(member: AdminBotLabMemberInput): string | undefined {
  if (!member.id.trim()) {
    return "member id is required";
  }
  if (!member.name.trim()) {
    return "member name is required";
  }
  if (member.status && !adminBotMemberStatuses.includes(member.status)) {
    return "member status is invalid";
  }
  if (
    member.hours_per_week !== undefined &&
    (!Number.isFinite(member.hours_per_week) ||
      member.hours_per_week < 0 ||
      member.hours_per_week > 168)
  ) {
    return "member hours per week must be between 0 and 168";
  }
  if (
    member.capacity_percent !== undefined &&
    (!Number.isFinite(member.capacity_percent) ||
      member.capacity_percent < 0 ||
      member.capacity_percent > 100)
  ) {
    return "member capacity percent must be between 0 and 100";
  }
  if (member.availability_doc_url !== undefined) {
    const docError = validateAvailabilityDocUrl(member.availability_doc_url);
    if (docError) {
      return docError;
    }
  }
  return validateAvailability(member);
}

// The availability importer fetches this URL server-side with the AdminBot's own Google
// credentials, so it is restricted to the hosts the Drive tooling can actually read. Without the
// allowlist a self-editable profile field would become a fetch primitive aimed at any host.
const AVAILABILITY_DOC_HOSTS = new Set(["docs.google.com", "drive.google.com"]);

function validateAvailabilityDocUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return "availability doc url must be a string";
  }
  const trimmed = value.trim();
  // Empty clears the link; the importer simply skips members without one.
  if (!trimmed) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "availability doc url must be a valid URL";
  }
  if (parsed.protocol !== "https:") {
    return "availability doc url must use https";
  }
  if (!AVAILABILITY_DOC_HOSTS.has(parsed.hostname)) {
    return "availability doc url must be a Google Docs or Drive link";
  }
  return undefined;
}

// Members are stored as one JSON blob, so an unbounded array here would bloat every
// read of the roster. The cap is deliberately far above any real schedule.
const MAX_AVAILABILITY_ROWS = 200;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

// A calendar date with no time part; parsed as UTC so a server timezone can never
// shift a row onto the neighbouring day.
function parseIsoDate(value: string): number {
  if (!ISO_DATE.test(value)) {
    return Number.NaN;
  }
  return Date.parse(`${value}T00:00:00Z`);
}

function validateDateRange(row: { start: string; end: string }, label: string): string | undefined {
  const start = parseIsoDate(row.start);
  const end = parseIsoDate(row.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return `${label} dates must be YYYY-MM-DD`;
  }
  if (start > end) {
    return `${label} start date must not be after its end date`;
  }
  return undefined;
}

function validateAvailability(member: AdminBotLabMemberInput): string | undefined {
  if (member.availability !== undefined) {
    if (!Array.isArray(member.availability)) {
      return "member availability must be a list";
    }
    if (member.availability.length > MAX_AVAILABILITY_ROWS) {
      return `member availability cannot exceed ${MAX_AVAILABILITY_ROWS} rows`;
    }
    for (const row of member.availability) {
      const rangeError = validateDateRange(row, "availability");
      if (rangeError) {
        return rangeError;
      }
      if (
        !Number.isFinite(row.hours_per_week) ||
        row.hours_per_week < 0 ||
        row.hours_per_week > 168
      ) {
        return "availability hours per week must be between 0 and 168";
      }
    }
  }
  if (member.time_off !== undefined) {
    if (!Array.isArray(member.time_off)) {
      return "member time off must be a list";
    }
    if (member.time_off.length > MAX_AVAILABILITY_ROWS) {
      return `member time off cannot exceed ${MAX_AVAILABILITY_ROWS} rows`;
    }
    for (const row of member.time_off) {
      const rangeError = validateDateRange(row, "time off");
      if (rangeError) {
        return rangeError;
      }
      if (!adminBotTimeOffKinds.includes(row.kind)) {
        return "time off kind is invalid";
      }
      if (row.availability !== "none" && row.availability !== "partial") {
        return "time off availability must be none or partial";
      }
    }
  }
  return undefined;
}

// availability_updated_at is server-owned: it moves only when the schedule content
// actually changes, so an unrelated profile save (name, website) does not reset the
// staleness badge and mask a member who has stopped updating their hours.
function availabilityStamp(
  existing: AdminBotLabMember | undefined,
  member: AdminBotLabMemberInput,
  now: string,
): { availability_updated_at?: string } {
  const previous = existing?.availability_updated_at;
  const touched =
    (member.availability !== undefined &&
      stableJson(member.availability) !== stableJson(existing?.availability)) ||
    (member.time_off !== undefined &&
      stableJson(member.time_off) !== stableJson(existing?.time_off));
  if (touched) {
    return { availability_updated_at: now };
  }
  return previous ? { availability_updated_at: previous } : {};
}

function validateSettings(settings: AdminBotSettingsInput): string | undefined {
  if (
    settings.paper_escalation_business_days !== undefined &&
    (!Number.isInteger(settings.paper_escalation_business_days) ||
      settings.paper_escalation_business_days < 1)
  ) {
    return "paper escalation business days must be a positive integer";
  }
  const applicantLastReviewedAt = normalizeOptionalString(settings.applicant_last_reviewed_at);
  if (applicantLastReviewedAt && Number.isNaN(Date.parse(applicantLastReviewedAt))) {
    return "applicant last reviewed at must be an ISO timestamp";
  }
  return undefined;
}

function validatePaper(paper: AdminBotPaperRecordInput): string | undefined {
  if (!paper.id.trim()) {
    return "paper id is required";
  }
  if (!paper.title.trim()) {
    return "paper title is required";
  }
  if (paper.authors.length === 0) {
    return "paper authors are required";
  }
  return undefined;
}

function mergeAccessGrants(
  defaults: AdminBotAccessGrant[],
  overrides: AdminBotAccessGrant[] | undefined,
): AdminBotAccessGrant[] {
  const byService = new Map(defaults.map((grant) => [grant.service, grant]));
  for (const override of overrides ?? []) {
    byService.set(override.service, override);
  }
  return [...byService.values()].toSorted((left, right) =>
    left.service.localeCompare(right.service),
  );
}

type PaperTimelinePlanItem = {
  step: AdminBotPaperStep;
  label: string;
  dependency_group: AdminBotPaperTimeline["items"][number]["dependency_group"];
  duration_business_days: number;
  color: string;
};

const PAPER_TIMELINE_PLAN = [
  {
    step: "brainstorming_docs",
    label: "Brainstorming docs",
    dependency_group: "ideation",
    duration_business_days: 2,
    color: "#64748b",
  },
  {
    step: "overleaf_writing",
    label: "Overleaf writing",
    dependency_group: "writing",
    duration_business_days: 5,
    color: "#2563eb",
  },
  {
    step: "submission",
    label: "Submission",
    dependency_group: "submission",
    duration_business_days: 1,
    color: "#7c3aed",
  },
  {
    step: "google_drive_pdf",
    label: "Drive PDF",
    dependency_group: "release",
    duration_business_days: 1,
    color: "#0891b2",
  },
  {
    step: "arxiv_polish",
    label: "arXiv polish",
    dependency_group: "release",
    duration_business_days: 2,
    color: "#0f766e",
  },
  {
    step: "social_posts",
    label: "Announcements",
    dependency_group: "outreach",
    duration_business_days: 1,
    color: "#db2777",
  },
  {
    step: "slide_making",
    label: "Slides",
    dependency_group: "materials",
    duration_business_days: 2,
    color: "#d97706",
  },
  {
    step: "poster_making",
    label: "Poster",
    dependency_group: "materials",
    duration_business_days: 2,
    color: "#16a34a",
  },
] as const satisfies readonly PaperTimelinePlanItem[];

function withPaperTimeline(paper: AdminBotPaperRecord): AdminBotPaperRecord {
  return {
    ...paper,
    timeline: buildPaperTimeline(paper),
  };
}

function buildPaperTimeline(
  paper: Pick<AdminBotPaperRecord, "current_step" | "reminder">,
): AdminBotPaperTimeline {
  const currentStepIndex = Math.max(
    0,
    PAPER_TIMELINE_PLAN.findIndex((item) => item.step === paper.current_step),
  );
  const totalEstimatedBusinessDays = PAPER_TIMELINE_PLAN.reduce(
    (total, item) => total + item.duration_business_days,
    0,
  );
  let cursor = 0;
  const complete = paper.reminder?.status === "complete";
  const blocked = paper.reminder?.status === "blocked";
  const items = PAPER_TIMELINE_PLAN.map((item, index) => {
    const start = cursor;
    cursor += item.duration_business_days;
    return {
      step: item.step,
      label: item.label,
      dependency_group: item.dependency_group,
      depends_on: index > 0 ? [PAPER_TIMELINE_PLAN[index - 1].step] : [],
      status: timelineStatus(index, currentStepIndex, complete, blocked),
      offset_start_business_day: start,
      offset_end_business_day: cursor,
      duration_business_days: item.duration_business_days,
      color: item.color,
    };
  });
  const completedBusinessDays = complete
    ? totalEstimatedBusinessDays
    : (items[currentStepIndex]?.offset_start_business_day ?? 0);
  return {
    progress_percent: Math.round((completedBusinessDays / totalEstimatedBusinessDays) * 100),
    current_step_index: currentStepIndex,
    total_estimated_business_days: totalEstimatedBusinessDays,
    items,
  };
}

function timelineStatus(
  index: number,
  currentStepIndex: number,
  complete: boolean,
  blocked: boolean,
): AdminBotPaperTimeline["items"][number]["status"] {
  if (complete || index < currentStepIndex) {
    return "complete";
  }
  if (index === currentStepIndex) {
    return blocked ? "blocked" : "current";
  }
  return "upcoming";
}
function duePaperNudges(paper: AdminBotPaperRecord, nowIso: string): AdminBotPaperNudge[] {
  const reminder = paper.reminder;
  if (reminder?.status !== "waiting_on_authors") {
    return [];
  }
  if (reminder.last_author_dm_at && replyAfterLastDm(reminder)) {
    return [];
  }
  const escalationBusinessDays = reminder.escalation_after_business_days ?? 3;
  const elapsedBusinessDays = reminder.last_author_dm_at
    ? countBusinessDays(reminder.last_author_dm_at, nowIso)
    : 0;
  if (
    reminder.last_author_dm_at &&
    elapsedBusinessDays >= escalationBusinessDays &&
    reminder.head_professor_member_id
  ) {
    return [
      {
        type: "head_professor_escalation",
        paper_id: paper.id,
        title: paper.title,
        step: paper.current_step,
        recipients: [reminder.head_professor_member_id],
        business_days_since_author_dm: elapsedBusinessDays,
        message:
          `Authors have not replied for ${elapsedBusinessDays} business days. ` +
          `Ask the head professor to remind them about ${paper.current_step}.`,
        ...(paper.timeline ? { timeline: paper.timeline } : {}),
      },
    ];
  }
  if (reminder.next_nudge_at && reminder.next_nudge_at > nowIso) {
    return [];
  }
  return [
    {
      type: "author_nudge",
      paper_id: paper.id,
      title: paper.title,
      step: paper.current_step,
      recipients: paper.authors,
      message: `Remind authors to complete ${paper.current_step} for "${paper.title}".`,
      ...(paper.timeline ? { timeline: paper.timeline } : {}),
    },
  ];
}

function replyAfterLastDm(reminder: { last_author_dm_at?: string; last_author_reply_at?: string }) {
  return Boolean(
    reminder.last_author_dm_at &&
    reminder.last_author_reply_at &&
    reminder.last_author_reply_at > reminder.last_author_dm_at,
  );
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function countBusinessDays(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    return 0;
  }
  let days = 0;
  const oneDayMs = 24 * 60 * 60 * 1000;
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (let dayMs = startDay + oneDayMs; dayMs <= endDay; dayMs += oneDayMs) {
    const cursor = new Date(dayMs);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      days += 1;
    }
  }
  return days;
}

function hasApproval(
  approvals: AdminBotApprovalRequest[],
  request: AdminBotApprovalRequest,
): boolean {
  return approvals.some(
    (approval) =>
      approval.payload_hash === request.payload_hash &&
      approverIdentity(approval) === approverIdentity(request),
  );
}

// The approver's member id is the identity; the role is only the permission that let them in.
// Falling back to the role keeps pre-identity audit rows countable as one approver.
function approverIdentity(approval: AdminBotApprovalRequest): string {
  return approval.approver_id?.trim() || `role:${approval.approver_role}`;
}

function distinctApprovers(approvals: AdminBotApprovalRequest[]): number {
  return new Set(approvals.map(approverIdentity)).size;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortForStableJson(entryValue)]),
  );
}

function retentionCutoffIso(retentionDays: number): string {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

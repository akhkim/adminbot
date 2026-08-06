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
  AdminBotMemberOnboardingStep,
  AdminBotMemberNudgeChannel,
  AdminBotMemberNudgeRequest,
  AdminBotMemberNudgeResult,
  AdminBotMemberNudgeSkip,
  AdminBotMemberOnboarding,
  AdminBotOpenReviewCycleRecord,
  AdminBotOpenReviewMilestoneRecord,
  AdminBotPaperArtifactLinks,
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
import { adminBotMemberRoles, adminBotMemberStatuses, adminBotTimeOffKinds } from "./contracts.js";
import { buildMemberMap, type AdminBotMemberMap } from "./member-map.js";
import {
  acknowledgeOnboardingStep,
  buildInitialOnboarding,
  findOnboardingStep,
  isOnboardingStepComplete,
  onboardingStepIds,
  resolveMemberOnboarding,
  setOnboardingStepStatus,
} from "./onboarding.js";
import { memberRelevanceNeedles, textMatchesNeedles } from "./openreview-matching.js";

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
  saveOpenReviewCycle(cycle: AdminBotOpenReviewCycleRecord): void;
  listOpenReviewCycles(): AdminBotOpenReviewCycleRecord[];
  // Returns false when the milestone had already fired, which is how the caller
  // knows not to send.
  recordOpenReviewMilestone(milestone: AdminBotOpenReviewMilestoneRecord): boolean;
  listOpenReviewMilestones(venueId?: string): AdminBotOpenReviewMilestoneRecord[];
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
  // Routine cycle reminders auto-send for the same reason member_nudge.send does: the
  // run route is admin-gated, the recipients are the venue's own committee groups, and
  // the cadence fires each milestone at most once.
  "openreview.nudge": autoPolicy("T1"),
  // Overdue warnings carry real social weight and go out under Zhijing's name, so they
  // wait in Pending actions for a human however the run was triggered. Approver roles are
  // privilege levels because that is the only thing the session can be checked against.
  "openreview.warning": approvalPolicy("T2", ["admin", "core_member"]),
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
  private readonly openReviewCycles = new Map<string, AdminBotOpenReviewCycleRecord>();
  private readonly openReviewMilestones = new Map<string, AdminBotOpenReviewMilestoneRecord>();
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

  saveOpenReviewCycle(cycle: AdminBotOpenReviewCycleRecord): void {
    this.openReviewCycles.set(`${cycle.venue_id} ${cycle.role}`, cycle);
  }

  listOpenReviewCycles(): AdminBotOpenReviewCycleRecord[] {
    return [...this.openReviewCycles.values()].toSorted(
      (left, right) => left.deadline_ms - right.deadline_ms,
    );
  }

  recordOpenReviewMilestone(milestone: AdminBotOpenReviewMilestoneRecord): boolean {
    const key = `${milestone.venue_id} ${milestone.role} ${milestone.milestone_key}`;
    if (this.openReviewMilestones.has(key)) {
      return false;
    }
    this.openReviewMilestones.set(key, milestone);
    return true;
  }

  listOpenReviewMilestones(venueId?: string): AdminBotOpenReviewMilestoneRecord[] {
    return [...this.openReviewMilestones.values()]
      .filter((milestone) => !venueId || milestone.venue_id === venueId)
      .toSorted((left, right) => left.fired_at.localeCompare(right.fired_at));
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

  // Anonymous reimbursement use has no member to attribute it to, so the audit trail is the only
  // record that a submission happened and the only way to spot abuse of the open endpoint.
  recordAnonymousReimbursementUse(details: {
    route: string;
    ip?: string;
    outcome: "accepted" | "rate_limited";
  }): void {
    this.recordAudit({ type: "reimbursement.anonymous_use", actor: "anonymous", details });
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
      // Step text always comes from the current definitions; only the member's acknowledgements
      // survive, so editing a profile never resets their progress and never leaves them reading a
      // checklist frozen at the shape it had when they signed up.
      onboarding: resolveMemberOnboarding(existing?.onboarding),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      ...availabilityStamp(existing, member, now),
    };
    // An empty list clears the schedule outright; keeping [] would render as an empty
    // chart rather than "nothing recorded".
    if (stored.availability && stored.availability.length === 0) {
      delete stored.availability;
    }
    if (stored.time_off && stored.time_off.length === 0) {
      delete stored.time_off;
    }
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
    // Drop the parsed availability when rebuilding the input: leaving it undefined makes
    // upsertLabMember keep what is stored unless this request actually sent new text.
    const { availability: _stored, ...existingFields } = existing;
    const merged: AdminBotLabMemberInput = {
      ...existingFields,
      ...patch,
      id: memberId,
      privilege_level: existing.privilege_level,
    };
    return this.upsertLabMember(merged);
  }

  // Creates or edits a paper on behalf of the member themselves, so authors can file and maintain
  // their own submissions without an admin. Ownership is checked against the *stored* record, so a
  // member cannot take over someone else's paper by adding their own name to the authors they send.
  upsertOwnPaper(
    memberId: string,
    input: Record<string, unknown>,
  ): AdminBotServiceResponse<AdminBotPaperRecord> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    for (const field of OWN_PAPER_PRIVILEGED_FIELDS) {
      if (input[field] !== undefined) {
        return serviceError(400, `${field} cannot be set from a member paper update`);
      }
    }
    const paperId = typeof input.id === "string" ? input.id.trim() : "";
    if (!paperId) {
      return serviceError(400, "paper id is required");
    }
    const existing = this.store.getPaper(paperId);
    if (existing && !this.memberOwnsPaper(member, existing)) {
      return serviceError(403, "members can only edit papers they authored");
    }
    const patch: Record<string, unknown> = {};
    for (const field of OWN_PAPER_EDITABLE_FIELDS) {
      if (input[field] !== undefined) {
        patch[field] = input[field];
      }
    }
    return this.upsertPaper({
      ...existing,
      ...(patch as Partial<AdminBotPaperRecordInput>),
      id: paperId,
      title: typeof patch.title === "string" ? patch.title : (existing?.title ?? ""),
      authors: Array.isArray(patch.authors)
        ? (patch.authors as string[])
        : (existing?.authors ?? []),
      current_step: (patch.current_step ??
        existing?.current_step ??
        "brainstorming_docs") as AdminBotPaperStep,
      artifacts: { ...existing?.artifacts, ...(patch.artifacts as AdminBotPaperArtifactLinks) },
      // Stamped once, on the create. Re-stamping on every edit would let the last member to touch
      // a shared paper claim it.
      submitted_by_member_id: existing?.submitted_by_member_id ?? memberId,
    });
  }

  // A member owns a paper they filed, or one that names them in `authors`. Author entries are free
  // text, so an id or email matches outright while a bare name only counts when it is unambiguous
  // on the roster — otherwise two people sharing a name would inherit each other's edit rights.
  private memberOwnsPaper(member: AdminBotLabMember, paper: AdminBotPaperRecord): boolean {
    if (paper.submitted_by_member_id === member.id) {
      return true;
    }
    const authors = paper.authors.map((author) => author.trim().toLocaleLowerCase());
    const unique = [member.id, member.email]
      .flatMap((value) => (value ? [value.toLocaleLowerCase()] : []))
      .some((value) => authors.includes(value));
    if (unique) {
      return true;
    }
    const name = member.name.trim().toLocaleLowerCase();
    if (!name || !authors.includes(name)) {
      return false;
    }
    return (
      this.store.listLabMembers().filter((entry) => entry.name.trim().toLocaleLowerCase() === name)
        .length === 1
    );
  }

  // Records a member reading one onboarding step. Members act only on their own checklist, so the
  // caller's id is the record we touch -- there is no step-id path that reaches anyone else's.
  acknowledgeOwnOnboardingStep(
    memberId: string,
    stepId: string,
  ): AdminBotServiceResponse<{ onboarding: AdminBotMemberOnboarding }> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    if (!member.onboarding) {
      return serviceError(404, "member has no onboarding checklist");
    }
    const onboarding = acknowledgeOnboardingStep(
      member.onboarding,
      stepId,
      new Date().toISOString(),
    );
    if (!onboarding) {
      return serviceError(404, "onboarding step not found");
    }
    this.store.saveLabMember({ ...member, onboarding, updated_at: new Date().toISOString() });
    return { ok: true, status: 200, payload: { onboarding } };
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

  // Where members are, Slack first and the roster location only where Slack has nothing.
  // Reads stamped state: refreshing from Slack is refreshMemberMap's job, not a page
  // load's, so opening the map never waits on 144 API calls.
  memberMap(): AdminBotServiceResponse<AdminBotMemberMap> {
    const members = this.store.listLabMembers();
    const slackLocations = new Map<string, string>();
    for (const member of members) {
      if (member.slack_user_id && member.slack_location) {
        slackLocations.set(member.slack_user_id, member.slack_location);
      }
    }
    return { ok: true, status: 200, payload: buildMemberMap(members, slackLocations) };
  }

  // Re-reads every member's Slack profile and stamps what it finds. A member Slack has
  // nothing for is cleared rather than left stale: keeping an old value would quietly
  // outrank their roster location forever.
  async refreshMemberMap(
    fetchSlackLocations: (slackUserIds: string[]) => Promise<ReadonlyMap<string, string>>,
    actor: string,
  ): Promise<AdminBotServiceResponse<{ checked: number; updated: number }>> {
    const members = this.store.listLabMembers().filter((member) => member.slack_user_id);
    const ids = members.flatMap((member) => (member.slack_user_id ? [member.slack_user_id] : []));
    const located = await fetchSlackLocations(ids);
    const now = new Date().toISOString();
    let updated = 0;
    for (const member of members) {
      const next = located.get(member.slack_user_id ?? "")?.trim() || undefined;
      if ((member.slack_location ?? undefined) === next) {
        continue;
      }
      const stored: AdminBotLabMember = { ...member, updated_at: now };
      if (next) {
        stored.slack_location = next;
        stored.slack_location_updated_at = now;
      } else {
        delete stored.slack_location;
        delete stored.slack_location_updated_at;
      }
      this.store.saveLabMember(stored);
      updated += 1;
    }
    this.recordAudit({
      type: "member_map.refreshed",
      actor,
      details: { checked: ids.length, updated },
    });
    return { ok: true, status: 200, payload: { checked: ids.length, updated } };
  }

  // Reviewing cycles and their firing history, for the admin panel. Reads persisted
  // state only — refreshing it from OpenReview is the workflow's job, not a page load's.
  listOpenReviewStatus(): AdminBotServiceResponse<{
    cycles: AdminBotOpenReviewCycleRecord[];
    milestones: AdminBotOpenReviewMilestoneRecord[];
  }> {
    return {
      ok: true,
      status: 200,
      payload: {
        cycles: this.store.listOpenReviewCycles(),
        milestones: this.store.listOpenReviewMilestones(),
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
  /**
   * Record that a member has (or has not) finished one onboarding step.
   *
   * Onboarding used to be write-once: it was generated at first upsert and no
   * code path ever changed it, so every checklist stayed permanently unfinished
   * and could not drive anything.
   */
  setOnboardingStep(
    memberId: string,
    stepId: string,
    complete: boolean,
    actor: string,
  ): AdminBotServiceResponse<AdminBotLabMember> {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return serviceError(404, "member not found");
    }
    const onboarding = member.onboarding ?? buildInitialOnboarding();
    if (!findOnboardingStep(onboarding, stepId)) {
      return serviceError(400, `unknown onboarding step: ${stepId}`);
    }
    const stored: AdminBotLabMember = {
      ...member,
      onboarding: setOnboardingStepStatus(onboarding, stepId, complete),
      updated_at: new Date().toISOString(),
    };
    this.store.saveLabMember(stored);
    this.recordAudit({
      type: "onboarding.step_updated",
      actor,
      details: { member_id: memberId, step_id: stepId, complete },
    });
    return { ok: true, status: 200, payload: stored };
  }

  /**
   * Members who have not finished `stepId` yet.
   *
   * Alumni and external collaborators are excluded: the checklist is for people
   * currently working in the lab, and nudging someone who has left is worse than
   * not nudging at all.
   */
  listOnboardingStepPending(
    stepId: string,
  ): AdminBotServiceResponse<{ step_id: string; message: string; members: AdminBotLabMember[] }> {
    if (!onboardingStepIds().includes(stepId)) {
      return serviceError(400, `unknown onboarding step: ${stepId}`);
    }
    const members = this.store
      .listLabMembers()
      .filter((member) => member.status !== "alumni" && member.status !== "external")
      .filter((member) => !isOnboardingStepComplete(member.onboarding, stepId));
    // The composed nudge text rides along so the reaction-confirm poller
    // (scripts/adminbot_onboarding_confirm.py) re-nudges with exactly the words the service
    // itself would send, instead of keeping a second copy of the message.
    const message = buildOnboardingNudgeMessage(
      findOnboardingStep(buildInitialOnboarding(), stepId),
    );
    return { ok: true, status: 200, payload: { step_id: stepId, message, members } };
  }

  /**
   * Nudge everyone who has not finished `stepId`.
   *
   * Membership is roster state, not something observed: LinkedIn exposes no API
   * that can tell you whether a given person follows or works at an
   * organization, so "has this member joined" can only ever be what they or an
   * admin recorded via setOnboardingStep.
   *
   * Delivery reuses sendMemberNudge, so each recipient still becomes its own
   * approve-then-execute proposal with its own audit row.
   */
  async nudgeOnboardingStep(
    request: { step_id: string; channel: AdminBotMemberNudgeChannel; message?: string },
    actor: string,
  ): Promise<AdminBotServiceResponse<AdminBotMemberNudgeResult>> {
    const pending = this.listOnboardingStepPending(request.step_id);
    if (!pending.ok) {
      return pending;
    }
    const recipients = pending.payload.members.map((member) => member.id);
    if (recipients.length === 0) {
      return { ok: true, status: 200, payload: { created: [], skipped: [] } };
    }
    const step = findOnboardingStep(buildInitialOnboarding(), request.step_id);
    return await this.sendMemberNudge(
      {
        channel: request.channel,
        recipient_member_ids: recipients,
        message: request.message?.trim() || pending.payload.message,
        ...(request.channel === "email"
          ? { subject: `Reminder: ${step?.label ?? "an onboarding step"}` }
          : {}),
      },
      actor,
    );
  }

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
  "availability",
  "location",
  "affiliation",
  "timezone",
  "personal_website",
  "openreview_id",
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

// What an author may maintain on their own paper: the record's own description, plus every artifact
// link (conference and topic live there too).
const OWN_PAPER_EDITABLE_FIELDS = [
  "title",
  "authors",
  "current_step",
  "artifacts",
  "notes",
] as const;

// Governance the paper flow drives: mentor assignment, the reviewer checklist, and reminder cadence
// (escalation windows and the head professor who gets escalated to). Ownership is server-stamped.
const OWN_PAPER_PRIVILEGED_FIELDS = [
  "mentor_member_id",
  "checks",
  "reminder",
  "submitted_by_member_id",
] as const;

function paperMatchesNeedles(paper: AdminBotPaperRecord, needles: string[]): boolean {
  const haystack = [paper.title, paper.artifacts?.topic, ...paper.authors]
    .flatMap((value) => (typeof value === "string" ? [value] : []))
    .join("\n");
  return textMatchesNeedles(haystack, needles);
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

// Built from the checklist definition rather than hardcoded per step, so the nudge text and the
// welcome screen can never describe the task differently.
function buildOnboardingNudgeMessage(step: AdminBotMemberOnboardingStep | undefined): string {
  if (!step) {
    return "You have an outstanding lab onboarding step — see the AdminBot welcome screen.";
  }
  const lines = [
    `Hey! 👋 If you haven't gotten to *${step.label}* yet, please take a minute to do it — it's part of your lab onboarding.`,
  ];
  if (step.detail) {
    lines.push(step.detail);
  }
  for (const bullet of step.bullets ?? []) {
    lines.push(`• ${bullet.text}`);
    for (const point of bullet.points ?? []) {
      lines.push(`    ◦ ${point}`);
    }
  }
  for (const link of step.links ?? []) {
    lines.push(`${link.label}: ${link.url}`);
  }
  // The reaction option only works because scripts/adminbot_onboarding_confirm.py polls the DM
  // for it; keep this wording and that script's CONFIRM_REACTIONS in sync.
  lines.push(
    "Already done? React to this message with ✅ and I'll record it. If not, do it now and react when you're done — thanks! 🙌",
  );
  lines.push("(You can also mark it complete on your AdminBot welcome screen.)");
  return lines.join("\n");
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
  // Role is a closed vocabulary, not free text: the roster is filtered and reported on by role,
  // and "PhD student" / "PhD Student" / "PhD" as three distinct values made those counts lie.
  // Empty stays legal — a role nobody has recorded yet is different from a wrong one.
  if (member.role !== undefined && member.role !== "") {
    if (!adminBotMemberRoles.includes(member.role as (typeof adminBotMemberRoles)[number])) {
      return `member role must be one of: ${adminBotMemberRoles.join(", ")}`;
    }
  }
  if (
    member.hours_per_week !== undefined &&
    (!Number.isFinite(member.hours_per_week) ||
      member.hours_per_week < 0 ||
      member.hours_per_week > 168)
  ) {
    return "member hours per week must be between 0 and 168";
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
  /**
   * Steps that must finish first. The paper flow is not a single line: slides branch off the
   * submission and run alongside the arXiv/announcement chain, so this is a graph rather than the
   * plan's array order. Scheduling walks these edges; the array order only defines step identity.
   */
  depends_on: readonly AdminBotPaperStep[];
};

const PAPER_TIMELINE_PLAN = [
  {
    step: "brainstorming_docs",
    label: "Brainstorming docs",
    dependency_group: "ideation",
    duration_business_days: 2,
    color: "#64748b",
    depends_on: [],
  },
  {
    step: "overleaf_writing",
    label: "Overleaf writing",
    dependency_group: "writing",
    duration_business_days: 5,
    color: "#2563eb",
    depends_on: ["brainstorming_docs"],
  },
  {
    step: "submission",
    label: "Submission",
    dependency_group: "submission",
    duration_business_days: 1,
    color: "#7c3aed",
    depends_on: ["overleaf_writing"],
  },
  {
    step: "google_drive_pdf",
    label: "Drive PDF",
    dependency_group: "release",
    duration_business_days: 1,
    color: "#0891b2",
    depends_on: ["submission"],
  },
  {
    step: "arxiv_polish",
    label: "arXiv polish",
    dependency_group: "release",
    duration_business_days: 2,
    color: "#0f766e",
    depends_on: ["google_drive_pdf"],
  },
  {
    step: "social_posts",
    label: "Announcements",
    dependency_group: "outreach",
    duration_business_days: 1,
    color: "#db2777",
    depends_on: ["arxiv_polish"],
  },
  {
    step: "slide_making",
    label: "Slides",
    dependency_group: "materials",
    duration_business_days: 2,
    color: "#d97706",
    depends_on: ["submission"],
  },
  {
    step: "poster_making",
    label: "Poster",
    dependency_group: "materials",
    duration_business_days: 2,
    color: "#16a34a",
    depends_on: ["slide_making"],
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
  // Work in the plan, used for progress. This is the sum of every step's estimate and is not the
  // same as the schedule length below: parallel branches take calendar time off the schedule
  // without taking work off the paper.
  const totalWorkBusinessDays = PAPER_TIMELINE_PLAN.reduce(
    (total, item) => total + item.duration_business_days,
    0,
  );
  const complete = paper.reminder?.status === "complete";
  const blocked = paper.reminder?.status === "blocked";

  // Earliest start per step = latest finish among its dependencies (longest path). The plan is
  // ordered so every step appears after its dependencies, so one forward pass is enough.
  const finishByStep = new Map<AdminBotPaperStep, number>();
  const items = PAPER_TIMELINE_PLAN.map((item, index) => {
    const start = item.depends_on.reduce(
      (latest, dependency) => Math.max(latest, finishByStep.get(dependency) ?? 0),
      0,
    );
    const end = start + item.duration_business_days;
    finishByStep.set(item.step, end);
    return {
      step: item.step,
      label: item.label,
      dependency_group: item.dependency_group,
      depends_on: [...item.depends_on],
      status: timelineStatus(index, currentStepIndex, complete, blocked),
      offset_start_business_day: start,
      offset_end_business_day: end,
      duration_business_days: item.duration_business_days,
      color: item.color,
    };
  });
  // Schedule length is the critical path, which is what a Gantt axis spans.
  const scheduleBusinessDays = Math.max(1, ...items.map((item) => item.offset_end_business_day));
  const completedWorkBusinessDays = complete
    ? totalWorkBusinessDays
    : PAPER_TIMELINE_PLAN.slice(0, currentStepIndex).reduce(
        (total, item) => total + item.duration_business_days,
        0,
      );
  return {
    progress_percent: Math.round((completedWorkBusinessDays / totalWorkBusinessDays) * 100),
    current_step_index: currentStepIndex,
    total_estimated_business_days: scheduleBusinessDays,
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

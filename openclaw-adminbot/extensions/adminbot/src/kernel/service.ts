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
} from "../contracts/actions.js";
import {
  adminBotExternalCollaboratorSubgroups,
  adminBotMandatoryProfileFieldLabels,
  adminBotMandatoryProfileFields,
  adminBotMemberRoles,
  adminBotMemberStatuses,
  ADMINBOT_MAX_LABEL_LENGTH,
  adminBotTimeOffKinds,
} from "../contracts/actions.js";
import { buildMemberMap, type AdminBotMemberMap } from "../workflows/members/member-map.js";
import {
  acknowledgeOnboardingStep,
  buildInitialOnboarding,
  findOnboardingStep,
  isOnboardingStepComplete,
  onboardingStepIds,
  resolveMemberOnboarding,
  setOnboardingStepStatus,
} from "../workflows/onboarding/onboarding.js";
import {
  memberRelevanceNeedles,
  textMatchesNeedles,
} from "../workflows/papers/openreview-matching.js";

// Approver roles are privilege levels from the member roster, not a separate vocabulary: the
// service can only ever verify the level on the authenticated session, so anything else here
// would be unenforceable decoration.
type AdminBotApproverRole = Extract<AdminBotPrivilegeLevel, "admin">;

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
  saveSlackChannelNamingRecord(record: AdminBotSlackChannelNamingRecord): void;
  getSlackChannelNamingRecord(channelId: string): AdminBotSlackChannelNamingRecord | undefined;
  listSlackChannelNamingRecords(): AdminBotSlackChannelNamingRecord[];
  deleteSlackChannelNamingRecord(channelId: string): boolean;
};

export type AdminBotSlackChannelNamingEvent = {
  event_type: "channel_created" | "channel_rename";
  channel_id: string;
  channel_name: string;
  owner_user_id?: string;
  purpose?: string;
  topic?: string;
};

export type AdminBotSlackChannelNamingRecord = {
  channel_id: string;
  latest_channel_name: string;
  owner_user_id?: string;
  expected_prefix: SlackChannelNamingPrefix;
  suggested_name: string;
  first_seen_at: string;
  last_seen_at: string;
  reminder_sent_at?: string;
  reminder_action_id?: string;
};

// The in-memory store implementation lives in store/memory.ts alongside store/sqlite.ts;
// re-exported so callers that import it from the service keep working.
import { AdminBotMemoryStore } from "../persistence/memory.js";

// Re-exported so callers that imported the store from the service keep working.
export { AdminBotMemoryStore };

export type AdminBotActionExecutor = {
  execute(proposal: AdminBotStoredProposal): Promise<{ handled: boolean }>;
};

export type AdminBotServiceOptions = {
  auditRetentionDays?: number;
  executor?: AdminBotActionExecutor;
};

const DEFAULT_ACTION_POLICIES = {
  "candidate.accept_for_trial": approvalPolicy("T4", ["admin"]),
  "candidate.accept_direct": approvalPolicy("T4", ["admin"]),
  "candidate.decline": approvalPolicy("T4", ["admin"]),
  "slack.invite_guest": approvalPolicy("T3", ["admin"]),
  "slack.invite_member": approvalPolicy("T3", ["admin"]),
  "slack.send_message": approvalPolicy("T3", ["admin"]),
  "slack.channel_naming_notify_owner": autoPolicy("T1"),
  "slack.rename_channel": autoPolicy("T1"),
  "vector.invite": approvalPolicy("T3", ["admin"]),
  "calendar.create_tentative_hold": approvalPolicy("T2", ["admin"]),
  "calendar.send_invite": approvalPolicy("T3", ["admin"]),
  "calendar.reschedule": approvalPolicy("T3", ["admin"]),
  "calendar.cancel": approvalPolicy("T3", ["admin"]),
  "email.draft": approvalPolicy("T1", ["admin"]),
  "email.send": approvalPolicy("T3", ["admin"]),
  "recommendation_letter.draft": autoPolicy("T1"),
  "recommendation_letter.send": approvalPolicy("T4", ["admin"], 2),
  "reimbursement.prepare_packet": autoPolicy("T1"),
  "reimbursement.submit": approvalPolicy("T4", ["admin"], 2),
  "social_media.draft": autoPolicy("T1"),
  "social_media.post_publicly": approvalPolicy("T4", ["admin"], 2),
  "paper_publish.prepare": autoPolicy("T1"),
  "paper.overleaf_edit": approvalPolicy("T4", ["admin"], 2),
  "paper_publish.submit": approvalPolicy("T4", ["admin"], 2),
  "paper_publish.nudge_author": approvalPolicy("T3", ["admin"]),
  "paper_publish.escalate_to_pi": approvalPolicy("T3", ["admin"]),
  "join_form.classify": autoPolicy("T0"),
  // Deliberately auto-approved, unlike every other outbound-message type (slack.send_message,
  // email.send, paper_publish.nudge_author are all T3/approval-required): creating this proposal
  // already requires a real admin session via POST /nudges/send (never reachable
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
  "openreview.warning": approvalPolicy("T2", ["admin"]),
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
  // Full members hold what `core_member` used to: the tier was retired and its lab-wide scopes
  // folded down here, so a member edits at lab scope rather than assigned-only scope. Governance
  // did not come with it — approvals and operator scopes are `admin` alone (AdminBotApproverRole).
  member: [
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

const SLACK_CHANNEL_NAME_ALLOWED_PREFIXES = [
  "proj",
  "meeting",
  "group",
  "lab",
  "students",
  "etc",
] as const;
type SlackChannelNamingPrefix = (typeof SLACK_CHANNEL_NAME_ALLOWED_PREFIXES)[number];

const SLACK_CHANNEL_NAME_RE = /^(proj|meeting|group|lab|students|etc)-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SLACK_CHANNEL_NAMING_RENAME_AFTER_MS = 48 * 60 * 60 * 1000;

// Least-privilege baseline for a member created without an explicit tier.
const DEFAULT_MEMBER_PRIVILEGE_LEVEL: AdminBotPrivilegeLevel = "external_collaborator";

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
    const headProfessorWhatsapp = normalizeOptionalString(settings.head_professor_whatsapp);
    const applicantSheetId = normalizeOptionalString(settings.applicant_sheet_id);
    const applicantLastReviewedAt = normalizeOptionalString(settings.applicant_last_reviewed_at);
    const next: AdminBotSettings = {
      ...current,
      ...(typeof settings.paper_escalation_business_days === "number"
        ? { paper_escalation_business_days: settings.paper_escalation_business_days }
        : {}),
      ...(headProfessorMemberId ? { head_professor_member_id: headProfessorMemberId } : {}),
      ...(headProfessorWhatsapp ? { head_professor_whatsapp: headProfessorWhatsapp } : {}),
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
    const existing = this.store.getLabMember(member.id);
    const privilegeLevel =
      member.privilege_level ?? existing?.privilege_level ?? DEFAULT_MEMBER_PRIVILEGE_LEVEL;
    // This is a patch, not a replace: `stored` below is {...existing, ...member}, and callers send
    // only the fields they are changing. So a *required* field has to be checked against what will
    // actually be stored rather than against the patch -- an admin saving their schedule sends
    // `availability` and nothing else, and validating the patch alone read that as a member with no
    // name at all. Every other check in validateLabMember is already guarded on `!== undefined`, so
    // it still only inspects what this request actually sent.
    const validation = validateLabMember(
      { ...member, name: member.name ?? existing?.name ?? "" },
      privilegeLevel,
      existing?.email,
    );
    if (validation) {
      return serviceError(400, validation);
    }
    const now = new Date().toISOString();
    const accessOverrides = member.access_overrides ?? existing?.access_overrides;
    const collaboratorSubgroup =
      privilegeLevel === "external_collaborator"
        ? (member.collaborator_subgroup ?? existing?.collaborator_subgroup)
        : undefined;
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
    // Promoting someone out of external_collaborator drops the subgroup instead of letting a stale
    // one ride along on ...existing: the access matrix only means anything for external
    // collaborators, and a hidden value would come back if they were ever demoted again.
    if (collaboratorSubgroup) {
      stored.collaborator_subgroup = collaboratorSubgroup;
    } else {
      delete stored.collaborator_subgroup;
    }
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

  // Keeps two profile fields current from Slack: backfills `slack_user_id` for members the
  // roster has never linked (by email match against the workspace directory), then re-reads
  // Slack's `tz` for every member who now has one and stamps it onto `timezone`. Like
  // refreshMemberMap, a member Slack has nothing for is cleared rather than left stale -- an
  // account that left the workspace should not keep outranking a member's own updated timezone
  // forever. slack_user_id itself is only ever added, never removed, since resolution can only
  // ever confirm a link, not disprove one.
  async refreshMemberDirectoryFromSlack(
    deps: {
      resolveSlackUserIdsByEmail?: (emails: string[]) => Promise<ReadonlyMap<string, string>>;
      // A present key means Slack answered for that user: a string is their zone, `null` is
      // "Slack has none". An *absent* key means the lookup never succeeded, which must never be
      // read as an answer -- see the clearing rule below.
      fetchSlackTimezones?: (slackUserIds: string[]) => Promise<ReadonlyMap<string, string | null>>;
      // Messages each member sent inside the activity window. Same present/absent contract as the
      // timezone reader: an absent key means the sweep could not measure that member, which must
      // never be stored as zero -- zero is "we looked and they said nothing", and the badge reads
      // the two differently.
      // Takes the channels to read as well as the members to count: Slack has no "messages by
      // user" endpoint a bot token can call, so the only route is reading channels and tallying by
      // author, and the store is what knows which channels the lab tracks.
      fetchSlackMessageCounts?: (
        slackUserIds: string[],
        channelIds: string[],
      ) => Promise<ReadonlyMap<string, number>>;
    },
    actor: string,
  ): Promise<
    AdminBotServiceResponse<{
      idsResolved: number;
      timezonesChecked: number;
      timezonesUpdated: number;
      activityChecked: number;
    }>
  > {
    const now = new Date().toISOString();
    let idsResolved = 0;
    if (deps.resolveSlackUserIdsByEmail) {
      const unlinked = this.store
        .listLabMembers()
        .filter(
          (member): member is AdminBotLabMember & { email: string } =>
            !member.slack_user_id && Boolean(member.email),
        );
      const resolved = await deps.resolveSlackUserIdsByEmail(
        unlinked.map((member) => member.email),
      );
      for (const member of unlinked) {
        const slackUserId = resolved.get(member.email.trim().toLowerCase());
        if (!slackUserId) {
          continue;
        }
        this.store.saveLabMember({ ...member, slack_user_id: slackUserId, updated_at: now });
        idsResolved += 1;
      }
    }
    let timezonesChecked = 0;
    let timezonesUpdated = 0;
    if (deps.fetchSlackTimezones) {
      const members = this.store.listLabMembers().filter((member) => member.slack_user_id);
      const ids = members.flatMap((member) => (member.slack_user_id ? [member.slack_user_id] : []));
      const timezones = await deps.fetchSlackTimezones(ids);
      for (const member of members) {
        const slackUserId = member.slack_user_id ?? "";
        // Not asked, or the ask failed. Clearing here is how a transport problem used to wipe a
        // roster: an empty result is indistinguishable from "Slack knows nothing about anyone",
        // and timezone is a mandatory field, so a failed refresh quietly made every profile
        // incomplete. Absent means unknown, and unknown leaves the stored value alone.
        if (!timezones.has(slackUserId)) {
          continue;
        }
        timezonesChecked += 1;
        const answer = timezones.get(slackUserId);
        const next = answer?.trim() || undefined;
        if ((member.timezone ?? undefined) === next) {
          continue;
        }
        const stored: AdminBotLabMember = { ...member, updated_at: now };
        if (next) {
          stored.timezone = next;
        } else {
          delete stored.timezone;
        }
        this.store.saveLabMember(stored);
        timezonesUpdated += 1;
      }
    }
    this.recordAudit({
      type: "member_directory.slack_synced",
      actor,
      details: { idsResolved, timezonesChecked, timezonesUpdated },
    });
    // Message counts, stamped last so a member linked earlier in this same pass is included.
    let activityChecked = 0;
    if (deps.fetchSlackMessageCounts) {
      const linked = this.store
        .listLabMembers()
        .filter((member): member is AdminBotLabMember & { slack_user_id: string } =>
          Boolean(member.slack_user_id?.trim()),
        );
      if (linked.length) {
        const channelIds = this.store
          .listSlackChannelNamingRecords()
          .map((record) => record.channel_id)
          .filter(Boolean);
        const counts = await deps.fetchSlackMessageCounts(
          linked.map((member) => member.slack_user_id),
          channelIds,
        );
        for (const member of linked) {
          const count = counts.get(member.slack_user_id);
          // Absent means the sweep could not measure this member. Leave the previous reading in
          // place rather than overwriting it with a zero nobody observed.
          if (count === undefined) {
            continue;
          }
          activityChecked += 1;
          this.store.saveLabMember({
            ...member,
            slack_messages_7d: count,
            slack_activity_checked_at: now,
            updated_at: now,
          });
        }
        this.recordAudit({
          type: "lab_member.upserted",
          actor,
          details: { slack_activity_checked: activityChecked },
        });
      }
    }
    return {
      ok: true,
      status: 200,
      payload: { idsResolved, timezonesChecked, timezonesUpdated, activityChecked },
    };
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
  // admin session (POST /nudges/send is gated the same way as /settings), so that
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
  /**
   * Records that an onboarding guide went out. Audited rather than stored as state: the email is
   * the artifact, and "who onboarded whom, when" is exactly the question the audit log answers.
   */
  recordOnboardingGuideSent(params: {
    actor: string;
    template_id: string;
    email: string;
    sent: boolean;
  }): void {
    this.recordAudit({
      type: "onboarding.guide_sent",
      actor: params.actor,
      details: {
        template_id: params.template_id,
        recipient: params.email,
        sent: params.sent,
      },
    });
  }

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

  // Read-only, so it carries no privilege gate of its own at the route level (same shape as
  // listPaperNudges) -- it is what the daily reminder run and the Control UI dashboard both check
  // before deciding whether there is anything to warn about.
  /**
   * One-time backfill of the `notes` line convention into the fields that now own those facts.
   *
   * ui/src/ui/adminbot/data/member-notes.ts encoded seven profile fields as "Label: value" lines
   * inside the free-text notes column, with no server-side schema. Five of them duplicated real
   * contract fields, so the same fact lived in two places and whichever one a reader consulted
   * decided the answer -- which is why making any of them mandatory was unsafe.
   *
   * Deliberately conservative, because this rewrites stored member records:
   *   - a contract field that already holds something is never overwritten; the line is dropped
   *     as the duplicate it is,
   *   - a line whose label is not one of the seven is left in notes untouched,
   *   - notes keeps whatever prose remains, and is cleared only when nothing is left.
   * Re-running it is a no-op once the lines are gone, so a partial run is safe to repeat.
   */
  migrateMemberNotesToFields(actor: string): AdminBotServiceResponse<{
    membersScanned: number;
    membersUpdated: number;
    fieldsFilled: number;
  }> {
    // Label as written by buildMemberNotes -> the field that now owns it. `research interests`
    // lands on research_topics, which is a list, so it is split the way the roster stores it.
    const LINE_FIELDS: Array<[string, keyof AdminBotLabMember]> = [
      ["location", "location"],
      ["joined month", "joined_month"],
      ["research interests", "research_topics"],
      ["gmail for calendar", "calendar_email"],
      ["whatsapp", "whatsapp"],
      ["github", "github_url"],
      ["personal website", "personal_website"],
    ];
    const now = new Date().toISOString();
    let membersUpdated = 0;
    let fieldsFilled = 0;
    const members = this.store.listLabMembers();
    for (const member of members) {
      const notes = typeof member.notes === "string" ? member.notes : "";
      if (!notes.trim()) {
        continue;
      }
      const kept: string[] = [];
      const patch: Record<string, unknown> = {};
      let touched = false;
      for (const rawLine of notes.split("\n")) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        const [rawKey, ...rest] = line.split(":");
        const key = rawKey?.trim().toLowerCase() ?? "";
        const value = rest.join(":").trim();
        const match = LINE_FIELDS.find(([label]) => label === key);
        if (!match || !value) {
          kept.push(line);
          continue;
        }
        touched = true;
        const [, field] = match;
        const existing = member[field];
        const alreadySet = Array.isArray(existing)
          ? existing.filter(Boolean).length > 0
          : String(existing ?? "").trim() !== "";
        if (alreadySet) {
          // The field wins. The line was a duplicate of a fact already stored properly.
          continue;
        }
        patch[field] =
          field === "research_topics"
            ? value
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean)
            : value;
        fieldsFilled += 1;
      }
      if (!touched) {
        continue;
      }
      const remaining = kept.join("\n").trim();
      const stored: AdminBotLabMember = { ...member, ...patch, updated_at: now };
      if (remaining) {
        stored.notes = remaining;
      } else {
        delete stored.notes;
      }
      this.store.saveLabMember(stored);
      membersUpdated += 1;
    }
    this.recordAudit({
      type: "lab_member.notes_migrated",
      actor,
      details: { members_scanned: members.length, members_updated: membersUpdated, fieldsFilled },
    });
    return {
      ok: true,
      status: 200,
      payload: { membersScanned: members.length, membersUpdated, fieldsFilled },
    };
  }

  listMembersWithIncompleteMandatoryFields(): AdminBotServiceResponse<{
    members: Array<{ id: string; name: string; missing_fields: string[] }>;
  }> {
    const members = this.store
      .listLabMembers()
      .filter((member) => member.status !== "alumni" && member.status !== "external")
      .map((member) => ({ member, missing: missingMandatoryProfileFields(member) }))
      .filter(({ missing }) => missing.length > 0)
      .map(({ member, missing }) => ({
        id: member.id,
        name: member.name,
        missing_fields: missing,
      }));
    return { ok: true, status: 200, payload: { members } };
  }

  /**
   * Slack-nudge every member whose profile is missing a required field. Meant to run once a day
   * from cron (scripts/adminbot-mandatory-fields-cron.sh), not from a click: the message is fixed
   * and the recipient list is entirely server-computed from roster state, so there is no
   * admin-or-agent-controlled content or targeting for the usual "requires a genuine admin
   * session" gate to protect against (see requirePrivileged vs requireMemberPrivileged in
   * api/server.ts, and the identical reasoning already applied to /openreview/cycle/run).
   *
   * Delivery still goes through sendMemberNudge, so this is still propose -> auto-execute ->
   * audit, exactly like every other member_nudge.send -- it just computes its own recipients
   * instead of taking them from a request body.
   */
  async sendMandatoryFieldsReminders(
    actor: string,
  ): Promise<AdminBotServiceResponse<AdminBotMemberNudgeResult>> {
    const incomplete = this.listMembersWithIncompleteMandatoryFields();
    if (!incomplete.ok) {
      return incomplete;
    }
    // Who was reminded recently, so the cadence is a property of the product rather than of
    // whatever schedule happens to invoke the cron script. A misconfigured crontab, a manual run,
    // or two hosts running the same job cannot turn this into a daily nag.
    const remindedAt = this.lastMandatoryFieldsReminderByMember();
    const cutoff = Date.now() - MANDATORY_FIELDS_REMINDER_INTERVAL_MS;
    const recipients = incomplete.payload.members
      .map((member) => member.id)
      .filter((id) => (remindedAt.get(id) ?? 0) <= cutoff);
    if (recipients.length === 0) {
      return { ok: true, status: 200, payload: { created: [], skipped: [] } };
    }
    const result = await this.sendMemberNudge(
      {
        channel: "slack",
        recipient_member_ids: recipients,
        message: buildMandatoryFieldsReminderMessage(),
      },
      actor,
    );
    if (result.ok) {
      // Stamp only the members a nudge was actually created for. Someone sendMemberNudge skipped
      // (no Slack id on file, say) has not been reminded, and must not wait three days to be
      // considered again.
      const notified = recipients.filter(
        (id) => !result.payload.skipped.some((skip) => skip.member_id === id),
      );
      if (notified.length > 0) {
        this.recordAudit({
          type: "mandatory_fields.reminded",
          actor,
          details: { member_ids: notified },
        });
      }
    }
    return result;
  }

  /** Epoch millis of the last mandatory-fields reminder each member received. */
  private lastMandatoryFieldsReminderByMember(): Map<string, number> {
    const latest = new Map<string, number>();
    for (const event of this.store.listAuditEvents()) {
      if (event.type !== "mandatory_fields.reminded") {
        continue;
      }
      const ids = (event.details as { member_ids?: unknown } | undefined)?.member_ids;
      if (!Array.isArray(ids)) {
        continue;
      }
      const at = Date.parse(event.timestamp);
      if (Number.isNaN(at)) {
        continue;
      }
      for (const id of ids) {
        if (typeof id === "string" && at > (latest.get(id) ?? 0)) {
          latest.set(id, at);
        }
      }
    }
    return latest;
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

  async processSlackChannelNamingEvent(
    event: AdminBotSlackChannelNamingEvent,
    actor = "slack-monitor",
  ): Promise<
    AdminBotServiceResponse<{
      status: "compliant" | "pending" | "reminder_sent";
      channel_id: string;
      channel_name: string;
      suggested_name?: string;
    }>
  > {
    const channelId = event.channel_id.trim();
    const channelName = normalizeSlackChannelName(event.channel_name);
    if (!channelId) {
      return serviceError(400, "channel_id is required");
    }
    if (!channelName) {
      return serviceError(400, "channel_name is required");
    }
    const naming = evaluateSlackChannelName({
      channelName,
      purpose: normalizeOptionalString(event.purpose),
      topic: normalizeOptionalString(event.topic),
    });
    if (naming.valid) {
      this.store.deleteSlackChannelNamingRecord(channelId);
      return {
        ok: true,
        status: 200,
        payload: {
          status: "compliant",
          channel_id: channelId,
          channel_name: channelName,
        },
      };
    }
    const now = new Date().toISOString();
    const existing = this.store.getSlackChannelNamingRecord(channelId);
    const ownerUserId = normalizeOptionalString(event.owner_user_id) ?? existing?.owner_user_id;
    let reminderSentAt = existing?.reminder_sent_at;
    let reminderActionId = existing?.reminder_action_id;
    if (!reminderSentAt && ownerUserId) {
      const reminder = await this.sendSlackChannelNamingNotice({
        ownerUserId,
        channelId,
        channelName,
        suggestedName: naming.suggestedName,
        mode: "reminder",
      });
      if (reminder.ok) {
        reminderSentAt = now;
        reminderActionId = reminder.payload.id;
      }
    }
    this.store.saveSlackChannelNamingRecord({
      channel_id: channelId,
      latest_channel_name: channelName,
      ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
      expected_prefix: naming.expectedPrefix,
      suggested_name: naming.suggestedName,
      first_seen_at: existing?.first_seen_at ?? now,
      last_seen_at: now,
      ...(reminderSentAt ? { reminder_sent_at: reminderSentAt } : {}),
      ...(reminderActionId ? { reminder_action_id: reminderActionId } : {}),
    });
    this.recordAudit({
      type: "slack.channel_naming_checked",
      actor,
      details: {
        channel_id: channelId,
        channel_name: channelName,
        suggested_name: naming.suggestedName,
        reminded: Boolean(reminderSentAt),
      },
    });
    return {
      ok: true,
      status: 200,
      payload: {
        status: reminderSentAt ? "reminder_sent" : "pending",
        channel_id: channelId,
        channel_name: channelName,
        suggested_name: naming.suggestedName,
      },
    };
  }

  async runSlackChannelNamingSweep(
    actor = "slack-monitor",
    nowIso = new Date().toISOString(),
  ): Promise<
    AdminBotServiceResponse<{
      scanned: number;
      reminders_pending: number;
      renamed: number;
      skipped: number;
    }>
  > {
    const records = this.store.listSlackChannelNamingRecords();
    const dueBefore = new Date(
      Date.parse(nowIso) - SLACK_CHANNEL_NAMING_RENAME_AFTER_MS,
    ).toISOString();
    let remindersPending = 0;
    let renamed = 0;
    let skipped = 0;
    for (const record of records) {
      const naming = evaluateSlackChannelName({ channelName: record.latest_channel_name });
      if (naming.valid) {
        this.store.deleteSlackChannelNamingRecord(record.channel_id);
        continue;
      }
      if (!record.reminder_sent_at || record.reminder_sent_at > dueBefore) {
        remindersPending += 1;
        continue;
      }
      const rename = this.createProposal({
        type: "slack.rename_channel",
        summary: `Rename Slack channel #${record.latest_channel_name} to #${record.suggested_name}`,
        target: {
          service: "slack",
          channel_id: record.channel_id,
        },
        proposed_payload: {
          channel_id: record.channel_id,
          new_name: record.suggested_name,
        },
        rationale:
          "Channel naming policy auto-enforcement after a 48-hour reminder window elapsed.",
        undo_plan:
          "Rename the channel again if a lab admin decides another compliant name is better.",
      });
      if (!rename.ok) {
        skipped += 1;
        continue;
      }
      const renameExecuted = await this.execute(rename.payload.id, { dry_run: false });
      if (!renameExecuted.ok) {
        skipped += 1;
        continue;
      }
      renamed += 1;
      if (record.owner_user_id) {
        await this.sendSlackChannelNamingNotice({
          ownerUserId: record.owner_user_id,
          channelId: record.channel_id,
          channelName: record.latest_channel_name,
          suggestedName: record.suggested_name,
          mode: "renamed",
        });
      }
      this.store.deleteSlackChannelNamingRecord(record.channel_id);
    }
    this.recordAudit({
      type: "slack.channel_naming_swept",
      actor,
      details: { scanned: records.length, renamed, reminders_pending: remindersPending },
    });
    return {
      ok: true,
      status: 200,
      payload: {
        scanned: records.length,
        reminders_pending: remindersPending,
        renamed,
        skipped,
      },
    };
  }

  private async sendSlackChannelNamingNotice(
    params: {
      ownerUserId: string;
      channelId: string;
      channelName: string;
      suggestedName: string;
      mode: "reminder" | "renamed";
    },
    // No `actor` parameter: both call sites used to pass one and nothing here consumed it. The
    // intent was presumably audit attribution, but this flow records no audit event of its own —
    // createProposal/execute do their own. Reinstate it alongside a real audit type if the
    // enforcement flow should name who triggered a notice.
  ): Promise<AdminBotServiceResponse<AdminBotStoredProposal>> {
    const message =
      params.mode === "reminder"
        ? [
            `Hi <@${params.ownerUserId}>,`,
            `the channel #${params.channelName} does not follow the lab naming policy.`,
            `Please rename it to something like #${params.suggestedName} within 48 hours.`,
            "Allowed prefixes: proj-, meeting-, group-, lab-, students-, etc-.",
          ].join(" ")
        : [
            `Hi <@${params.ownerUserId}>,`,
            `we renamed #${params.channelName} to #${params.suggestedName} because it stayed non-compliant for over 48 hours after the reminder.`,
            "Allowed prefixes: proj-, meeting-, group-, lab-, students-, etc-.",
          ].join(" ");
    const proposal = this.createProposal({
      type: "slack.channel_naming_notify_owner",
      summary:
        params.mode === "reminder"
          ? `Remind Slack channel owner about naming policy for #${params.channelName}`
          : `Notify Slack channel owner after automatic rename to #${params.suggestedName}`,
      target: {
        service: "slack",
        owner_user_id: params.ownerUserId,
        channel_id: params.channelId,
      },
      proposed_payload: {
        owner_user_id: params.ownerUserId,
        message,
      },
      rationale:
        params.mode === "reminder"
          ? "Owner notification before policy enforcement."
          : "Owner notification after automatic policy enforcement.",
      undo_plan: "Send a follow-up clarification if the channel context needs correction.",
    });
    if (!proposal.ok) {
      return proposal;
    }
    const executed = await this.execute(proposal.payload.id, { dry_run: false });
    if (!executed.ok) {
      return executed;
    }
    return {
      ok: true,
      status: 200,
      payload: this.store.getProposal(proposal.payload.id) ?? proposal.payload,
    };
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
  "preferred_name",
  "slack_user_id",
  // Slack-derived, not something a member types: the roster sync writes it through the service
  // principal, which lands on this same whitelist. Governance fields stay in the privileged list.
  "slack_channels",
  // Written by the Slack activity sweep through the service principal, never typed by a member.
  "slack_messages_7d",
  "slack_activity_checked_at",
  "role",
  "research_branch",
  "research_topics",
  "projects",
  "hours_per_week",
  "availability",
  "location",
  "current_city",
  "affiliation",
  "timezone",
  "personal_website",
  "openreview_id",
  "avatar_url",
  "cv_url",
  "intake_form_url",
  "linkedin_url",
  "linkedin_urn",
  "twitter_url",
  "github_url",
  "scholar_url",
  "calendar_email",
  "joined_month",
  "graduated_month",
  "whatsapp",
  "correspondence_email",
  // Confidential on read (see adminBotConfidentialMemberFields); self-editable like any other
  // field a member writes about themselves.
  "personal_circumstances",
  "lesswrong_url",
  "notes",
  "availability",
  "time_off",
  "milestones",
  "availability_doc_url",
] as const;

const SELF_PROFILE_PRIVILEGED_FIELDS = [
  "privilege_level",
  "collaborator_subgroup",
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
    return approvalPolicy(riskTier, ["admin"]);
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

// How long a member is left alone after a mandatory-fields reminder. The cron script may run as
// often as it likes -- daily is fine, and gives a member who fills their profile in on day one a
// prompt exit from the list -- but nobody is nudged about the same gap more than once per window.
const MANDATORY_FIELDS_REMINDER_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

// The one list, shared with the Control UI through the contracts module so the reminder can never
// chase a field the profile page calls optional. See adminBotMandatoryProfileFields.
//
// name is dropped here even though the page marks it required: validateLabMember already refuses to
// store a member with no name, so it can never actually be the reason a stored record is
// incomplete.
const MANDATORY_PROFILE_FIELDS = adminBotMandatoryProfileFields.filter((key) => key !== "name");
function missingMandatoryProfileFields(member: AdminBotLabMember): string[] {
  return MANDATORY_PROFILE_FIELDS.filter((key) => {
    const value = member[key];
    if (Array.isArray(value)) {
      return value.filter(Boolean).length === 0;
    }
    return value === undefined || value === null || String(value).trim() === "";
  });
}

// One shared, deterministic reminder rather than a message per missing field: the whole point of
// this reminder is that nobody composes it, so its content can never be attacker- or
// agent-controlled. Listing exactly which lab-wide fields are still checked (not each member's own
// missing subset) keeps the message identical for every recipient, which is what lets it go out
// through a single sendMemberNudge call instead of one per person.
function buildMandatoryFieldsReminderMessage(): string {
  const fields = MANDATORY_PROFILE_FIELDS.map((key) => adminBotMandatoryProfileFieldLabels[key]).join(
    ", ",
  );
  return [
    "Quick reminder: your AdminBot profile is missing one or more required fields " +
      `(${fields}).`,
    "Open your profile page in the Control UI and fill in what's missing — it saves as you type.",
    "Already done? You'll stop getting this once every required field is filled in.",
  ].join("\n");
}

// Built from the checklist definition rather than hardcoded per step, so the nudge text and the
// dashboard warning card can never describe the task differently.
function buildOnboardingNudgeMessage(step: AdminBotMemberOnboardingStep | undefined): string {
  if (!step) {
    return "You have an outstanding lab onboarding step — see your AdminBot dashboard.";
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
  lines.push(
    "(Reactions are picked up automatically every few hours, so the confirmation isn't instant — don't worry, it will be recorded. You can also mark it complete on your AdminBot dashboard.)",
  );
  return lines.join("\n");
}

function validateLabMember(
  member: AdminBotLabMemberInput,
  privilegeLevel: AdminBotPrivilegeLevel,
  existingEmail?: string,
): string | undefined {
  if (!member.id.trim()) {
    return "member id is required";
  }
  // Optional-chained even though the type says `name` is required: the HTTP layer casts a parsed
  // JSON body straight to this type, so an absent name reaches here as undefined and used to throw
  // a TypeError out of the route as a 500 rather than answering 400.
  if (!member.name?.trim()) {
    return "member name is required";
  }
  if (member.status && !adminBotMemberStatuses.includes(member.status)) {
    return "member status is invalid";
  }
  const emailError = validateCsEmail(member.email, privilegeLevel, existingEmail);
  if (emailError) {
    return emailError;
  }
  if (member.calendar_email !== undefined) {
    const calendarEmailError = validateEmailFormat(member.calendar_email, "calendar email");
    if (calendarEmailError) {
      return calendarEmailError;
    }
  }
  if (member.collaborator_subgroup !== undefined) {
    if (!adminBotExternalCollaboratorSubgroups.includes(member.collaborator_subgroup)) {
      return `member collaborator subgroup must be one of: ${adminBotExternalCollaboratorSubgroups.join(", ")}`;
    }
    // Checked against the *effective* level, so setting a subgroup on a stored external
    // collaborator works without resending privilege_level, and a same-request promotion is refused
    // rather than silently keeping a subgroup the new level has no matrix for.
    if (privilegeLevel !== "external_collaborator") {
      return "member collaborator subgroup requires privilege level external_collaborator";
    }
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
  if (member.openreview_id !== undefined) {
    const openReviewError = validateOpenReviewId(member.openreview_id);
    if (openReviewError) {
      return openReviewError;
    }
  }
  // Slack channel names, not ids or links: the sync writes what `users.conversations` reports, and
  // a stray "#" or a full archive URL would break the lookups that join a member to a channel.
  if (member.slack_channels !== undefined) {
    if (!Array.isArray(member.slack_channels)) {
      return "member slack channels must be a list";
    }
    for (const channel of member.slack_channels) {
      if (typeof channel !== "string" || !SLACK_CHANNEL_NAME.test(channel)) {
        return `member slack channel is invalid: ${String(channel)}`;
      }
    }
  }
  for (const spec of SOCIAL_URL_FIELDS) {
    const value = member[spec.field];
    if (value === undefined) {
      continue;
    }
    const urlError = validateSocialUrl(value, spec);
    if (urlError) {
      return urlError;
    }
  }
  return validateAvailability(member);
}

// Every one of these is a *real* account-page shape check, not merely "is this a URL" -- a
// wrong-platform link (a GitHub URL saved as the Twitter field) or a bare domain with no handle
// fails the same way a garbage string would. Confirming the account actually *exists* is a
// liveness question, not a shape question, so it deliberately does not belong here: a live check
// means an outbound fetch on every profile save, and (per AVAILABILITY_DOC_HOSTS above) this
// service does not add fetch primitives driven by member-supplied input. The Control UI does that
// check itself, client-side, against each platform's own public API, where it costs nothing to
// get wrong and nothing to rate-limit.
type SocialUrlFieldSpec = {
  field:
    | "personal_website"
    | "avatar_url"
    | "cv_url"
    | "intake_form_url"
    | "linkedin_url"
    | "twitter_url"
    | "github_url"
    | "scholar_url";
  label: string;
  // Omitted for personal_website/cv_url: those genuinely point anywhere the member likes.
  hosts?: Set<string>;
  path?: RegExp;
  requireQueryParam?: string;
};

const SOCIAL_URL_FIELDS: SocialUrlFieldSpec[] = [
  { field: "personal_website", label: "personal website" },
  { field: "avatar_url", label: "profile photo" },
  { field: "cv_url", label: "CV" },
  {
    // A member's own intake answers. Google Forms hands each respondent a link to their single
    // submitted response, so the host is fixed and the path is always a /forms/ route -- checking
    // that much stops a stray link being filed here, without pretending to know the response id.
    field: "intake_form_url",
    label: "intake form answers",
    hosts: new Set(["docs.google.com"]),
    path: /^\/forms\/.+/u,
  },
  {
    field: "github_url",
    label: "GitHub",
    hosts: new Set(["github.com", "www.github.com"]),
    path: /^\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/?$/u,
  },
  {
    field: "twitter_url",
    label: "Twitter/X",
    hosts: new Set(["twitter.com", "www.twitter.com", "x.com", "www.x.com"]),
    path: /^\/[A-Za-z0-9_]{1,15}\/?$/u,
  },
  {
    field: "linkedin_url",
    label: "LinkedIn",
    hosts: new Set(["linkedin.com", "www.linkedin.com"]),
    path: /^\/in\/[A-Za-z0-9\-_%]+\/?$/u,
  },
  {
    field: "scholar_url",
    label: "Google Scholar",
    hosts: new Set(["scholar.google.com"]),
    path: /^\/citations\/?$/u,
    requireQueryParam: "user",
  },
];

function validateSocialUrl(value: unknown, spec: SocialUrlFieldSpec): string | undefined {
  if (typeof value !== "string") {
    return `${spec.label} link must be a string`;
  }
  const trimmed = value.trim();
  // Empty clears the link.
  if (!trimmed) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `${spec.label} link must be a valid URL`;
  }
  if (parsed.protocol !== "https:") {
    return `${spec.label} link must use https`;
  }
  if (spec.hosts && !spec.hosts.has(parsed.hostname)) {
    return `${spec.label} link must point to ${spec.label}`;
  }
  if (spec.path && !spec.path.test(parsed.pathname)) {
    return `${spec.label} link must be a profile URL (e.g. a page with a username in the path)`;
  }
  if (spec.requireQueryParam && !parsed.searchParams.has(spec.requireQueryParam)) {
    return `${spec.label} link must include a ${spec.requireQueryParam} parameter`;
  }
  return undefined;
}

// OpenReview tilde ids look like "~First_Last1": a letter, then letters/digits/underscores/dots,
// ending in the disambiguating digit OpenReview appends. Rejecting the shape here is cheap and
// catches "pasted the profile URL instead of the id" before it reaches the reviewing-cycle
// automation that matches submissions against this field.
// Hyphens and non-ASCII letters are both ordinary in real ids -- "~Tung-Yu_Wu1",
// "~Emilia_Wiśnios1" -- and the old ASCII-only, hyphen-free pattern rejected them, which silently
// cost those members the field. Still anchored on the tilde and the trailing disambiguation digit,
// which are the parts OpenReview actually guarantees.
const SLACK_CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const OPENREVIEW_ID = /^~\p{L}[\p{L}\p{N}_.-]*[0-9]$/u;

function validateOpenReviewId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return "openreview id must be a string";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!OPENREVIEW_ID.test(trimmed)) {
    return 'openreview id must look like "~First_Last1" (see the "id" in your OpenReview profile URL)';
  }
  return undefined;
}

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function validateEmailFormat(value: unknown, label: string): string | undefined {
  if (typeof value !== "string") {
    return `${label} must be a string`;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!EMAIL_FORMAT.test(trimmed)) {
    return `${label} must be a valid email address`;
  }
  return undefined;
}

const CS_TORONTO_EMAIL = /^[^\s@]+@cs\.toronto\.edu$/iu;

// The department directory is the whole reason `email` is governance-owned rather than
// self-editable: every Slack/paper/reimbursement flow that identifies a member by email
// assumes it is their cs.toronto.edu address. external_collaborator exists precisely for
// people who are not in that directory, so they are exempt rather than unable to be added at
// all. Only a genuinely new or changed value is checked -- re-saving an unrelated field on an
// already-stored member must not start failing because of a value nobody is touching.
function validateCsEmail(
  value: string | undefined,
  privilegeLevel: AdminBotPrivilegeLevel,
  existingEmail: string | undefined,
): string | undefined {
  if (value === undefined || value === existingEmail) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || privilegeLevel === "external_collaborator") {
    return undefined;
  }
  if (!CS_TORONTO_EMAIL.test(trimmed)) {
    return "member email must be a @cs.toronto.edu address (external collaborators are exempt)";
  }
  return undefined;
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

// Supporting links on a schedule row or milestone. Deliberately stricter than "is a URL": these
// are rendered as anchors in the Control UI, so anything but https is refused outright rather than
// left for the renderer to decide about. Unlike availability_doc_url this is not restricted to
// Google — a syllabus or a project board can live anywhere.
function validateExternalLink(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return `${label} link must be a string`;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${label} link must be a valid URL`;
  }
  if (parsed.protocol !== "https:") {
    return `${label} link must use https`;
  }
  return undefined;
}

function validateLabel(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return `${label} must be a string`;
  }
  if (value.length > ADMINBOT_MAX_LABEL_LENGTH) {
    return `${label} cannot exceed ${ADMINBOT_MAX_LABEL_LENGTH} characters`;
  }
  return undefined;
}

function validateMilestones(member: AdminBotLabMemberInput): string | undefined {
  if (member.milestones === undefined) {
    return undefined;
  }
  if (!Array.isArray(member.milestones)) {
    return "member milestones must be a list";
  }
  if (member.milestones.length > MAX_AVAILABILITY_ROWS) {
    return `member milestones cannot exceed ${MAX_AVAILABILITY_ROWS} rows`;
  }
  for (const row of member.milestones) {
    if (!Number.isFinite(parseIsoDate(row?.date))) {
      return "milestone date must be YYYY-MM-DD";
    }
    // A milestone with no label is an unexplained mark on someone's timeline.
    if (typeof row.label !== "string" || !row.label.trim()) {
      return "milestone label is required";
    }
    const labelError = validateLabel(row.label, "milestone label");
    if (labelError) {
      return labelError;
    }
    const linkError = validateExternalLink(row.link, "milestone");
    if (linkError) {
      return linkError;
    }
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
      const linkError = validateExternalLink(row.link, "availability");
      if (linkError) {
        return linkError;
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
      const labelError = validateLabel(row.label, "time off label");
      if (labelError) {
        return labelError;
      }
      const linkError = validateExternalLink(row.link, "time off");
      if (linkError) {
        return linkError;
      }
    }
  }
  return validateMilestones(member);
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

function normalizeSlackChannelName(value: string): string {
  return value
    .trim()
    .replace(/^#/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/(^-|-$)/gu, "");
}

function evaluateSlackChannelName(params: {
  channelName: string;
  purpose?: string;
  topic?: string;
}): { valid: boolean; expectedPrefix: SlackChannelNamingPrefix; suggestedName: string } {
  const normalized = normalizeSlackChannelName(params.channelName);
  const valid = SLACK_CHANNEL_NAME_RE.test(normalized);
  const expectedPrefix = inferSlackChannelPrefix({
    channelName: normalized,
    purpose: params.purpose,
    topic: params.topic,
  });
  const remainder = SLACK_CHANNEL_NAME_ALLOWED_PREFIXES.some((prefix) =>
    normalized.startsWith(`${prefix}-`),
  )
    ? normalized.replace(/^[a-z]+-/u, "")
    : normalized;
  const base = remainder || "untitled";
  const suggestedName = `${expectedPrefix}-${base}`
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-");
  return {
    valid,
    expectedPrefix,
    suggestedName: SLACK_CHANNEL_NAME_RE.test(suggestedName)
      ? suggestedName
      : `${expectedPrefix}-channel`,
  };
}

function inferSlackChannelPrefix(params: {
  channelName: string;
  purpose?: string;
  topic?: string;
}): SlackChannelNamingPrefix {
  const basis = [params.channelName, params.purpose, params.topic]
    .map((part) => part?.toLowerCase() ?? "")
    .join(" ");
  if (/\b(student|students|phd|master|msc|undergrad)\b/u.test(basis)) {
    return "students";
  }
  if (/\b(meeting|sync|standup|seminar|reading)\b/u.test(basis)) {
    return "meeting";
  }
  if (/\b(group|toronto|location|cohort|team)\b/u.test(basis)) {
    return "group";
  }
  if (/\b(lab|logistics|question|opportunit|lunch)\b/u.test(basis)) {
    return "lab";
  }
  if (/\b(food|music|sport|social|fun|casual)\b/u.test(basis)) {
    return "etc";
  }
  return "proj";
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

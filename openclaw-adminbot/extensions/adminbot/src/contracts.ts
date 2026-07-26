export const adminBotRiskTiers = ["T0", "T1", "T2", "T3", "T4"] as const;

export type AdminBotRiskTier = (typeof adminBotRiskTiers)[number];

export const adminBotActionTypes = [
  "candidate.accept_for_trial",
  "candidate.accept_direct",
  "candidate.decline",
  "slack.invite_guest",
  "slack.invite_member",
  "slack.send_message",
  "vector.invite",
  "calendar.create_tentative_hold",
  "calendar.send_invite",
  "calendar.reschedule",
  "calendar.cancel",
  "email.draft",
  "email.send",
  "recommendation_letter.draft",
  "recommendation_letter.send",
  "reimbursement.prepare_packet",
  "reimbursement.submit",
  "social_media.draft",
  "social_media.post_publicly",
  "paper_publish.prepare",
  "paper.overleaf_edit",
  "paper_publish.submit",
  "paper_publish.nudge_author",
  "paper_publish.escalate_to_pi",
  "join_form.classify",
  "member_nudge.send",
] as const;

export type AdminBotActionType = (typeof adminBotActionTypes)[number];

export type AdminBotEvidencePointer = {
  source: string;
  id?: string;
  url?: string;
  snippet?: string;
  hash?: string;
};

// Ordered least- to most-privileged.
export const adminBotPrivilegeLevels = [
  "external_collaborator",
  "trial",
  "member",
  "core_member",
  "admin",
] as const;

export type AdminBotPrivilegeLevel = (typeof adminBotPrivilegeLevels)[number];

export type AdminBotAccessGrant = {
  service: string;
  access: "none" | "view" | "comment" | "edit" | "admin";
  scope?: string;
};

export const adminBotMemberStatuses = [
  "active",
  "part_time",
  "on_leave",
  "alumni",
  "external",
] as const;

export type AdminBotMemberStatus = (typeof adminBotMemberStatuses)[number];

export type AdminBotMemberOnboardingStepStatus = "complete" | "current" | "remaining";

export type AdminBotMemberOnboardingLink = {
  label: string;
  url: string;
};

export type AdminBotMemberOnboardingStep = {
  id: string;
  label: string;
  status: AdminBotMemberOnboardingStepStatus;
  // Section header the step renders under in the Control UI welcome screen (e.g. "Social media").
  category: string;
  // Short summary shown above the bullet breakdown, if any.
  detail?: string;
  // Longer instructions broken into scannable points instead of one paragraph.
  bullets?: string[];
  // Clickable buttons (social pages, docs, application forms) shown below the text.
  links?: AdminBotMemberOnboardingLink[];
  required: boolean;
};

export type AdminBotMemberOnboarding = {
  current_step?: AdminBotMemberOnboardingStep;
  completed: AdminBotMemberOnboardingStep[];
  remaining: AdminBotMemberOnboardingStep[];
  steps: AdminBotMemberOnboardingStep[];
};
export type AdminBotLabMemberInput = {
  id: string;
  name: string;
  email?: string;
  slack_user_id?: string;
  privilege_level?: AdminBotPrivilegeLevel;
  access_overrides?: AdminBotAccessGrant[];
  notes?: string;
  role?: string;
  status?: AdminBotMemberStatus;
  research_branch?: string;
  research_topics?: string[];
  projects?: string[];
  hours_per_week?: number;
  capacity_percent?: number;
  location?: string;
  affiliation?: string;
  timezone?: string;
  personal_website?: string;
};

export type AdminBotLabMember = Omit<AdminBotLabMemberInput, "privilege_level"> & {
  privilege_level: AdminBotPrivilegeLevel;
  access: AdminBotAccessGrant[];
  onboarding?: AdminBotMemberOnboarding;
  created_at: string;
  updated_at: string;
};

export type AdminBotSettingsInput = {
  paper_escalation_business_days?: number;
  head_professor_member_id?: string;
  applicant_sheet_id?: string;
  applicant_last_reviewed_at?: string;
};

export type AdminBotSettings = {
  paper_escalation_business_days: number;
  head_professor_member_id?: string;
  applicant_sheet_id?: string;
  applicant_last_reviewed_at?: string;
  updated_at: string;
};

export const adminBotPaperSteps = [
  "brainstorming_docs",
  "overleaf_writing",
  "submission",
  "google_drive_pdf",
  "arxiv_polish",
  "social_posts",
  "slide_making",
  "poster_making",
] as const;

export type AdminBotPaperStep = (typeof adminBotPaperSteps)[number];

export const adminBotPaperTimelineDependencyGroups = [
  "ideation",
  "writing",
  "submission",
  "release",
  "outreach",
  "materials",
] as const;

export type AdminBotPaperTimelineDependencyGroup =
  (typeof adminBotPaperTimelineDependencyGroups)[number];

export type AdminBotPaperTimelineStatus = "complete" | "current" | "upcoming" | "blocked";

export type AdminBotPaperTimelineItem = {
  step: AdminBotPaperStep;
  label: string;
  dependency_group: AdminBotPaperTimelineDependencyGroup;
  depends_on: AdminBotPaperStep[];
  status: AdminBotPaperTimelineStatus;
  offset_start_business_day: number;
  offset_end_business_day: number;
  duration_business_days: number;
  color: string;
};

export type AdminBotPaperTimeline = {
  progress_percent: number;
  current_step_index: number;
  total_estimated_business_days: number;
  items: AdminBotPaperTimelineItem[];
};
export type AdminBotPaperArtifactLinks = {
  conference?: string;
  topic?: string;
  brainstorming_doc_url?: string;
  overleaf_view_url?: string;
  overleaf_edit_url?: string;
  submission_url?: string;
  google_drive_pdf_url?: string;
  arxiv_url?: string;
  github_url?: string;
  twitter_draft_url?: string;
  linkedin_draft_url?: string;
  google_slides_url?: string;
  poster_url?: string;
};

export type AdminBotPaperReminderState = {
  status?: "idle" | "waiting_on_authors" | "blocked" | "complete";
  requested_step_at?: string;
  last_author_dm_at?: string;
  last_author_reply_at?: string;
  next_nudge_at?: string;
  escalation_after_business_days?: number;
  head_professor_member_id?: string;
};

export type AdminBotPaperRecordInput = {
  id: string;
  title: string;
  authors: string[];
  current_step: AdminBotPaperStep;
  artifacts?: AdminBotPaperArtifactLinks;
  mentor_member_id?: string;
  checks?: {
    affiliation_checked?: boolean;
    github_link_checked?: boolean;
    paper_mentor_checked?: boolean;
  };
  reminder?: AdminBotPaperReminderState;
  notes?: string;
};

export type AdminBotPaperRecord = AdminBotPaperRecordInput & {
  timeline?: AdminBotPaperTimeline;
  created_at: string;
  updated_at: string;
};

export type AdminBotPaperNudge = {
  type: "author_nudge" | "head_professor_escalation";
  paper_id: string;
  title: string;
  step: AdminBotPaperStep;
  recipients: string[];
  message: string;
  business_days_since_author_dm?: number;
  timeline?: AdminBotPaperTimeline;
};

// Member nudge: an admin-composed message (paper-flow reminder or general announcement) sent to a
// chosen set of members over Slack or email. Each recipient becomes its own `member_nudge.send`
// proposal (same propose -> approve -> execute pipeline as every other outbound message), so
// approval/audit granularity stays per-recipient.
export type AdminBotMemberNudgeChannel = "slack" | "email";

export type AdminBotMemberNudgeRequest = {
  channel: AdminBotMemberNudgeChannel;
  recipient_member_ids: string[];
  message: string;
  // Email subject line. Required for channel "email"; ignored for "slack".
  subject?: string;
};

export type AdminBotMemberNudgeSkip = {
  member_id: string;
  reason: string;
};

export type AdminBotMemberNudgeResult = {
  created: AdminBotStoredProposal[];
  skipped: AdminBotMemberNudgeSkip[];
};

export type AdminBotActionProposal = {
  type: AdminBotActionType;
  risk_tier?: AdminBotRiskTier;
  summary: string;
  target?: Record<string, unknown>;
  evidence?: AdminBotEvidencePointer[];
  proposed_payload?: unknown;
  rationale?: string;
  undo_plan?: string;
  idempotency_key?: string;
  dry_run?: boolean;
};

export type AdminBotApprovalRequest = {
  payload_hash: string;
  approver_role: string;
  approver_id?: string;
  note?: string;
};

export type AdminBotRemovePendingRequest = {
  actor?: string;
  note?: string;
};

export type AdminBotExecutionRequest = {
  idempotency_key?: string;
  dry_run?: boolean;
};

export type AdminBotPrivacyTaskRequest = {
  task: string;
  privacy?: "auto" | "private";
  sensitive_terms?: string[];
};

export type AdminBotPrivacyTaskResult = {
  route: "local" | "remote" | "hybrid";
  output: string;
};

export type AdminBotSensitiveInfoRecord = {
  markdown: string;
  path?: string;
};

export type AdminBotApprovalRequirement = {
  requires_approval: boolean;
  approver_roles: string[];
  min_approvals: number;
};

export type AdminBotStoredProposal = AdminBotActionProposal & {
  id: string;
  risk_tier: AdminBotRiskTier;
  payload_hash: string;
  status: "pending" | "approved" | "executed" | "rejected";
  approval_requirement: AdminBotApprovalRequirement;
  approvals: AdminBotApprovalRequest[];
  created_at: string;
  updated_at: string;
};

export type AdminBotExecutionResult = {
  action_id: string;
  status: "simulated" | "executed";
  dry_run: boolean;
  idempotency_key?: string;
  executed_at: string;
};

export type AdminBotAuditEvent = {
  id: string;
  action_id?: string;
  type:
    | "proposal.created"
    | "proposal.auto_approved"
    | "proposal.removed"
    | "approval.recorded"
    | "execution.simulated"
    | "execution.executed"
    | "execution.failed"
    | "execution.idempotent_replay"
    | "lab_member.upserted"
    | "paper.upserted"
    | "paper.deleted"
    | "settings.updated"
    | "auth.login_succeeded"
    | "auth.login_failed"
    | "auth.rate_limited"
    | "auth.logged_out"
    | "auth.password_changed"
    | "auth.email_changed"
    | "auth.registration_submitted"
    | "auth.registration_approved"
    | "auth.registration_rejected"
    | "auth.calendar_invite_sent"
    | "auth.calendar_invite_failed"
    | "member_nudge.sent";
  timestamp: string;
  actor?: string;
  details?: Record<string, unknown>;
};

// Per-member credential row. `password_scrypt` is the serialized scrypt string
// (`scrypt$N$r$p$salt$hash`), never a plaintext or reversible secret.
export type AdminBotMemberCredential = {
  member_id: string;
  email: string;
  password_scrypt: string;
  claimed_at: string;
  updated_at: string;
};

export const adminBotRegistrationKinds = ["claim", "signup"] as const;

export type AdminBotRegistrationKind = (typeof adminBotRegistrationKinds)[number];

export const adminBotRegistrationStatuses = ["pending", "approved", "rejected"] as const;

export type AdminBotRegistrationStatus = (typeof adminBotRegistrationStatuses)[number];

// Pending account request awaiting admin decision. `member_id` is set for `claim`
// (an existing roster profile); `profile_json` carries the proposed member fields for `signup`.
// `password_scrypt` is the serialized scrypt string, copied into a credential only on approval.
export type AdminBotAccountRegistration = {
  id: string;
  kind: AdminBotRegistrationKind;
  member_id?: string;
  email: string;
  password_scrypt: string;
  profile_json?: string;
  status: AdminBotRegistrationStatus;
  created_at: string;
  decided_at?: string;
  decided_by?: string;
};

// Session row. Only the sha256 hex of the raw token is persisted (`token_hash`);
// the raw token lives solely in the caller's cookie/bearer header.
export type AdminBotAuthSession = {
  token_hash: string;
  member_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at?: string;
};

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
] as const;

export type AdminBotActionType = (typeof adminBotActionTypes)[number];

export type AdminBotEvidencePointer = {
  source: string;
  id?: string;
  url?: string;
  snippet?: string;
  hash?: string;
};

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

export type AdminBotMemberOnboardingStep = {
  id: string;
  label: string;
  status: AdminBotMemberOnboardingStepStatus;
  detail?: string;
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
  default_privilege_level?: AdminBotPrivilegeLevel;
  paper_escalation_business_days?: number;
  head_professor_member_id?: string;
};

export type AdminBotSettings = {
  default_privilege_level: AdminBotPrivilegeLevel;
  paper_escalation_business_days: number;
  head_professor_member_id?: string;
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
    | "settings.updated";
  timestamp: string;
  actor?: string;
  details?: Record<string, unknown>;
};

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
  "openreview.nudge",
  "openreview.warning",
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
  "admin",
] as const;

export type AdminBotPrivilegeLevel = (typeof adminBotPrivilegeLevels)[number];

// Subgroups an `external_collaborator` can be sorted into, ordered least- to most-engaged. Each
// one carries its own access-item matrix (collaborator-subgroups.ts). `alumni` here is a
// collaboration shape, unrelated to the member *status* of the same name.
export const adminBotExternalCollaboratorSubgroups = [
  "interviewee",
  "slightly_better_than_emails",
  "acquaintance",
  "alumni",
  "coauthor_minor",
  "coauthor_major",
  "disappearing_coauthor",
  "external_prof",
] as const;

export type AdminBotExternalCollaboratorSubgroup =
  (typeof adminBotExternalCollaboratorSubgroups)[number];

export type AdminBotAccessGrant = {
  service: string;
  access: "none" | "view" | "comment" | "edit" | "admin";
  scope?: string;
};

// The roles a person picks for themselves when they ask for an account. Free text on the record
// rather than an enum: 158 imported profiles predate this list and several carry shapes it does
// not cover ("PhD Mentee / MSc"), so the service keeps accepting any string and this is the
// vocabulary the forms offer. Distinct from privilege_level, which is what someone may do rather
// than what they are — an external collaborator can hold any privilege the lab grants them.
export const adminBotMemberRoles = [
  "Undergraduate Student",
  "Master's Student",
  "PhD Student",
  "Postdoc",
  "Research Assistant",
  "Research Intern",
  "Professor",
  "Industry Researcher",
  "External Collaborator",
  "Lab Manager",
  "Other",
] as const;

export type AdminBotMemberRole = (typeof adminBotMemberRoles)[number];

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

// One scannable point in a step. `points` nests a second level so a long instruction becomes a
// short lead line plus its details, instead of a paragraph wearing a bullet.
export type AdminBotMemberOnboardingBullet = {
  text: string;
  points?: string[];
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
  bullets?: AdminBotMemberOnboardingBullet[];
  // Clickable buttons (social pages, docs, application forms) shown below the text.
  links?: AdminBotMemberOnboardingLink[];
  required: boolean;
  // Set when the member clicks "I've read this". Acknowledgement is what completes a step: the
  // checklist is reading material, so nothing else can tell us they have actually read it.
  acknowledged_at?: string;
};

export type AdminBotMemberOnboarding = {
  current_step?: AdminBotMemberOnboardingStep;
  completed: AdminBotMemberOnboardingStep[];
  remaining: AdminBotMemberOnboardingStep[];
  steps: AdminBotMemberOnboardingStep[];
};
export const adminBotTimeOffKinds = [
  "vacation",
  "internship",
  "course_load",
  "travel",
  "conference",
  "other",
] as const;

export type AdminBotTimeOffKind = (typeof adminBotTimeOffKinds)[number];

// Reserved project name for hours a member has explicitly declared as spare
// capacity ("can take on something new / help others"). It is a sentinel, not a
// real project, so it never earns a categorical colour slot in the charts and
// never appears in the member's own `projects` list.
export const ADMINBOT_OPEN_PROJECT = "__open__";

// The Google account the availability importer reads planning docs as, so a member has to share
// their doc with it (Viewer is enough) or the import silently finds nothing. Must stay in step with
// the account `scripts/adminbot-drive-download.ts` downloads with; the UI shows this same value so
// the instruction can never drift from the account actually doing the reading.
export const ADMINBOT_DRIVE_ACCOUNT = "jinesis.adminbot@gmail.com";

// One allocation of weekly hours over a date range. The same shape covers both
// horizons: a near-term entry is a one-week row with a project set, a term
// baseline is a long row with `project` omitted. Keeping them one type is what
// lets the form, the validator, and the timeline renderer stay single-path.
export type AdminBotAvailabilityRow = {
  id?: string;
  start: string;
  end: string;
  project?: string;
  hours_per_week: number;
  note?: string;
  color?: string;
};

export type AdminBotTimeOffRow = {
  start: string;
  end: string;
  kind: AdminBotTimeOffKind;
  // "partial" still counts toward capacity at a reduced rate; "none" zeroes the
  // week. Callers must not infer this from `kind` — a conference can be either.
  availability: "none" | "partial";
  note?: string;
};

export type AdminBotLabMemberInput = {
  id: string;
  name: string;
  email?: string;
  slack_user_id?: string;
  privilege_level?: AdminBotPrivilegeLevel;
  // Which kind of external collaborator this person is, which decides the access items they get.
  // Only meaningful while `privilege_level` is "external_collaborator"; governance-owned like
  // `privilege_level`, so a member self-edit can never set it.
  collaborator_subgroup?: AdminBotExternalCollaboratorSubgroup;
  access_overrides?: AdminBotAccessGrant[];
  notes?: string;
  role?: string;
  status?: AdminBotMemberStatus;
  research_branch?: string;
  research_topics?: string[];
  projects?: string[];
  hours_per_week?: number;
  location?: string;
  affiliation?: string;
  timezone?: string;
  personal_website?: string;
  // OpenReview tilde id (e.g. "~Jane_Doe1"). First-class rather than buried in `notes`
  // because the reviewing-cycle automation maps OpenReview profiles back to members
  // with it, and posts assignment edges against it.
  openreview_id?: string;
  // Never propose or assign this person as an emergency reviewer, whatever their topic
  // match. Governance-owned: it encodes a standing commitment about someone's time, so
  // it is deliberately absent from the fields a member may edit on their own profile.
  reviewer_exempt?: boolean;
  // Last location read from this person's Slack profile, stamped by the member-map
  // refresh. Kept apart from `location` so the two sources never overwrite each other:
  // `location` is what they told us when they joined, this is what Slack knows now.
  slack_location?: string;
  slack_location_updated_at?: string;
  // Coarse (country-level) location derived from the IP address of this person's most recent
  // successful login, via IP geolocation (see ip-geolocation.ts). Distinct from `location` and
  // `slack_location`, which are both self-reported: this one is inferred, so it is never taken
  // as an input and never overwrites either — it is only ever set by the login path itself.
  last_login_at?: string;
  last_login_country?: string;
  last_login_continent?: string;
  availability?: AdminBotAvailabilityRow[];
  time_off?: AdminBotTimeOffRow[];
  // Link to the member's own planning doc in Drive, which the availability importer reads to
  // prefill the rows above. Member-owned and self-editable: whatever the importer gets wrong, the
  // member fixes in the same panel.
  availability_doc_url?: string;
  // Stamped server-side on every write that touches availability/time_off, so
  // the UI can show staleness without diffing payloads.
  availability_updated_at?: string;
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
  // Contact number the onboarding "what to expect" note hands to direct mentees. Governance
  // config rather than a repo constant: it is a real phone number, so it never belongs in the
  // source tree, and /settings is admin-gated on read as well as write.
  head_professor_whatsapp?: string;
  applicant_sheet_id?: string;
  applicant_last_reviewed_at?: string;
};

export type AdminBotSettings = {
  paper_escalation_business_days: number;
  head_professor_member_id?: string;
  head_professor_whatsapp?: string;
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
  // Member who filed this paper themselves. Set by the service on a member-authored create, never
  // accepted from request input, and it is one of the two ways a member is recognized as an owner
  // allowed to edit the record (the other is being named in `authors`).
  submitted_by_member_id?: string;
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

// --- OpenReview reviewing cycles ---

export const adminBotOpenReviewRoles = ["reviewer", "ac", "sac"] as const;

export type AdminBotOpenReviewRole = (typeof adminBotOpenReviewRoles)[number];

// One reviewing cycle: a venue plus the role being served there. The same venue can
// appear twice (an SAC who also reviews), and the two are chased independently.
export type AdminBotOpenReviewCycleRecord = {
  venue_id: string;
  role: AdminBotOpenReviewRole;
  title: string;
  deadline_ms: number;
  cycle_start_ms?: number;
  discovered_at: string;
  updated_at: string;
  // Latest missing-review snapshot, refreshed each run so the UI has something to
  // show between runs without re-querying OpenReview.
  papers_total?: number;
  reviews_missing?: number;
  last_error?: string;
};

export type AdminBotOpenReviewMilestoneStatus =
  | "sent"
  | "dry_run"
  | "proposed"
  | "blocked"
  | "skipped";

// Firing history, one row per milestone per cycle. The (venue_id, role, milestone_key)
// uniqueness is what makes the automation idempotent: a milestone with a row here is
// never sent again, whatever restarts or double-triggers happen.
export type AdminBotOpenReviewMilestoneRecord = {
  venue_id: string;
  role: AdminBotOpenReviewRole;
  milestone_key: string;
  fired_at: string;
  status: AdminBotOpenReviewMilestoneStatus;
  recipients: number;
  detail?: string;
};

// The `proposed_payload` an `email.draft`, `email.send`, or email-channel `member_nudge.send`
// carries. `proposed_payload` on a proposal stays `unknown` -- the broker is type-agnostic and the
// gog executor validates what it reads -- so this is the written-down shape of what that executor
// accepts, and what an approver is approving.
//
// `body_html` is additive and optional: `body` remains the canonical copy and the only required
// one, so every payload written before this field existed is still valid and still sends. When it
// is present the executor adds an HTML alternative to the same message; it is part of the approved
// payload (and therefore of `payload_hash`), so an approval can never be re-used for different
// markup than it was granted for.
export type AdminBotEmailPayload = {
  to: string | string[];
  subject: string;
  body: string;
  body_html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string;
  account?: string;
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
    | "onboarding.guide_sent"
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
    | "auth.approval_email_sent"
    | "auth.approval_email_failed"
    | "member_nudge.sent"
    | "onboarding.step_updated"
    | "reimbursement.anonymous_use"
    | "openreview.cycle_run"
    | "openreview.milestone_sent"
    | "openreview.milestone_blocked"
    | "openreview.assignment_changed"
    | "member_map.refreshed"
    | "auth.login_location_updated";
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

import type { GatewayBrowserClient } from "../../gateway.ts";
import type { UiSettings } from "../../storage.ts";
// Control UI controller for the AdminBot dashboard surface.
import {
  type CalendarEvent,
  type CalendarEventDraft,
  type LabCalendar,
  type LocationDrift,
  type MeetingRecord,
  type MeetingAttendanceNudgePreview,
  type MeetingAttendanceNudgeResult,
  type MemberNotification,
  type MemberNudgeChannel,
  type MemberProfileUpdate,
  type MemberScheduleUpdate,
  approveActionAsMember,
  applyOwnPolishedProfilePhoto,
  executeActionAsMember,
  removePendingAction,
  fetchMemberResource,
  loadStoredMemberSession,
  cancelWorkshopNudges,
  previewWorkshopNudges,
  refreshWorkshopNudges,
  polishOwnProfilePhoto,
  resolveAdminBotBaseUrl,
  saveOwnPaper,
  fetchVenueSources,
  rebuildVenueIndexes,
  publishCvDigest,
  searchVenuePapers,
  sendMemberNudge,
  sendWorkshopNudges,
  deleteOwnPaper,
  updateOwnProfile,
  updateSettingsAsAdmin,
  updateOwnSchedule,
  mergeLabMembersAsAdmin,
  upsertLabMemberAsAdmin,
} from "../auth/session.ts";
import type { AvailabilityRow, MilestoneRow, TimeOffRow, TripRow } from "../data/availability.js";
import { loadMemberMap, type MemberMap } from "../data/member-map.ts";
import { papersWithUnread, seenSaveInput } from "../nudge-alerts.ts";

export type AdminBotPrivilegeLevel = "external_collaborator" | "trial" | "member" | "admin";

// Mirrors `adminBotExternalCollaboratorSubgroups` in extensions/adminbot/src/contracts/actions.ts. Copied
// rather than imported for the same reason as AdminBotPrivilegeLevel above: the Control UI does not
// reach across the extensions boundary. Only meaningful while privilege_level is
// "external_collaborator" — the service rejects it on any other level and clears it on promotion.
export type AdminBotExternalCollaboratorSubgroup =
  | "interviewee"
  | "slightly_better_than_emails"
  | "acquaintance"
  | "alumni"
  | "coauthor_minor"
  | "coauthor_major"
  | "disappearing_coauthor"
  | "external_prof";

export type AdminBotAccessGrant = {
  service: string;
  access: "none" | "view" | "comment" | "edit" | "admin";
  scope?: string;
};

export type AdminBotMemberStatus = "active" | "part_time" | "on_leave" | "alumni" | "external";

export type AdminBotLabMember = {
  id: string;
  name: string;
  email?: string;
  slack_user_id?: string;
  notes?: string;
  privilege_level: AdminBotPrivilegeLevel;
  collaborator_subgroup?: AdminBotExternalCollaboratorSubgroup;
  access: AdminBotAccessGrant[];
  role?: string;
  status?: AdminBotMemberStatus;
  research_branch?: string;
  research_topics?: string[];
  projects?: string[];
  hours_per_week?: number;
  availability?: AvailabilityRow[];
  time_off?: TimeOffRow[];
  milestones?: MilestoneRow[];
  trips?: TripRow[];
  dismissed_deadlines?: string[];
  // The member's own prose about their schedule, for the admins who plan around it. Absent on
  // every roster copy but the member's own and an admin's -- the service strips it for everyone
  // else (adminBotScheduleMemberFields), same as the three lists above.
  availability_notes?: string;
  location?: string;
  // Where they are right now, when that is not `location`. The Calendar tab filters on both, and
  // never lets one stand in for the other.
  current_city?: string;
  affiliation?: string;
  timezone?: string;
  // What the member wrote in their Slack profile. Free text and often not a place at all, so it
  // is the last thing the Calendar tab falls back to when resolving somebody's clock.
  slack_location?: string;
  // Inferred from the IP of the last sign-in, never self-reported and never written back to the
  // fields above. Read only together: a city with no timestamp says nothing about where someone
  // is now, which is the only question the Calendar tab asks it.
  last_login_at?: string;
  last_login_city?: string;
  last_login_timezone?: string;
  personal_website?: string;
  // Link to the member's own CV PDF, self-editable like the availability planning doc. The scan
  // reads it; the console never renders its contents, only what changed.
  cv_url?: string;
  calendar_email?: string;
  correspondence_email?: string;
  github_url?: string;
  joined_month?: string;
  whatsapp?: string;
  // Self-attested checklist state (see extensions/adminbot/src/workflows/onboarding/onboarding.ts); the dashboard
  // only reads step id + status to preselect nudge recipients.
  onboarding?: { steps?: Array<{ id: string; status: string }> } | null;
  created_at: string;
  updated_at: string;
};

/**
 * A member's stored topics as the one string the interests box shows.
 *
 * Mirrors `interestsFromTopics` in the service's venue-relevance.ts; ui/ cannot import from
 * extensions/. Kept in step because what the box shows has to be exactly what gets embedded.
 */
function interestsFromTopics(topics: readonly string[] | undefined): string {
  return (topics ?? [])
    .map((topic) => topic.trim())
    .filter(Boolean)
    .join(", ");
}

/** A conference an admin has made searchable. Mirrors the service contract. */
export type AdminBotVenueSource = {
  /** OpenReview group id, e.g. "ICLR.cc/2025/Conference". */
  id: string;
  /** What a member sees in the picker, e.g. "ICLR 2025". */
  label: string;
};

/** One conference a member can search, and how fresh its index is. */
export type AdminBotVenueSourceView = {
  venue_id: string;
  label: string;
  paper_count: number;
  indexed_at?: string;
  embedding_model?: string;
};

export type AdminBotVenuePaperHit = {
  paper: {
    id: string;
    title: string;
    abstract: string;
    keywords: string[];
    venue: string;
    pdf_url?: string;
    forum_url: string;
  };
  score: number;
  /** 1 is the best match in this conference for this search, 0 the median one. */
  relevance: number;
  matched_keywords: string[];
};

export type AdminBotVenueSearchResult = {
  venue_id: string;
  label: string;
  /** How many accepted papers were ranked, so "12 of 3,704" is answerable. */
  searched: number;
  results: AdminBotVenuePaperHit[];
  /** The conference was searched and nothing in it was close to these interests. */
  nothing_relevant: boolean;
};

export type AdminBotVenuePapersState = {
  sources: AdminBotVenueSourceView[];
  loadingSources: boolean;
  venueId: string;
  /** Free text, prefilled from the member's own research_topics and editable per search. */
  interests: string;
  /** False until the member edits the box, so a prefill can be refreshed and an edit cannot. */
  interestsTouched: boolean;
  searching: boolean;
  error: string | null;
  result: AdminBotVenueSearchResult | null;
  /** Which result rows have their abstract open. */
  expanded: string[];
};

export function createEmptyVenuePapersState(): AdminBotVenuePapersState {
  return {
    sources: [],
    loadingSources: false,
    venueId: "",
    interests: "",
    interestsTouched: false,
    searching: false,
    error: null,
    result: null,
    expanded: [],
  };
}

export type WorkshopNudgeRecommendation = {
  pair_id: string;
  final_rank?: number;
  match_rationale: string;
  topic_relevance: number;
  topic_evidence: string[];
  rank_explanation: string;
  draft_fragment?: string;
  paper: {
    paper_id: string;
    title: string;
    year?: number;
    current_submission_state?: string;
    publication_sources: string[];
    recipient_display_name?: string;
  };
  workshop: {
    workshop_id: string;
    name: string;
    parent_conference_key: string;
    parent_conference: string;
    conference_location: string;
    topics: string[];
    archival_status: "archival" | "non_archival" | "mixed" | "unknown";
    cross_submission_status: "allowed" | "prohibited" | "unclear";
    cross_submission_evidence: string;
    cross_submission_source_url: string;
    profile_extracted_at: string;
    routes: Array<{
      deadline_id: string;
      label: string;
      submission_type: string;
      deadline_aoe: string;
      source_url: string;
    }>;
  };
  attendance?: {
    attendance_likelihood?: number;
    source: string;
    last_confirmed_at: string;
  };
};

export type WorkshopNudgeResult = {
  generated_at: string;
  paper_count: number;
  workshop_count: number;
  recipients: Array<{
    recipient_member_id: string;
    recipient_display_name?: string;
    delivery_ready: boolean;
    delivery_blocked_reason?: string;
    recommendations: WorkshopNudgeRecommendation[];
    draft: {
      text: string;
      pair_ids: string[];
      recommendations: WorkshopNudgeRecommendation[];
    } | null;
  }>;
  unresolved_recipients: Array<{
    paper: WorkshopNudgeRecommendation["paper"];
    recommendations: WorkshopNudgeRecommendation[];
  }>;
  coverage: {
    members_without_usable_papers: Array<{ member_id: string; name: string }>;
    papers_with_unresolved_authors: Array<{
      paper_id: string;
      title: string;
      author_names: string[];
    }>;
    papers_without_active_recipients: Array<{ paper_id: string; title: string }>;
  };
};

export type WorkshopNudgeReviewState = {
  loading: boolean;
  sending: boolean;
  error: string | null;
  result: WorkshopNudgeResult | null;
  selectedRecipientIds: string[];
  view: WorkshopNudgeViewState;
  /**
   * The stored pass this page is showing, and whether a newer one is being produced.
   *
   * The match is thousands of model calls and tens of minutes, so it no longer runs inside the
   * request that asks for it: a pass is started on command, runs to completion server-side, and
   * writes its answer. Opening the page reads that answer.
   */
  run: WorkshopNudgeRunView | null;
};

export type WorkshopNudgeRunView = {
  status: "none" | "running" | "ready" | "failed";
  started_at?: string;
  finished_at?: string;
  started_by?: string;
  calls_done?: number;
  calls_total?: number;
  /**
   * How many of `calls_done` gave up rather than answered.
   *
   * Defaulted at the fetch boundary, because a service older than this field sends nothing and the
   * page would otherwise render "undefined calls failed" for as long as Vercel is ahead of Aurora.
   */
  calls_failed?: number;
  error?: string;
  preview?: WorkshopNudgeResult;
};

export type WorkshopNudgeViewState = {
  tab: "recipients" | "unresolved";
  query: string;
  recipientFilter: "all" | "ready" | "missing_slack" | "no_match";
  page: number;
  detailKey: string | null;
};

export type WorkshopNudgeViewPatch = Partial<WorkshopNudgeViewState>;

export function createEmptyWorkshopNudgeReviewState(): WorkshopNudgeReviewState {
  return {
    loading: false,
    sending: false,
    error: null,
    result: null,
    run: null,
    selectedRecipientIds: [],
    view: {
      tab: "recipients",
      query: "",
      recipientFilter: "all",
      page: 0,
      detailKey: null,
    },
  };
}

export type AdminBotCvDigestJobStatus = "idle" | "running" | "ok" | "error";

export type AdminBotCvDigestJobState = {
  status: AdminBotCvDigestJobStatus;
  detail?: string;
  resultUrl?: string;
  finishedAtMs?: number;
};

/** What POST /cv/publish-digest answers with. Mirrors the service; ui/ cannot import extensions/. */
export type AdminBotCvDigestPublishResult = {
  document_url: string;
  published_at: string;
  day_count: number;
  change_count: number;
};

export type AdminBotSettings = {
  paper_escalation_business_days: number;
  cv_recency_window_months: number;
  head_professor_member_id?: string;
  head_professor_whatsapp?: string;
  applicant_sheet_id?: string;
  applicant_last_reviewed_at?: string;
  /** Recordings shorter than this are filed but not listed on the Meeting Recordings tab. */
  meeting_minimum_minutes?: number;
  venue_sources?: AdminBotVenueSource[];
  updated_at: string;
};

export type AdminBotSensitiveInfoRecord = {
  markdown: string;
  path?: string;
};

export type AdminBotLabMemberSaveInput = {
  id: string;
  name: string;
  email?: string;
  slackUserId?: string;
  privilegeLevel?: AdminBotPrivilegeLevel;
  collaboratorSubgroup?: AdminBotExternalCollaboratorSubgroup;
  notes?: string;
  status?: AdminBotMemberStatus;
  /**
   * Every profile field the roster editor collected, already in the service's wire shape.
   *
   * One bag rather than a camelCase key per field, and this is the change that keeps the Lab
   * Members editor and the Profile page in step: both render from the shared member field
   * registry (ui/src/ui/adminbot/member-fields.ts), whose keys *are* the wire names, so a new
   * field needs no entry here and no line in `adminMemberUpdatePayload`. The previous shape
   * named fifteen fields in camelCase and mapped each one back by hand, which is how the editor
   * came to be missing eleven of the fields the profile page already had.
   *
   * Governance stays above, spelled out: privilege, status, email and the collaborator subgroup
   * are not profile facts, only an admin session may write them, and they should be visible in
   * this type rather than hidden inside a generic bag.
   *
   * No `availability` in here either way. The stored schedule is a list of rows the service
   * validates as one (validateAvailability in extensions/adminbot/src/kernel/service.ts), written
   * from the Time Availability tab; this form has no schedule control at all. It used to carry a
   * free-text `availability` string, which every save sent as "" and the service rejected with
   * 400 "member availability must be a list" — the whole edit lost to a field nobody could see.
   */
  profile?: Record<string, unknown>;
};

export type AdminBotPaperSaveInput = {
  id: string;
  title: string;
  authors: string[];
  /** Names of people asked to read the draft. Sent whole; the service trims and de-blanks. */
  feedbackGivers?: string[];
  /** What each author does on the paper. Sent whole; "" clears it. */
  authorRoles?: string;
  /** The author list as people. Sent whole; the service regenerates `authors` from it. */
  authorLinks?: Array<{ name: string; member_id?: string; email?: string }>;
  /**
   * Where the paper is aimed. This is the record's own `venue` field, not `artifacts.conference`:
   * `venue` is what the stage nudges quote and the deadline board matches on, and having two
   * places to write the same answer is how they came to disagree.
   */
  venue?: string;
  currentStep: AdminBotPaperStep;
  // Artifact links. Only the two below were ever settable from the per-paper card; the rest
  // arrived with the bulk grid, which edits every link slot at once. The service already
  // accepts a whole `artifacts` object (OWN_PAPER_EDITABLE_FIELDS), so widening this type is
  // the entire change -- without it the grid would silently drop most of what was typed.
  overleafEditUrl?: string;
  overleafViewUrl?: string;
  brainstormingDocUrl?: string;
  submissionUrl?: string;
  googleDrivePdfUrl?: string;
  arxivUrl?: string;
  googleSlidesUrl?: string;
  posterUrl?: string;
  /**
   * Conference pre-registration, JSON-encoded. See venue-targets.ts for the shape and for why it
   * lives in `artifacts` rather than a column: the service merges that map on write, so this
   * needs no schema change and becomes a backfill once the table exists.
   */
  venueTargets?: string;
  /**
   * Stamp saying which decision the author has already been shown, so the popup never reopens on
   * one they have answered. Keyed on the decision rather than a bare flag: a rejected paper that
   * is resubmitted gets a second decision, and that one deserves telling too.
   */
  decisionSeen?: string;
  conference?: string;
  /** How likely the authors think this venue is, as a percentage string. */
  confidence?: string;
  /**
   * ISO timestamp of when the paper was presented and closed out, or "" to reopen it. See
   * paper-completion.ts: it lives in `artifacts` for the same reason `venueTargets` does.
   */
  completedAt?: string;
  /** One live blocker per paper, stored on the record so admins can see and sort it. */
  blockerLog?: string;
  /** In-app nudge alert, written by an admin and cleared by the member who reads it. */
  nudgeLog?: string;
  nudgeSeenAt?: string;
  topic?: string;
  reminderStatus?: "idle" | "waiting_on_authors" | "blocked" | "complete";
  // What the venue said, and the four details the conference branch needs once it said yes. Sent
  // as strings because they come straight off form controls; the service parses and validates.
  venueDecision?: string;
  acceptedVenue?: string;
  acceptedYear?: string;
  isArchival?: string;
  presentationType?: string;
};

export type AdminBotSettingsSaveInput = {
  paper_escalation_business_days?: number;
  meeting_minimum_minutes?: number;
  cv_recency_window_months?: number;
  head_professor_member_id?: string;
  head_professor_whatsapp?: string;
  applicant_sheet_id?: string;
  applicant_last_reviewed_at?: string;
  venue_sources?: AdminBotVenueSource[];
};

export type AdminBotPaperStep =
  | "brainstorming_docs"
  | "overleaf_writing"
  | "submission"
  | "google_drive_pdf"
  | "arxiv_polish"
  | "social_posts"
  | "slide_making"
  | "poster_making";
export type AdminBotPaperTimelineItem = {
  step: AdminBotPaperStep;
  label: string;
  dependency_group: string;
  depends_on: AdminBotPaperStep[];
  status: "complete" | "current" | "upcoming" | "blocked";
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

export type AdminBotPaperRecord = {
  id: string;
  title: string;
  /** In the order the paper prints them. Order decides who the PaperFlow stage nudges go to. */
  authors: string[];
  /** People asked to read the draft. Not authors, and not the social consent list. */
  feedback_givers?: string[];
  /** What each author does on the paper, in prose. Free text; see the record contract. */
  author_roles?: string;
  /**
   * The author list with each entry linked to whoever it names -- a roster id for a lab member, an
   * email for somebody who is not on the roster. This is what decides whose My Projects page the
   * paper appears on; `authors` above is only how the paper spells the names.
   */
  author_links?: Array<{ name: string; member_id?: string; email?: string }>;
  current_step: AdminBotPaperStep;
  // Governance fields the service owns. Mirrored here so a card can show the venue and its
  // deadline without a second read; nothing in the UI writes them.
  first_author_member_id?: string;
  venue?: string;
  deadline?: string;
  venue_decision?: "pending" | "accept" | "reject";
  attempt?: number;
  dormant_override?: boolean;
  accepted_venue?: string;
  accepted_year?: number;
  is_archival?: boolean;
  presentation_type?: string;
  artifacts?: Record<string, string | undefined>;
  mentor_member_id?: string;
  checks?: Record<string, boolean | undefined>;
  reminder?: {
    status?: string;
    requested_step_at?: string;
    last_author_dm_at?: string;
    last_author_reply_at?: string;
    next_nudge_at?: string;
    escalation_after_business_days?: number;
    head_professor_member_id?: string;
  };
  notes?: string;
  // Set by the service when a member files a paper themselves; one of the signals that lets the
  // UI offer them the edit form.
  submitted_by_member_id?: string;
  timeline?: AdminBotPaperTimeline;
  created_at: string;
  updated_at: string;
};

export type AdminBotActionProposal = {
  id: string;
  type: string;
  risk_tier: "T0" | "T1" | "T2" | "T3" | "T4";
  summary: string;
  status: "pending" | "approved" | "executed" | "rejected";
  payload_hash: string;
  approval_requirement: {
    requires_approval: boolean;
    approver_roles: string[];
    min_approvals: number;
  };
  approvals: Array<{ approver_role: string; approver_id?: string; note?: string }>;
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

export type AdminBotExecutionResult = {
  action_id: string;
  status: "simulated" | "executed";
  dry_run: boolean;
  idempotency_key?: string;
  executed_at: string;
};

export type AdminBotReimbursementArtifact = {
  filename: string;
  media_type: string;
  data_base64: string;
};

export type AdminBotReimbursementState = {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  draft: Record<string, unknown>;
  missingFields: string[];
  receiptNames: string[];
  ready: boolean;
  busy: boolean;
  error: string | null;
  artifacts: AdminBotReimbursementArtifact[];
};

export type AdminBotDashboardData = {
  proposals: AdminBotActionProposal[];
  members: AdminBotLabMember[];
  papers: AdminBotPaperRecord[];
  nudges: AdminBotPaperNudge[];
  settings: AdminBotSettings | null;
  sensitiveInfo: AdminBotSensitiveInfoRecord | null;
  loadedAt: number | null;
};

// Draft state for the "Announcements" compose form (member_nudge.send): channel + message text
// plus which members are currently checked. Filtering the recipient table stays pure client-side
// DOM hide/show (same pattern as the Lab Members and Papers filter forms); only the checked
// selection itself needs to survive across filter changes and re-renders, hence state here.
export type AdminBotMemberNudgeState = {
  channel: MemberNudgeChannel;
  message: string;
  subject: string;
  selectedMemberIds: string[];
  busy: boolean;
};

// The guest flow runs before any gateway connection exists, so it needs only the reimbursement
// slice of the host plus the resolved AdminBot origin -- deliberately not the full AdminBotHost,
// which would imply a client/session this path does not have.
export type GuestReimbursementHost = {
  adminBotReimbursement: AdminBotReimbursementState;
  guestReimbursementBaseUrl: string;
};

export type AdminBotHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  // The dashboard's member-map card, loaded alongside the roster. See data/member-map.ts.
  adminBotMemberMap: MemberMap | null;
  adminBotMemberMapLoading: boolean;
  adminBotLoading: boolean;
  adminBotError: string | null;
  adminBotData: AdminBotDashboardData;
  adminBotBusyActionId: string | null;
  adminBotNotice: { kind: "success" | "error"; text: string } | null;
  adminBotPhotoPolishBusy: boolean;
  adminBotPhotoApplyBusy: boolean;
  adminBotReimbursement: AdminBotReimbursementState;
  adminBotMemberNudge: AdminBotMemberNudgeState;
  // Last press of the CV digest job. Session-scoped: the durable record of a run is the audit
  // row and the document it wrote, so this only has to survive long enough to report the outcome.
  adminBotCvDigestJob: AdminBotCvDigestJobState;
  adminBotVenuePapers: AdminBotVenuePapersState;
  adminBotWorkshopNudges: WorkshopNudgeReviewState;
  adminBotVenueIndexJob: AdminBotCvDigestJobState;
  // The viewer's own roster id, for prefilling their interests from their profile. Null under
  // break-glass gateway access, where there is no "me" to read topics from.
  memberId: string | null;
  // Calendar tab. Written by controllers/calendar.ts, which shares this host rather than owning a
  // second one: the invite half reads the same roster and papers the rest of the tab loaded.
  calendarEvents?: CalendarEvent[];
  calendarEventsLoading?: boolean;
  calendarEventsError?: string | null;
  calendarPrompt?: string;
  calendarDraft?: CalendarEventDraft | null;
  calendarDraftBusy?: boolean;
  calendarDraftError?: string | null;
  calendarBusy?: boolean;
  // The event the prompt box is editing, when it is editing one rather than composing a new event.
  calendarEditingEventId?: string | null;
  // Which calendar the service read, so the tab embeds and writes to the same one.
  calendarSource?: LabCalendar | null;
  calendarMonth?: string;
  calendarOpenDay?: string | null;
  calendarOpenEventId?: string | null;
  calendarMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  // Meeting Recordings tab. Written by controllers/meetings.ts, which shares this host so the
  // attendance editor can read the roster the dashboard already loaded.
  adminBotMeetings?: MeetingRecord[];
  // The "have you moved?" banner. Undefined is "not asked yet", null is "nothing to ask".
  adminBotLocationDrift?: LocationDrift | null;
  // The admin-side list, keyed by member on the calendar's invite panel.
  adminBotLocationDrifts?: LocationDrift[];
  adminBotLocationSaving?: boolean;
  adminBotLocationError?: string | null;
  adminBotMeetingsLoading: boolean;
  adminBotMeetingsSaving: boolean;
  adminBotMeetingsError: string | null;
  // The attendance nudge an admin previews and sends from the Meeting Recordings tab.
  adminBotMeetingNudgePreview?: MeetingAttendanceNudgePreview | null;
  adminBotMeetingNudgeBusy?: boolean;
  adminBotMeetingNudgeError?: string | null;
  adminBotMeetingNudgeResult?: MeetingAttendanceNudgeResult | null;
  // What the lab has told this member. Undefined is "not read yet"; [] is a real "nothing".
  adminBotNotifications?: MemberNotification[];
  adminBotNotificationsError?: string | null;
  // Needed to resolve the AdminBot HTTP base URL for the direct admin-write path in
  // saveAdminBotMember — see the comment there for why this bypasses the gateway tool.
  settings: UiSettings;
};

export type AdminBotLoadMode = "admin" | "general";

export function createEmptyAdminBotReimbursementState(): AdminBotReimbursementState {
  return {
    messages: [],
    draft: {},
    missingFields: [],
    receiptNames: [],
    ready: false,
    busy: false,
    error: null,
    artifacts: [],
  };
}

export function createEmptyAdminBotMemberNudgeState(): AdminBotMemberNudgeState {
  return {
    channel: "slack",
    message: "",
    subject: "",
    selectedMemberIds: [],
    busy: false,
  };
}

type ToolsInvokeResult = {
  ok: boolean;
  toolName: string;
  output?: unknown;
  error?: { code: string; message: string };
};

export const ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE =
  "AdminBot tools are not available in this Gateway. Enable the adminbot plugin for the adminbot agent, then restart or reload OpenClaw.";

/**
 * What a failed request to the AdminBot service actually means.
 *
 * Distinct from the message above, which is about the *gateway* missing its tool plugin. Every
 * loader on this page that talks to the service over HTTP was reporting that one for `unreachable`
 * -- a fetch that threw -- so a workshop-nudge preview whose request never landed told an admin to
 * go and enable a plugin, which was never the problem and is not where the fix is.
 *
 * `unreachable` on these paths means the browser could not complete the request at all: the
 * service is down, the configured URL points somewhere else, or the call took long enough to be
 * cut off -- which the workshop matcher, running LLM calls across every open workshop, is the most
 * likely thing here to do.
 */
export const ADMINBOT_SERVICE_UNREACHABLE_MESSAGE =
  "Couldn't reach the AdminBot service. Check that it is running, that the AdminBot URL in Settings points at it, and — for a long pass like workshop matching — that the request had time to finish.";

export function createEmptyAdminBotDashboardData(): AdminBotDashboardData {
  return {
    proposals: [],
    members: [],
    papers: [],
    nudges: [],
    settings: null,
    sensitiveInfo: null,
    loadedAt: null,
  };
}

function adminBotUnavailableError(host: Pick<AdminBotHost, "connected" | "client">): string | null {
  if (!host.connected) {
    return "Gateway is not connected.";
  }
  if (!host.client) {
    return "Gateway client is not ready.";
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown, key: string): string | undefined {
  const record = readRecord(value);
  const raw = record[key];
  return typeof raw === "string" ? raw : undefined;
}

function unwrapAdminBotToolOutput(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  const record = readRecord(value);
  if (Object.hasOwn(record, "details") && record.details !== undefined) {
    return record.details;
  }
  if (Array.isArray(record.content)) {
    const textBlock = record.content.find(
      (entry) =>
        Boolean(entry) &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "text" &&
        typeof (entry as { text?: unknown }).text === "string",
    ) as { text?: string } | undefined;
    if (textBlock?.text) {
      try {
        return JSON.parse(textBlock.text);
      } catch {
        return textBlock.text;
      }
    }
  }
  return value;
}

function formatAdminBotToolError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/tool not available:\s*adminbot_/iu.test(message) || /unknown tool/iu.test(message)) {
    return ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE;
  }
  return message;
}

async function invokeAdminBotTool(
  host: AdminBotHost,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const unavailable = adminBotUnavailableError(host);
  if (unavailable) {
    throw new Error(unavailable);
  }
  const client = host.client;
  if (!client) {
    throw new Error("Gateway client is not ready.");
  }
  const response = await client.request<ToolsInvokeResult>("tools.invoke", {
    name,
    agentId: "adminbot",
    args,
  });
  if (!response.ok) {
    throw new Error(formatAdminBotToolError(response.error?.message ?? `${name} failed`));
  }
  return unwrapAdminBotToolOutput(response.output);
}

function readArray<T>(value: unknown, key: string): T[] {
  const record = readRecord(value);
  const raw = record[key];
  return Array.isArray(raw) ? (raw as T[]) : [];
}

// Dashboard read path for a signed-in member. Members and papers are the two surfaces every
// signed-in person may read, so a failure there is a real error; the privileged extras (pending
// queue, nudges, settings, sensitive info) are fetched best-effort and simply stay empty for a
// member whose session the server refuses them to.
async function loadAdminBotOverSession(
  host: AdminBotHost,
  mode: AdminBotLoadMode,
  session: { sessionToken: string; baseUrl: string },
): Promise<void> {
  host.adminBotLoading = true;
  host.adminBotError = null;
  const read = async (path: string): Promise<unknown> => {
    const result = await fetchMemberResource(path, session.sessionToken, session.baseUrl);
    if (!result.ok) {
      throw new Error(
        result.kind === "unreachable" ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE : result.kind,
      );
    }
    return result.value;
  };
  const optional = async (path: string): Promise<unknown> => {
    const result = await fetchMemberResource(path, session.sessionToken, session.baseUrl);
    return result.ok ? result.value : undefined;
  };
  try {
    const [members, papers] = await Promise.all([read("/lab/members"), read("/papers")]);
    if (mode === "general") {
      host.adminBotData = {
        ...createEmptyAdminBotDashboardData(),
        members: readArray<AdminBotLabMember>(members, "members"),
        papers: readArray<AdminBotPaperRecord>(papers, "papers"),
        loadedAt: Date.now(),
      };
      return;
    }
    const [pending, nudges, settings, sensitiveInfo] = await Promise.all([
      optional("/proposals/pending?limit=50"),
      optional("/papers/nudges"),
      optional("/settings"),
      optional("/sensitive-info"),
    ]);
    const settingsRecord = readRecord(settings);
    const sensitiveInfoRecord = readRecord(sensitiveInfo);
    const markdown = readString(sensitiveInfoRecord, "markdown");
    const filePath = readString(sensitiveInfoRecord, "path");
    host.adminBotData = {
      proposals: readArray<AdminBotActionProposal>(pending, "proposals"),
      members: readArray<AdminBotLabMember>(members, "members"),
      papers: readArray<AdminBotPaperRecord>(papers, "papers"),
      nudges: readArray<AdminBotPaperNudge>(nudges, "nudges"),
      settings:
        Object.keys(settingsRecord).length > 0 ? (settingsRecord as AdminBotSettings) : null,
      sensitiveInfo: markdown ? { markdown, ...(filePath ? { path: filePath } : {}) } : null,
      loadedAt: Date.now(),
    };
  } catch (err) {
    host.adminBotError = err instanceof Error ? err.message : String(err);
  } finally {
    host.adminBotLoading = false;
  }
}

export async function loadAdminBot(
  host: AdminBotHost,
  mode: AdminBotLoadMode = "admin",
): Promise<void> {
  // A signed-in member reads through their own session. The gateway tool path needs
  // operator.write, which a plain member's paired device deliberately does not hold, so for them
  // every tool call fails and the dashboard renders empty -- including after a successful save,
  // which is what made edits look like they never persisted.
  const stored = loadStoredMemberSession();
  if (stored) {
    await loadAdminBotOverSession(host, mode, {
      sessionToken: stored.sessionToken,
      baseUrl: resolveAdminBotBaseUrl(host.settings),
    });
    // Not awaited and never able to fail the load: the map is one dashboard card, and the roster
    // and papers above it are what the page is actually for.
    void loadMemberMap(host);
    return;
  }
  const unavailable = adminBotUnavailableError(host);
  if (unavailable) {
    host.adminBotError = unavailable;
    host.adminBotLoading = false;
    return;
  }
  host.adminBotLoading = true;
  host.adminBotError = null;
  try {
    if (mode === "general") {
      const [members, papers] = await Promise.all([
        invokeAdminBotTool(host, "adminbot_list_lab_members"),
        invokeAdminBotTool(host, "adminbot_list_papers"),
      ]);
      host.adminBotData = {
        ...createEmptyAdminBotDashboardData(),
        members: readArray<AdminBotLabMember>(members, "members"),
        papers: readArray<AdminBotPaperRecord>(papers, "papers"),
        loadedAt: Date.now(),
      };
      return;
    }
    const [
      pendingResult,
      membersResult,
      papersResult,
      nudgesResult,
      settingsResult,
      sensitiveResult,
    ] = await Promise.allSettled([
      invokeAdminBotTool(host, "adminbot_list_pending_actions", { limit: 50 }),
      invokeAdminBotTool(host, "adminbot_list_lab_members"),
      invokeAdminBotTool(host, "adminbot_list_papers"),
      invokeAdminBotTool(host, "adminbot_list_paper_nudges"),
      invokeAdminBotTool(host, "adminbot_get_settings"),
      invokeAdminBotTool(host, "adminbot_get_sensitive_info"),
    ]);
    const essentialFailures = [membersResult, papersResult].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (essentialFailures.length > 0) {
      throw essentialFailures[0].reason;
    }
    const pending = pendingResult.status === "fulfilled" ? pendingResult.value : undefined;
    const members = membersResult.status === "fulfilled" ? membersResult.value : undefined;
    const papers = papersResult.status === "fulfilled" ? papersResult.value : undefined;
    const nudges = nudgesResult.status === "fulfilled" ? nudgesResult.value : undefined;
    const settings = settingsResult.status === "fulfilled" ? settingsResult.value : undefined;
    const sensitiveInfo =
      sensitiveResult.status === "fulfilled" ? sensitiveResult.value : undefined;
    const settingsRecord = readRecord(settings);
    const sensitiveInfoRecord = readRecord(sensitiveInfo);
    const markdown = readString(sensitiveInfoRecord, "markdown");
    const filePath = readString(sensitiveInfoRecord, "path");
    host.adminBotData = {
      proposals: readArray<AdminBotActionProposal>(pending, "proposals"),
      members: readArray<AdminBotLabMember>(members, "members"),
      papers: readArray<AdminBotPaperRecord>(papers, "papers"),
      nudges: readArray<AdminBotPaperNudge>(nudges, "nudges"),
      settings:
        Object.keys(settingsRecord).length > 0 ? (settingsRecord as AdminBotSettings) : null,
      sensitiveInfo: markdown ? { markdown, ...(filePath ? { path: filePath } : {}) } : null,
      loadedAt: Date.now(),
    };
  } catch (err) {
    host.adminBotError = formatAdminBotToolError(err);
  } finally {
    host.adminBotLoading = false;
  }
}

function approvalFailureMessage(kind: string): string {
  if (kind === "unreachable") {
    return ADMINBOT_SERVICE_UNREACHABLE_MESSAGE;
  }
  if (kind === "forbidden") {
    return "Your session no longer has approval rights — sign in again and retry.";
  }
  if (kind === "rate-limited") {
    return "Too many attempts. Wait a moment and try again.";
  }
  return "Couldn't record this approval. Reload the pending list and try again.";
}

export async function approveAdminBotAction(
  host: AdminBotHost,
  proposal: AdminBotActionProposal,
): Promise<void> {
  host.adminBotBusyActionId = proposal.id;
  host.adminBotNotice = null;
  try {
    const session = requirePrivilegedSession(host);
    if (!session) {
      return;
    }
    const approved = await approveActionAsMember(
      proposal.id,
      proposal.payload_hash,
      session.sessionToken,
      session.baseUrl,
    );
    if (!approved.ok) {
      host.adminBotNotice = { kind: "error", text: approvalFailureMessage(approved.kind) };
      return;
    }
    // High-risk actions need a second distinct approver; stop here rather than executing an
    // action that is still pending quorum.
    if (approved.value.status !== "approved") {
      const need = approved.value.approval_requirement.min_approvals;
      const have = new Set(
        approved.value.approvals.map((entry) => entry.approver_id ?? entry.approver_role),
      ).size;
      host.adminBotNotice = {
        kind: "success",
        text: `Recorded your approval of ${proposal.id}. ${have} of ${need} approvals — another admin or core member must approve before it runs.`,
      };
      await loadAdminBot(host);
      return;
    }
    const executed = await executeActionAsMember(
      proposal.id,
      `control-ui-${proposal.id}`,
      session.sessionToken,
      session.baseUrl,
    );
    if (!executed.ok) {
      host.adminBotNotice = { kind: "error", text: approvalFailureMessage(executed.kind) };
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text: `${executed.value.status === "executed" ? "Approved and executed" : "Approved and simulated"} ${proposal.id}.`,
    };
    await loadAdminBot(host);
  } finally {
    host.adminBotBusyActionId = null;
  }
}

// Approvals require a real privileged member session — the gateway service principal is
// rejected by the server (403) so that chat-driven privileged actions are impossible.
function requirePrivilegedSession(
  host: AdminBotHost,
): { sessionToken: string; baseUrl: string } | null {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your lab account to approve or dismiss actions.",
    };
    return null;
  }
  return { sessionToken: stored.sessionToken, baseUrl: resolveAdminBotBaseUrl(host.settings) };
}

// Re-reads every linked CV and replaces the panel's scan result. Deliberately not merged into the
// previous result: a member whose link broke since the last run must stop showing that run's
// changes as though they were still current.
// One place to turn a failed CV call into something an admin can act on.
//
// These three routes are the newest in the service, so they are the ones a long-running dev
// service will not have yet. "not-found" therefore means version skew, and saying so is the
// difference between restarting a process and hunting a login problem that does not exist.
function cvErrorText(kind: string, action: string): string {
  if (kind === "unreachable") {
    return ADMINBOT_SERVICE_UNREACHABLE_MESSAGE;
  }
  if (kind === "not-found") {
    return `This AdminBot service does not have the ${action} endpoint — it is running older code than the console. Restart it with \`pnpm adminbot:dev\`.`;
  }
  if (kind === "forbidden") {
    return `${action} requires an admin or core member session.`;
  }
  return `Could not ${action}: ${kind}`;
}

/**
 * Rebuilds every configured conference index.
 *
 * The slow job of the pair: a few thousand papers fetched from OpenReview and embedded one batch
 * at a time, roughly a minute and a half per conference. It reports per-venue rather than pass or
 * fail because the venues are independent — one dead id should not read as "indexing is broken".
 */
export async function runAdminBotVenueIndexJob(host: AdminBotHost): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    return;
  }
  host.adminBotVenueIndexJob = { status: "running" };
  try {
    const result = await rebuildVenueIndexes(session.sessionToken, session.baseUrl);
    if (!result.ok) {
      host.adminBotVenueIndexJob = {
        status: "error",
        detail: result.message?.trim() || cvErrorText(result.kind, "rebuild the paper indexes"),
        finishedAtMs: Date.now(),
      };
      return;
    }
    const payload = result.value as {
      built?: Array<{ label?: string; paper_count?: number }>;
      failed?: Array<{ venue_id: string; reason: string }>;
    };
    const built = payload.built ?? [];
    const failed = payload.failed ?? [];
    const papers = built.reduce((total, entry) => total + (entry.paper_count ?? 0), 0);
    host.adminBotVenueIndexJob = {
      status: failed.length ? "error" : "ok",
      detail: failed.length
        ? `Indexed ${built.length} of ${built.length + failed.length}: ${failed
            .map((entry) => `${entry.venue_id} (${entry.reason})`)
            .join("; ")}`
        : `Indexed ${papers.toLocaleString()} papers across ${built.length} conference${
            built.length === 1 ? "" : "s"
          }.`,
      finishedAtMs: Date.now(),
    };
  } catch (error) {
    host.adminBotVenueIndexJob = {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
      finishedAtMs: Date.now(),
    };
  }
}

/**
 * Loads the conference list, and prefills the interests box from the member's own topics.
 *
 * The prefill only ever happens while the box is untouched. Re-opening the tab should pick up a
 * profile edit, but re-loading the list must never overwrite a sentence the member is part way
 * through typing.
 */
export async function loadAdminBotVenueSources(host: AdminBotHost): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    return;
  }
  host.adminBotVenuePapers = { ...host.adminBotVenuePapers, loadingSources: true, error: null };
  try {
    const result = await fetchVenueSources(session.sessionToken, session.baseUrl);
    if (!result.ok) {
      host.adminBotVenuePapers = {
        ...host.adminBotVenuePapers,
        loadingSources: false,
        error: result.message?.trim() || cvErrorText(result.kind, "load the conference list"),
      };
      return;
    }
    const sources = (result.value as { sources?: AdminBotVenueSourceView[] })?.sources ?? [];
    const state = host.adminBotVenuePapers;
    const self = host.adminBotData?.members?.find((member) => member.id === host.memberId);
    host.adminBotVenuePapers = {
      ...state,
      sources,
      loadingSources: false,
      // Default to the first conference an admin listed; the list is ordered deliberately.
      venueId: state.venueId || (sources[0]?.venue_id ?? ""),
      interests: state.interestsTouched
        ? state.interests
        : interestsFromTopics(self?.research_topics),
    };
  } catch (error) {
    host.adminBotVenuePapers = {
      ...host.adminBotVenuePapers,
      loadingSources: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function setAdminBotVenue(host: AdminBotHost, venueId: string): void {
  // The old result belonged to a different conference; keeping it on screen under a new heading
  // would be a lie about what was searched.
  host.adminBotVenuePapers = {
    ...host.adminBotVenuePapers,
    venueId,
    result: null,
    error: null,
    expanded: [],
  };
}

export function setAdminBotVenueInterests(host: AdminBotHost, interests: string): void {
  host.adminBotVenuePapers = {
    ...host.adminBotVenuePapers,
    interests,
    interestsTouched: true,
  };
}

export function toggleAdminBotVenueAbstract(host: AdminBotHost, paperId: string): void {
  const open = host.adminBotVenuePapers.expanded;
  host.adminBotVenuePapers = {
    ...host.adminBotVenuePapers,
    expanded: open.includes(paperId) ? open.filter((id) => id !== paperId) : [...open, paperId],
  };
}

/** Ranks the chosen conference against the interests currently in the box. */
export async function searchAdminBotVenuePapers(host: AdminBotHost): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    return;
  }
  const { venueId, interests } = host.adminBotVenuePapers;
  if (!venueId || !interests.trim()) {
    return;
  }
  host.adminBotVenuePapers = {
    ...host.adminBotVenuePapers,
    searching: true,
    error: null,
    expanded: [],
  };
  try {
    const result = await searchVenuePapers(
      { venueId, interests },
      session.sessionToken,
      session.baseUrl,
    );
    if (!result.ok) {
      host.adminBotVenuePapers = {
        ...host.adminBotVenuePapers,
        searching: false,
        result: null,
        error: result.message?.trim() || cvErrorText(result.kind, "search the conference"),
      };
      return;
    }
    host.adminBotVenuePapers = {
      ...host.adminBotVenuePapers,
      searching: false,
      result: result.value as AdminBotVenueSearchResult,
    };
  } catch (error) {
    host.adminBotVenuePapers = {
      ...host.adminBotVenuePapers,
      searching: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** How often the page checks back on a pass that is still running. */
const WORKSHOP_RUN_POLL_MS = 5_000;

/**
 * Start a new match.
 *
 * Separate from loading, because they cost wildly different things: reading the stored answer is
 * one cheap request, and producing a new one is thousands of model calls. Opening the page must
 * never do the second by accident.
 */
export async function refreshWorkshopNudgePreview(
  host: AdminBotHost,
  // Set when the administrator is deliberately replacing a pass that still says it is running,
  // rather than waiting out the server's stall window.
  force = false,
): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      error: "Sign in with a lab administrator account before refreshing recommendations.",
    };
    return;
  }
  host.adminBotWorkshopNudges = { ...host.adminBotWorkshopNudges, loading: true, error: null };
  const started = await refreshWorkshopNudges(session.sessionToken, session.baseUrl, force);
  if (!started.ok) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      loading: false,
      error: started.message?.trim() || cvErrorText(started.kind, "start a workshop match"),
    };
    return;
  }
  await loadWorkshopNudgePreview(host);
}

export async function loadWorkshopNudgePreview(host: AdminBotHost): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      error: "Sign in with a lab administrator account before refreshing recommendations.",
    };
    return;
  }
  const current = host.adminBotWorkshopNudges;
  if (current.loading || current.sending) {
    return;
  }
  host.adminBotWorkshopNudges = {
    ...current,
    loading: true,
    error: null,
    selectedRecipientIds: [],
  };
  try {
    const result = await previewWorkshopNudges(session.sessionToken, session.baseUrl);
    if (!result.ok) {
      host.adminBotWorkshopNudges = {
        ...host.adminBotWorkshopNudges,
        loading: false,
        result: null,
        error: result.message?.trim() || cvErrorText(result.kind, "load workshop nudges"),
      };
      return;
    }
    const run = result.value as WorkshopNudgeRunView;
    const value = run.preview ?? null;
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      loading: false,
      run,
      result: value,
      // A failed pass says why on the page rather than looking like an empty result.
      error: run.status === "failed" ? (run.error ?? "The last match did not finish.") : null,
      selectedRecipientIds: value
        ? value.recipients
            .filter((recipient) => recipient.delivery_ready)
            .map((recipient) => recipient.recipient_member_id)
        : [],
      view: { ...host.adminBotWorkshopNudges.view, page: 0, detailKey: null },
    };
    // While a pass is in flight the page checks back on its own, so somebody who pressed Refresh
    // and walked away comes back to the answer rather than to a spinner that stopped meaning
    // anything. Polling stops the moment the pass is terminal.
    if (run.status === "running") {
      setTimeout(() => void loadWorkshopNudgePreview(host), WORKSHOP_RUN_POLL_MS);
    }
  } catch (error) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      loading: false,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Stop the pass in flight.
 *
 * Reaching a stalled pass used to mean waiting out the server's thirty-minute window or restarting
 * the service, neither of which is available to somebody looking at a wedged tab in a browser.
 */
export async function cancelWorkshopNudgeRun(host: AdminBotHost): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      error: "Sign in with a lab administrator account before stopping a pass.",
    };
    return;
  }
  host.adminBotWorkshopNudges = { ...host.adminBotWorkshopNudges, loading: true, error: null };
  const stopped = await cancelWorkshopNudges(session.sessionToken, session.baseUrl);
  if (!stopped.ok) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      loading: false,
      error: stopped.message?.trim() || cvErrorText(stopped.kind, "stop the workshop match"),
    };
    return;
  }
  host.adminBotWorkshopNudges = { ...host.adminBotWorkshopNudges, loading: false };
  await loadWorkshopNudgePreview(host);
}

export function toggleWorkshopNudgeRecipient(host: AdminBotHost, memberId: string): void {
  const selected = host.adminBotWorkshopNudges.selectedRecipientIds;
  host.adminBotWorkshopNudges = {
    ...host.adminBotWorkshopNudges,
    selectedRecipientIds: selected.includes(memberId)
      ? selected.filter((id) => id !== memberId)
      : [...selected, memberId],
  };
}

export function setWorkshopNudgeRecipients(
  host: AdminBotHost,
  memberIds: string[],
  selected: boolean,
): void {
  const current = new Set(host.adminBotWorkshopNudges.selectedRecipientIds);
  for (const memberId of memberIds) {
    if (selected) {
      current.add(memberId);
    } else {
      current.delete(memberId);
    }
  }
  host.adminBotWorkshopNudges = {
    ...host.adminBotWorkshopNudges,
    selectedRecipientIds: [...current],
  };
}

export function updateWorkshopNudgeView(host: AdminBotHost, patch: WorkshopNudgeViewPatch): void {
  host.adminBotWorkshopNudges = {
    ...host.adminBotWorkshopNudges,
    view: { ...host.adminBotWorkshopNudges.view, ...patch },
  };
}

export async function sendWorkshopNudgeSelection(host: AdminBotHost): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    return;
  }
  const current = host.adminBotWorkshopNudges;
  if (current.sending || current.loading) {
    return;
  }
  if (!current.selectedRecipientIds.length) {
    host.adminBotWorkshopNudges = { ...current, error: "Select at least one recipient." };
    return;
  }
  host.adminBotWorkshopNudges = { ...current, sending: true, error: null };
  try {
    const result = await sendWorkshopNudges(
      current.selectedRecipientIds,
      session.sessionToken,
      session.baseUrl,
    );
    if (!result.ok) {
      host.adminBotWorkshopNudges = {
        ...host.adminBotWorkshopNudges,
        sending: false,
        error: result.message?.trim() || cvErrorText(result.kind, "send workshop nudges"),
      };
      return;
    }
    const value = result.value as {
      created: Array<{ member_id: string }>;
      skipped: Array<{ member_id: string; reason: string }>;
    };
    const skipped = value.skipped.length
      ? ` Skipped ${value.skipped.length}: ${value.skipped.map((entry) => entry.reason).join(", ")}.`
      : "";
    host.adminBotNotice = {
      kind: value.skipped.length ? "error" : "success",
      text: `Sent ${value.created.length} workshop nudge${value.created.length === 1 ? "" : "s"}.${skipped}`,
    };
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      sending: false,
      selectedRecipientIds: [],
    };
  } catch (error) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      sending: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Runs the CV digest job: scan every linked CV, then rewrite the CV Updates doc from the whole
 * change ledger.
 *
 * The scan is the slow half — one fetch and, for anything that changed, one model call per member
 * — so the button reports "running" for as long as it takes rather than optimistically claiming
 * success. Nothing here is optimistic: the state only advances once the service says the document
 * was written, because the point of the job is that the doc actually changed.
 */
export async function runAdminBotCvDigestJob(host: AdminBotHost): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    return;
  }
  host.adminBotCvDigestJob = { status: "running" };
  host.adminBotNotice = null;
  try {
    const result = await publishCvDigest(session.sessionToken, session.baseUrl);
    if (!result.ok) {
      host.adminBotCvDigestJob = {
        status: "error",
        // The service's own sentence when it sent one (a missing document id, a gog failure);
        // the generic copy only when it did not.
        detail: result.message?.trim() || cvErrorText(result.kind, "publish the CV digest"),
        finishedAtMs: Date.now(),
      };
      return;
    }
    const published = result.value as AdminBotCvDigestPublishResult;
    host.adminBotCvDigestJob = {
      status: "ok",
      detail: describeDigestRun(published),
      resultUrl: published.document_url,
      finishedAtMs: Date.now(),
    };
  } catch (error) {
    // A thrown error here is a bug or a dead network rather than a service refusal, but leaving
    // the button stuck on "Running…" would be worse than saying so.
    host.adminBotCvDigestJob = {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
      finishedAtMs: Date.now(),
    };
  }
}

// A run that published nothing is still a run: the document was rewritten with a fresh date, and
// saying "0 updates" is what stops an admin pressing the button again to check.
function describeDigestRun(published: AdminBotCvDigestPublishResult): string {
  if (published.change_count === 0) {
    return "No CV updates recorded yet — the document was refreshed with today's date.";
  }
  const updates = `${published.change_count} update${published.change_count === 1 ? "" : "s"}`;
  const days = `${published.day_count} day${published.day_count === 1 ? "" : "s"}`;
  return `Published ${updates} across ${days}.`;
}

export async function removePendingAdminBotAction(
  host: AdminBotHost,
  proposal: AdminBotActionProposal,
): Promise<void> {
  host.adminBotBusyActionId = proposal.id;
  host.adminBotNotice = null;
  try {
    const session = requirePrivilegedSession(host);
    if (!session) {
      return;
    }
    const removed = await removePendingAction(proposal.id, session.sessionToken, session.baseUrl);
    if (!removed.ok) {
      host.adminBotNotice = { kind: "error", text: approvalFailureMessage(removed.kind) };
      return;
    }
    host.adminBotNotice = { kind: "success", text: "Removed " + proposal.id + "." };
    await loadAdminBot(host);
  } finally {
    host.adminBotBusyActionId = null;
  }
}

export async function executeAdminBotAction(
  host: AdminBotHost,
  proposal: AdminBotActionProposal,
): Promise<void> {
  host.adminBotBusyActionId = proposal.id;
  host.adminBotNotice = null;
  try {
    const session = requirePrivilegedSession(host);
    if (!session) {
      return;
    }
    const executed = await executeActionAsMember(
      proposal.id,
      `control-ui-${proposal.id}`,
      session.sessionToken,
      session.baseUrl,
    );
    if (!executed.ok) {
      host.adminBotNotice = { kind: "error", text: approvalFailureMessage(executed.kind) };
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text: `${executed.value.status === "executed" ? "Executed" : "Simulated"} ${proposal.id}.`,
    };
    await loadAdminBot(host);
  } finally {
    host.adminBotBusyActionId = null;
  }
}

function adminMemberUpdatePayload(member: AdminBotLabMemberSaveInput) {
  return {
    name: member.name,
    ...(member.email ? { email: member.email } : {}),
    ...(member.slackUserId ? { slack_user_id: member.slackUserId } : {}),
    ...(member.privilegeLevel ? { privilege_level: member.privilegeLevel } : {}),
    ...(member.collaboratorSubgroup ? { collaborator_subgroup: member.collaboratorSubgroup } : {}),
    ...(member.notes ? { notes: member.notes } : {}),
    ...(member.status ? { status: member.status } : {}),
    // Last, so a governance field can never be overwritten by a profile key of the same name.
    // The service re-checks every key against its own whitelist regardless.
    ...(member.profile ?? {}),
  };
}

/**
 * The registry fields the break-glass gateway tool can carry, renamed to its camelCase parameters.
 *
 * Narrower than the HTTP path on purpose, and narrower than it looks: `adminbot_upsert_lab_member`
 * declares a fixed parameter object (extensions/adminbot/index.ts), so a key it does not name is
 * rejected rather than ignored. Fields outside this map are simply not settable over the legacy
 * token path -- which is the same restriction that path already had, now stated in one place
 * instead of being implied by which lines somebody remembered to write.
 */
const TOOL_PROFILE_PARAMS: Record<string, string> = {
  role: "role",
  research_branch: "researchBranch",
  research_topics: "researchTopics",
  projects: "projects",
  hours_per_week: "hoursPerWeek",
  location: "location",
  affiliation: "affiliation",
  timezone: "timezone",
  personal_website: "personalWebsite",
  openreview_id: "openreviewId",
};

function toolProfileParams(profile: Record<string, unknown> | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile ?? {})) {
    const param = TOOL_PROFILE_PARAMS[key];
    if (param !== undefined) {
      params[param] = value;
    }
  }
  return params;
}

// Saves a member from the Lab Members admin editor. Governance fields (privilege_level,
// status, email) can only ever be set by a genuine admin *member Bearer session* — the
// gateway-RPC tool path (adminbot_upsert_lab_member) always authenticates as the shared
// service principal regardless of who is signed in, and that principal is deliberately
// restricted to the same whitelist as a plain self-edit (the fix that closed the
// chat-based privilege-escalation hole). So a signed-in admin's edits here go straight to
// the AdminBot HTTP service with their own session token, bypassing the gateway tool
// entirely. Falls back to the gateway tool only when there's no stored member session at
// all (legacy break-glass access via the bare gateway token, predating member auth) —
// that path keeps today's already-restricted behavior rather than losing the save entirely.
export async function saveAdminBotMember(
  host: AdminBotHost,
  member: AdminBotLabMemberSaveInput,
): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (stored) {
    const result = await upsertLabMemberAsAdmin(
      member.id,
      adminMemberUpdatePayload(member),
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      const message =
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "forbidden"
            ? "Your session no longer has admin access — sign in again and retry."
            : result.kind === "rate-limited"
              ? "Too many attempts. Wait a moment and try again."
              : // A validation refusal names the value it rejected ("member role must be one of:
                // ..."); the generic line below cannot, and the whole record is sent on every save,
                // so without the service's own sentence one bad field reads as the editor being
                // broken. Same reasoning as saveAdminBotOwnProfile.
                (result.message ?? "Couldn't save this member. Check the values and try again.");
      host.adminBotNotice = { kind: "error", text: message };
      return;
    }
    host.adminBotNotice = { kind: "success", text: `Saved member ${member.id}.` };
    await loadAdminBot(host);
    return;
  }
  try {
    await invokeAdminBotTool(host, "adminbot_upsert_lab_member", {
      id: member.id,
      name: member.name,
      ...(member.email ? { email: member.email } : {}),
      ...(member.slackUserId ? { slackUserId: member.slackUserId } : {}),
      ...(member.privilegeLevel ? { privilegeLevel: member.privilegeLevel } : {}),
      ...(member.collaboratorSubgroup ? { collaboratorSubgroup: member.collaboratorSubgroup } : {}),
      ...(member.notes ? { notes: member.notes } : {}),
      ...(member.status ? { status: member.status } : {}),
      ...toolProfileParams(member.profile),
    });
    host.adminBotNotice = { kind: "success", text: `Saved member ${member.id}.` };
    await loadAdminBot(host);
  } catch (err) {
    host.adminBotNotice = {
      kind: "error",
      text: formatAdminBotToolError(err),
    };
  }
}

/**
 * Folds one roster row into another and retires it.
 *
 * Member session only, and no gateway-tool fallback: unlike a save, there is no narrower version
 * of this that the shared service principal could safely perform, and the service refuses it to
 * that principal anyway. Break-glass access simply does not offer the affordance.
 *
 * The notice names what the merge could not decide. A conflict is not an error -- the survivor's
 * answer stands, which is what the admin asked for by choosing which record survives -- but it is
 * the one thing about a merge nobody can see afterwards, so it is said out loud once.
 */
export async function mergeAdminBotMembers(
  host: AdminBotHost,
  survivorId: string,
  duplicateId: string,
): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your admin account to merge roster records.",
    };
    return;
  }
  const result = await mergeLabMembersAsAdmin(
    survivorId,
    duplicateId,
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (!result.ok) {
    host.adminBotNotice = {
      kind: "error",
      text:
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "forbidden"
            ? "Your session no longer has admin access — sign in again and retry."
            : (result.message ?? "Couldn't merge those records."),
    };
    return;
  }
  const conflicts = result.value.conflicts ?? [];
  host.adminBotNotice = {
    kind: "success",
    text: conflicts.length
      ? `Merged ${duplicateId} into ${survivorId}. Kept ${survivorId}'s answer for ${conflicts
          .map((conflict) => conflict.field)
          .join(", ")}.`
      : `Merged ${duplicateId} into ${survivorId}.`,
  };
  await loadAdminBot(host);
}

// Saves the signed-in member's own roster row from the Lab Members table. Uses the
// self-edit endpoint (PUT /lab/members/:id with a member Bearer session), whose server-side
// whitelist drops governance fields — so a plain member editing their own row can never
// reach the admin write path. Requires a real member session; break-glass gateway-token-only
// access has no signed-in member and never renders this affordance.
export async function saveAdminBotOwnProfile(
  host: AdminBotHost,
  memberId: string,
  fields: MemberProfileUpdate,
): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your member account to edit your profile.",
    };
    return;
  }
  const result = await updateOwnProfile(
    memberId,
    fields,
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (!result.ok) {
    const message =
      result.kind === "unreachable"
        ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
        : result.kind === "rate-limited"
          ? "Too many attempts. Wait a moment and try again."
          : // A validation refusal names the value it rejected ("LinkedIn link must be a profile
            // URL"); the generic line below cannot, and the whole record is sent on every save, so
            // without the service's own sentence one bad field silently freezes every other edit.
            // 403 (editing someone else's id) folds into auth-failed here; the UI never offers
            // this affordance on another member's row, so it reads as a stale session.
            (result.message ??
            "Couldn't save your profile. Sign in again, check the values, and retry.");
    host.adminBotNotice = { kind: "error", text: message };
    return;
  }
  host.adminBotNotice = { kind: "success", text: "Saved your profile." };
  await loadAdminBot(host);
}

export async function polishAdminBotOwnProfilePhoto(host: AdminBotHost): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your member account to polish your profile photo.",
    };
    return;
  }
  host.adminBotPhotoPolishBusy = true;
  try {
    const result = await polishOwnProfilePhoto(
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      const message =
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "rate-limited"
            ? "Too many attempts. Wait a moment and try again."
            : "Couldn't generate a polished photo right now.";
      host.adminBotNotice = { kind: "error", text: message };
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text: "Generated a polished photo option. Review it below and apply if you like it.",
    };
    await loadAdminBot(host, "general");
  } finally {
    host.adminBotPhotoPolishBusy = false;
  }
}

export async function applyAdminBotOwnProfilePhoto(
  host: AdminBotHost,
  variantId: string,
): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your member account to apply a profile photo.",
    };
    return;
  }
  host.adminBotPhotoApplyBusy = true;
  try {
    const result = await applyOwnPolishedProfilePhoto(
      variantId,
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      const message =
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "rate-limited"
            ? "Too many attempts. Wait a moment and try again."
            : "Couldn't apply that photo to Slack. Try another variant or retry.";
      host.adminBotNotice = { kind: "error", text: message };
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text: "Updated your Slack profile photo to the selected version.",
    };
    await loadAdminBot(host, "general");
  } finally {
    host.adminBotPhotoApplyBusy = false;
  }
}

/**
 * Replaces the signed-in member's own schedule lists with `patch`.
 *
 * Whole lists are sent, not deltas: each stored field is a list the service validates as one, so
 * add and remove are both "write the list you want". The caller composes them. An omitted list is
 * left untouched.
 *
 * Writing another member's schedule is not possible: the service routes a self session to its own
 * record only. Same posture as saveAdminBotOwnProfile — the UI never offers the editor on anyone
 * else's row, and a 403 folds into the generic failure below because reaching it means a stale
 * session rather than a case worth its own copy.
 */
export async function saveAdminBotOwnSchedule(
  host: AdminBotHost,
  memberId: string,
  patch: MemberScheduleUpdate,
): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your member account to edit your schedule.",
    };
    return;
  }
  const result = await updateOwnSchedule(
    memberId,
    patch,
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (!result.ok) {
    const message =
      result.kind === "unreachable"
        ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
        : result.kind === "rate-limited"
          ? "Too many attempts. Wait a moment and try again."
          : // The service rejects an out-of-range date or an hours value outside 0–168 with a 400;
            // the form validates the same things first, so reaching here means a stale session or
            // a rule the form does not know about yet.
            "Couldn't save your schedule. Check the dates and hours, then retry.";
    host.adminBotNotice = { kind: "error", text: message };
    return;
  }
  host.adminBotNotice = { kind: "success", text: "Saved your schedule." };
  await loadAdminBot(host);
}

export function setAdminBotNudgeChannel(host: AdminBotHost, channel: MemberNudgeChannel): void {
  host.adminBotMemberNudge = { ...host.adminBotMemberNudge, channel };
}

export function setAdminBotNudgeMessage(host: AdminBotHost, message: string): void {
  host.adminBotMemberNudge = { ...host.adminBotMemberNudge, message };
}

export function setAdminBotNudgeSubject(host: AdminBotHost, subject: string): void {
  host.adminBotMemberNudge = { ...host.adminBotMemberNudge, subject };
}

export function toggleAdminBotNudgeRecipient(host: AdminBotHost, memberId: string): void {
  const selected = host.adminBotMemberNudge.selectedMemberIds;
  host.adminBotMemberNudge = {
    ...host.adminBotMemberNudge,
    selectedMemberIds: selected.includes(memberId)
      ? selected.filter((id) => id !== memberId)
      : [...selected, memberId],
  };
}

// Bulk-set the recipient list — used by "select all visible" (checks every filtered/visible row)
// and "clear" (empties it) in the Announcements recipient table.
export function setAdminBotNudgeRecipients(host: AdminBotHost, memberIds: string[]): void {
  host.adminBotMemberNudge = { ...host.adminBotMemberNudge, selectedMemberIds: memberIds };
}

// Sends the composed Announcements message to every selected recipient. Requires a real admin
// member session (same reasoning as saveAdminBotMember's direct-write path) since the server
// rejects this route outright for the shared service principal. Each recipient becomes its own
// member_nudge.send proposal awaiting pi/lab_manager approval in Pending actions — this never
// sends anything immediately.
export async function sendAdminBotMemberNudge(host: AdminBotHost): Promise<void> {
  host.adminBotNotice = null;
  const draft = host.adminBotMemberNudge;
  if (draft.busy) {
    return;
  }
  const message = draft.message.trim();
  if (!message) {
    host.adminBotNotice = { kind: "error", text: "Enter a message to send." };
    return;
  }
  if (draft.selectedMemberIds.length === 0) {
    host.adminBotNotice = { kind: "error", text: "Select at least one recipient." };
    return;
  }
  if (draft.channel === "email" && !draft.subject.trim()) {
    host.adminBotNotice = { kind: "error", text: "Enter a subject line for the email." };
    return;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your admin account to send a nudge.",
    };
    return;
  }
  host.adminBotMemberNudge = { ...draft, busy: true };
  try {
    const result = await sendMemberNudge(
      {
        channel: draft.channel,
        recipient_member_ids: draft.selectedMemberIds,
        message,
        ...(draft.channel === "email" ? { subject: draft.subject.trim() } : {}),
      },
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      const text =
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "forbidden"
            ? "Your session no longer has admin access — sign in again and retry."
            : result.kind === "rate-limited"
              ? "Too many attempts. Wait a moment and try again."
              : "Couldn't send this nudge. Check the values and try again.";
      host.adminBotNotice = { kind: "error", text };
      return;
    }
    const { created, skipped } = result.value;
    const skippedNote =
      skipped.length > 0
        ? ` Skipped ${skipped.length}: ${skipped.map((entry) => entry.reason).join(", ")}.`
        : "";
    host.adminBotNotice = {
      kind: skipped.length > 0 ? "error" : "success",
      text: `Sent ${created.length} nudge${created.length === 1 ? "" : "s"}.${skippedNote}`,
    };
    host.adminBotMemberNudge = createEmptyAdminBotMemberNudgeState();
    await loadAdminBot(host);
  } finally {
    host.adminBotMemberNudge = { ...host.adminBotMemberNudge, busy: false };
  }
}

/**
 * Marks the alerts the member just opened as read.
 *
 * Sequential rather than parallel: each save reloads the dashboard, and overlapping writes to the
 * same paper list would race the refresh against itself.
 */
export async function markAdminBotNudgesSeen(host: AdminBotHost): Promise<void> {
  for (const paper of papersWithUnread(host.adminBotData?.papers ?? [])) {
    await saveAdminBotPaper(host, seenSaveInput(paper));
  }
}

export async function saveAdminBotPaper(
  host: AdminBotHost,
  paper: AdminBotPaperSaveInput,
): Promise<void> {
  host.adminBotNotice = null;
  const artifacts = {
    ...(paper.overleafEditUrl ? { overleaf_edit_url: paper.overleafEditUrl } : {}),
    ...(paper.overleafViewUrl ? { overleaf_view_url: paper.overleafViewUrl } : {}),
    ...(paper.brainstormingDocUrl ? { brainstorming_doc_url: paper.brainstormingDocUrl } : {}),
    ...(paper.submissionUrl ? { submission_url: paper.submissionUrl } : {}),
    ...(paper.googleDrivePdfUrl ? { google_drive_pdf_url: paper.googleDrivePdfUrl } : {}),
    ...(paper.arxivUrl ? { arxiv_url: paper.arxivUrl } : {}),
    ...(paper.googleSlidesUrl ? { google_slides_url: paper.googleSlidesUrl } : {}),
    ...(paper.posterUrl ? { poster_url: paper.posterUrl } : {}),
    // Sent even when empty, because clearing every venue has to be able to erase the key.
    ...(paper.venueTargets === undefined ? {} : { venue_targets: paper.venueTargets }),
    ...(paper.decisionSeen ? { decision_seen: paper.decisionSeen } : {}),
    ...(paper.conference ? { conference: paper.conference } : {}),
    ...(paper.confidence ? { confidence: paper.confidence } : {}),
    // Sent even when empty: reopening a paper has to be able to erase the key, not just skip it.
    ...(paper.completedAt === undefined ? {} : { completed_at: paper.completedAt }),
    ...(paper.blockerLog === undefined ? {} : { blocker_log: paper.blockerLog }),
    ...(paper.nudgeLog === undefined ? {} : { nudge_log: paper.nudgeLog }),
    ...(paper.nudgeSeenAt === undefined ? {} : { nudge_seen_at: paper.nudgeSeenAt }),
    ...(paper.topic ? { topic: paper.topic } : {}),
  };
  // Governance-shaped fields go on the record itself rather than into `artifacts`, and only when
  // the form actually offered one -- an untouched control must not clear a stored value.
  // The author's own details, editable from their card. Kept apart from `acceptance` below
  // because that one carries governance fields a member is forbidden to send at all -- mixing
  // them would make a member's ordinary edit look like an attempt to record a venue decision.
  const details = {
    ...(paper.feedbackGivers === undefined ? {} : { feedback_givers: paper.feedbackGivers }),
    ...(paper.authorRoles === undefined ? {} : { author_roles: paper.authorRoles }),
    ...(paper.authorLinks === undefined ? {} : { author_links: paper.authorLinks }),
    ...(paper.venue === undefined ? {} : { venue: paper.venue }),
  };
  const acceptance = {
    ...(paper.venueDecision ? { venue_decision: paper.venueDecision } : {}),
    ...(paper.acceptedVenue === undefined ? {} : { accepted_venue: paper.acceptedVenue }),
    ...(paper.acceptedYear ? { accepted_year: Number(paper.acceptedYear) } : {}),
    ...(paper.isArchival === undefined || paper.isArchival === ""
      ? {}
      : { is_archival: paper.isArchival === "true" }),
    // Sent even when empty, so clearing the choice actually clears it. Dropping falsy values
    // here made Reset look like it worked and then quietly leave the old track on file.
    ...(paper.presentationType === undefined ? {} : { presentation_type: paper.presentationType }),
  };
  // Prefer the member's own session: the service scopes the write to what that member may change
  // (any paper for an admin, their own for an author). The gateway tool path stays as the fallback
  // for break-glass sessions that hold a gateway token but no member login.
  const stored = loadStoredMemberSession();
  if (stored) {
    const saved = await saveOwnPaper(
      paper.id,
      {
        title: paper.title,
        authors: paper.authors,
        current_step: paper.currentStep,
        ...details,
        ...acceptance,
        ...(Object.keys(artifacts).length > 0 ? { artifacts } : {}),
        ...(paper.reminderStatus ? { reminder: { status: paper.reminderStatus } } : {}),
      },
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!saved.ok) {
      host.adminBotNotice = { kind: "error", text: paperSaveErrorText(saved.kind) };
      return;
    }
    host.adminBotNotice = { kind: "success", text: `Saved paper ${paper.id}.` };
    await loadAdminBot(host);
    return;
  }
  try {
    await invokeAdminBotTool(host, "adminbot_upsert_paper", {
      id: paper.id,
      title: paper.title,
      authors: paper.authors,
      currentStep: paper.currentStep,
      ...(Object.keys(artifacts).length > 0 ? { artifacts } : {}),
      ...(paper.reminderStatus ? { reminder: { status: paper.reminderStatus } } : {}),
    });
    host.adminBotNotice = { kind: "success", text: `Saved paper ${paper.id}.` };
    await loadAdminBot(host);
  } catch (err) {
    host.adminBotNotice = {
      kind: "error",
      text: formatAdminBotToolError(err),
    };
  }
}

function paperSaveErrorText(kind: string): string {
  switch (kind) {
    case "unreachable":
      return ADMINBOT_SERVICE_UNREACHABLE_MESSAGE;
    case "forbidden":
      return "You can only add or edit papers you authored.";
    case "rate-limited":
      return "Too many attempts. Wait a moment and try again.";
    default:
      return "Couldn't save this paper. Check the details and try again.";
  }
}

/**
 * Remove a paper.
 *
 * Prefers the member's own session, for the same reason saveAdminBotPaper does: the service scopes
 * the delete to what that member may remove -- any paper for an admin, one they authored for an
 * author -- and a member's paired device holds read-only gateway scopes, so the tool path below is
 * not open to them at all. Until this existed an author who filed a paper by mistake had to ask an
 * admin to undo it.
 */
export async function deleteAdminBotPaper(
  host: AdminBotHost,
  paper: Pick<AdminBotPaperRecord, "id" | "title">,
): Promise<void> {
  host.adminBotBusyActionId = paper.id;
  host.adminBotNotice = null;
  try {
    const stored = loadStoredMemberSession();
    if (stored) {
      const removed = await deleteOwnPaper(
        paper.id,
        stored.sessionToken,
        resolveAdminBotBaseUrl(host.settings),
      );
      if (!removed.ok) {
        host.adminBotNotice = { kind: "error", text: paperDeleteErrorText(removed.kind) };
        return;
      }
      host.adminBotNotice = { kind: "success", text: `Deleted paper ${paper.title}.` };
      await loadAdminBot(host);
      return;
    }
    await invokeAdminBotTool(host, "adminbot_delete_paper", { paperId: paper.id });
    host.adminBotNotice = { kind: "success", text: `Deleted paper ${paper.title}.` };
    await loadAdminBot(host);
  } catch (err) {
    host.adminBotNotice = {
      kind: "error",
      text: formatAdminBotToolError(err),
    };
  } finally {
    host.adminBotBusyActionId = null;
  }
}

/** Deleting fails for its own reasons, and "check the details" is not one of them. */
function paperDeleteErrorText(kind: string): string {
  switch (kind) {
    case "unreachable":
      return "Couldn't reach AdminBot to delete this paper.";
    case "forbidden":
      return "You can only delete papers you authored.";
    case "auth-failed":
      return "Sign in again to delete this paper.";
    default:
      return "Couldn't delete this paper. Try again.";
  }
}

export async function saveAdminBotSettings(
  host: AdminBotHost,
  settings: AdminBotSettingsSaveInput,
): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    return;
  }
  host.adminBotNotice = null;
  const result = await updateSettingsAsAdmin(
    settings as Record<string, unknown>,
    session.sessionToken,
    session.baseUrl,
  );
  if (!result.ok) {
    host.adminBotNotice = {
      kind: "error",
      // The service names what it refused on a 400 (an out-of-range window, say), which beats any
      // fixed copy this side could write.
      text: result.message?.trim() || cvErrorText(result.kind, "save settings"),
    };
    return;
  }
  host.adminBotNotice = { kind: "success", text: "Saved AdminBot settings." };
  await loadAdminBot(host);
}

export async function saveAdminBotSensitiveInfo(
  host: AdminBotHost,
  markdown: string,
): Promise<void> {
  host.adminBotNotice = null;
  try {
    await invokeAdminBotTool(host, "adminbot_update_sensitive_info", { markdown });
    host.adminBotNotice = { kind: "success", text: "Saved sensitive-information markdown." };
    await loadAdminBot(host);
  } catch (err) {
    host.adminBotNotice = {
      kind: "error",
      text: formatAdminBotToolError(err),
    };
  }
}

type ReimbursementConversationResult = {
  assistant_message: string;
  draft: Record<string, unknown>;
  missing_fields: string[];
  ready: boolean;
  receipt_names: string[];
};

type ReimbursementGenerationResult = {
  artifacts: AdminBotReimbursementArtifact[];
};

export async function sendAdminBotReimbursementMessage(
  host: AdminBotHost,
  message: string,
  files: File[],
): Promise<void> {
  const userMessage = message.trim();
  if (!userMessage || host.adminBotReimbursement.busy) return;
  host.adminBotReimbursement = {
    ...host.adminBotReimbursement,
    busy: true,
    error: null,
    artifacts: [],
  };
  try {
    const receipts = await Promise.all(files.map(receiptPayload));
    const result = (await invokeAdminBotTool(host, "adminbot_reimbursement_converse", {
      message: userMessage,
      messages: host.adminBotReimbursement.messages,
      draft: host.adminBotReimbursement.draft,
      ...(receipts.length ? { receipts } : {}),
    })) as ReimbursementConversationResult;
    host.adminBotReimbursement = {
      messages: [
        ...host.adminBotReimbursement.messages,
        { role: "user", content: userMessage },
        { role: "assistant", content: result.assistant_message },
      ],
      draft: readRecord(result.draft),
      missingFields: Array.isArray(result.missing_fields) ? result.missing_fields : [],
      receiptNames: [
        ...new Set([
          ...host.adminBotReimbursement.receiptNames,
          ...(Array.isArray(result.receipt_names) ? result.receipt_names : []),
        ]),
      ],
      ready: result.ready === true,
      busy: false,
      error: null,
      artifacts: [],
    };
  } catch (err) {
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      error: formatAdminBotToolError(err),
    };
  }
}

export async function generateAdminBotReimbursement(host: AdminBotHost): Promise<void> {
  if (!host.adminBotReimbursement.ready || host.adminBotReimbursement.busy) return;
  host.adminBotReimbursement = { ...host.adminBotReimbursement, busy: true, error: null };
  try {
    const result = (await invokeAdminBotTool(host, "adminbot_reimbursement_generate", {
      draft: host.adminBotReimbursement.draft,
    })) as ReimbursementGenerationResult;
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    };
  } catch (err) {
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      error: formatAdminBotToolError(err),
    };
  }
}

// Narrowed to the slice it writes so the guest host (which has no client/session) can reuse it.
export function resetAdminBotReimbursement(
  host: Pick<AdminBotHost, "adminBotReimbursement">,
): void {
  host.adminBotReimbursement = createEmptyAdminBotReimbursementState();
}

const RECEIPT_MEDIA_TYPES_BY_EXTENSION: Record<
  string,
  "application/pdf" | "image/png" | "image/jpeg"
> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function resolveReceiptMediaType(
  file: File,
): "application/pdf" | "image/png" | "image/jpeg" | undefined {
  if (file.type === "application/pdf" || file.type === "image/png" || file.type === "image/jpeg") {
    return file.type;
  }
  const name = file.name.toLowerCase();
  const extension = Object.keys(RECEIPT_MEDIA_TYPES_BY_EXTENSION).find((candidate) =>
    name.endsWith(candidate),
  );
  return extension ? RECEIPT_MEDIA_TYPES_BY_EXTENSION[extension] : undefined;
}

// Guest (not-signed-in) reimbursement path. The signed-in flow reaches the workflow through the
// gateway's `tools.invoke`, which needs a connected gateway client and therefore a login; these two
// helpers talk to the AdminBot service's own HTTP routes instead, which accept anonymous callers.
// Everything else about the flow -- state shape, receipt encoding, error text -- stays shared, so
// the guest view and the signed-in view cannot drift apart.
async function guestReimbursementRequest(
  baseUrl: string,
  path: "/reimbursements/converse" | "/reimbursements/generate",
  payload: Record<string, unknown>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      // No credentials: the route is anonymous, and sending them would be misleading.
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Could not reach the AdminBot service. Check that it is running.");
  }
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("Too many reimbursement requests from this network. Try again later.");
    }
    throw new Error(body?.error?.message ?? `Reimbursement request failed (${response.status}).`);
  }
  return body;
}

export async function sendGuestReimbursementMessage(
  host: GuestReimbursementHost,
  message: string,
  files: File[],
): Promise<void> {
  const userMessage = message.trim();
  if (!userMessage || host.adminBotReimbursement.busy) return;
  host.adminBotReimbursement = {
    ...host.adminBotReimbursement,
    busy: true,
    error: null,
    artifacts: [],
  };
  try {
    const receipts = await Promise.all(files.map(receiptPayload));
    const result = (await guestReimbursementRequest(
      host.guestReimbursementBaseUrl,
      "/reimbursements/converse",
      {
        message: userMessage,
        messages: host.adminBotReimbursement.messages,
        draft: host.adminBotReimbursement.draft,
        ...(receipts.length ? { receipts } : {}),
      },
    )) as ReimbursementConversationResult;
    host.adminBotReimbursement = {
      messages: [
        ...host.adminBotReimbursement.messages,
        { role: "user", content: userMessage },
        { role: "assistant", content: result.assistant_message },
      ],
      draft: readRecord(result.draft),
      missingFields: Array.isArray(result.missing_fields) ? result.missing_fields : [],
      receiptNames: [
        ...new Set([
          ...host.adminBotReimbursement.receiptNames,
          ...(Array.isArray(result.receipt_names) ? result.receipt_names : []),
        ]),
      ],
      ready: result.ready === true,
      busy: false,
      error: null,
      artifacts: [],
    };
  } catch (err) {
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      error: formatAdminBotToolError(err),
    };
  }
}

export async function generateGuestReimbursement(host: GuestReimbursementHost): Promise<void> {
  if (!host.adminBotReimbursement.ready || host.adminBotReimbursement.busy) return;
  host.adminBotReimbursement = { ...host.adminBotReimbursement, busy: true, error: null };
  try {
    const result = (await guestReimbursementRequest(
      host.guestReimbursementBaseUrl,
      "/reimbursements/generate",
      { draft: host.adminBotReimbursement.draft },
    )) as ReimbursementGenerationResult;
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    };
  } catch (err) {
    host.adminBotReimbursement = {
      ...host.adminBotReimbursement,
      busy: false,
      error: formatAdminBotToolError(err),
    };
  }
}

async function receiptPayload(file: File) {
  const mediaType = resolveReceiptMediaType(file);
  if (!mediaType) {
    throw new Error(`${file.name} is not a PDF, PNG, or JPEG file`);
  }
  if (file.size > 12 * 1024 * 1024) {
    throw new Error(`${file.name} exceeds 12 MB`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { name: file.name, media_type: mediaType, data_base64: btoa(binary) };
}

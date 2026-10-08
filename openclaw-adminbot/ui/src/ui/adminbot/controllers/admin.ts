import { adminBotExternalCollaboratorSubgroups } from "../../../../../extensions/adminbot/src/contracts/actions.js";
import type {
  AdminBotReimbursementCheck,
  AdminBotReimbursementFunder,
} from "../../../../../extensions/adminbot/src/contracts/reimbursement-rules.js";
import type { GatewayBrowserClient } from "../../gateway.ts";
import type { UiSettings } from "../../storage.ts";
// Control UI controller for the AdminBot dashboard surface.
import type { CalendarEvent, CalendarEventDraft, LabCalendar } from "../api/calendar.ts";
import {
  type WorkshopConferenceOption,
  fetchVenueCategories,
  type VenuePaperCategory,
} from "../api/conference-papers.ts";
import type { LabBroadcast } from "../api/lab-sharing.ts";
import {
  type MeetingRecord,
  type MeetingCursor,
  type MeetingAttendanceNudgePreview,
  type MeetingAttendanceNudgeResult,
  fetchStandingMeetings,
} from "../api/meetings.ts";
import type { StandingMeeting } from "../api/meetings.ts";
import { queueMemberOnboardingGuide } from "../api/onboarding.ts";
import { readConferenceRosters, type ConferenceRoster } from "../api/paper-admin.ts";
import { saveOwnPaper } from "../api/papers.ts";
import type { LocationDrift } from "../api/profile.ts";
import type { MemberNotification } from "../api/workspace.ts";
import {
  type AdminBotEmailReviewItem,
  type AdminBotEmailReviewPaperflowCandidate,
  type AdminBotResolvedEmailReviewItem,
  type MemberNudgeChannel,
  fetchMemberResource,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  pendingQueuedAdminBotWriteCount,
} from "../auth/session.ts";
import type { AvailabilityRow, MilestoneRow, TimeOffRow, TripRow } from "../data/availability.js";
import { invalidateMemberMap, type MemberMap } from "../data/member-map.ts";
import { papersWithUnread, seenSaveInput } from "../nudge-alerts.ts";

export type AdminBotPrivilegeLevel = "external_collaborator" | "trial" | "member" | "admin";

/**
 * The service's subgroup vocabulary, derived rather than copied.
 *
 * This was a hand-written union of eight, "copied rather than imported" so the Control UI need not
 * reach across the extensions boundary. It drifted: `own_pace_advisee` and
 * `coauthor_discussant_designer` were added to the contract and never reached the copy, and because
 * the members panel casts the form value straight to this type (views/admin.ts), assigning either
 * of them produced a value the UI's own types said could not exist. The dropdown had already been
 * switched to iterate the contract's list for exactly this reason -- the type is the half that was
 * left behind.
 *
 * Derived from that same list, so the two can no longer disagree. The boundary argument no longer
 * holds either: this file already imports the reimbursement-rules contract a few lines up.
 *
 * Only meaningful while privilege_level is "external_collaborator" — the service rejects it on any
 * other level and clears it on promotion.
 */
export type AdminBotExternalCollaboratorSubgroup =
  (typeof adminBotExternalCollaboratorSubgroups)[number];

export type AdminBotAccessGrant = {
  service: string;
  access: "none" | "view" | "comment" | "edit" | "admin";
  scope?: string;
};

export type AdminBotMemberStatus = "active" | "part_time" | "on_leave" | "alumni" | "external";

export type AdminBotLabMember = {
  assigned_badges?: import("../auth/session.ts").AssignedBadge[];
  id: string;
  name: string;
  email?: string;
  slack_user_id?: string;
  notes?: string;
  privilege_level: AdminBotPrivilegeLevel;
  collaborator_subgroup?: AdminBotExternalCollaboratorSubgroup;
  // Whether AdminBot may write to this person at all. Absent reads as no: the list is one the lab
  // adds to, so a row nobody has decided about is silent. See adminBotReceivesNudges.
  receives_nudges?: boolean;
  /** Owner-only, and absent from the summary and paged roster reads. */
  access?: AdminBotAccessGrant[];
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
  // What the lab calls this person: "full", "alumni", "coauthor-major", and combinations of them
  // as a comma-separated list. Free text on the record, and the axis the Lab Overview filters and
  // the Vector roster select on -- `privilege_level` cannot stand in for it, because almost every
  // imported row defaults to `member`.
  member_type?: string;
  github_url?: string;
  joined_month?: string;
  whatsapp?: string;
  // Self-attested checklist state (see extensions/adminbot/src/workflows/onboarding/onboarding.ts); the dashboard
  // only reads step id + status to preselect nudge recipients.
  onboarding?: { steps?: Array<{ id: string; status: string }> } | null;
  created_at: string;
  updated_at: string;
};

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
  category?: string;
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
  categories: VenuePaperCategory[];
  loadingCategories: boolean;
  /** Empty means every category in the selected conference. */
  categoryId: string;
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
    categories: [],
    loadingCategories: false,
    categoryId: "",
    interests: "",
    interestsTouched: false,
    searching: false,
    error: null,
    result: null,
    expanded: [],
  };
}

/** One lab paper placed against the query. Mirrors LabPaperRelevance in the service. */
export type AdminBotLabPaperHit = {
  paper_id: string;
  title: string;
  score: number;
  margin: number;
  band: "core" | "related" | "peripheral" | "off_topic";
  segments: Array<{
    segment_id: string;
    label: string;
    score: number;
    margin: number;
    band: string;
  }>;
  best_segment?: { segment_id: string; label: string; score: number; margin: number; band: string };
  matched_terms: string[];
  /** How much text the placement was made from. Most records are `title_only`. */
  evidence: "rich" | "thin" | "title_only";
};

export type AdminBotLabPaperReport = {
  query_kind: "keywords" | "proposal";
  segment_count: number;
  scored: number;
  matches: AdminBotLabPaperHit[];
  off_topic: AdminBotLabPaperHit[];
  nothing_relevant: boolean;
  uncovered_segments: Array<{ id: string; label: string; text: string }>;
};

export type AdminBotLabPapersState = {
  /** Free text: a keyword, a topic list, or a whole proposal pasted in. */
  query: string;
  searching: boolean;
  error: string | null;
  result: AdminBotLabPaperReport | null;
  /** Which rows have their matched sections open. */
  expanded: string[];
};

export function createEmptyLabPapersState(): AdminBotLabPapersState {
  return { query: "", searching: false, error: null, result: null, expanded: [] };
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
  /** Present when this stored pass was limited to one parent conference. */
  conference_key?: string;
  conference_label?: string;
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
  /**
   * What the last Send did, shown on this tab.
   *
   * It used to report only through `adminBotNotice`, which the admin view renders and this one
   * never has -- so a send that skipped every recipient finished instantly, said nothing, and sent
   * nothing. "Sent 0, skipped 12: member is not on the nudge list" is the whole diagnosis, and it
   * was being written to a field nobody on this page reads.
   */
  sendResult: { created: number; skipped: Array<{ member_id: string; reason: string }> } | null;
  /** Conferences a pass may be narrowed to. Empty until the picker's options have loaded. */
  conferences: WorkshopConferenceOption[];
  /** Which one the admin picked. Empty string is "every open workshop", the default. */
  conferenceKey: string;
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
    sendResult: null,
    conferences: [],
    conferenceKey: "",
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

export type AdminBotSettings = {
  paper_escalation_business_days: number;
  cv_recency_window_months: number;
  head_professor_member_id?: string;
  lab_manager_member_id?: string;
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

export type AdminBotPaperSaveInput = {
  id: string;
  title: string;
  authors: string[];
  /** Names of people asked to read the draft. Sent whole; the service trims and de-blanks. */
  feedbackGivers?: string[];
  /** What each author does on the paper. Sent whole; "" clears it. */
  authorRoles?: string;
  /** The author list as people. Sent whole; the service regenerates `authors` from it. */
  authorLinks?: Array<{ name: string; member_id?: string; email?: string; twitter?: string }>;
  /** The project's short name, which becomes its Slack channel `proj-<alias>`. */
  alias?: string;
  /** When work started, YYYY-MM-DD. Asked at creation; a paper is often filed weeks later. */
  startedOn?: string;
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
  overleafShareUrl?: string;
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
  /** Human acknowledgement that the coauthor update for this exact decision was sent. */
  decisionEmailSent?: string;
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
  publicationTrack?: string;
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
export type AdminBotPaperRecord = {
  id: string;
  title: string;
  /**
   * The short, stable handle for the paper, when it has one.
   *
   * The service has sent this all along (`alias` on the record contract); the mirror here simply
   * never named it. It is what a compact surface should show -- a title runs to a line and a half
   * and changes as the paper is rewritten, while the alias is picked once and names the Slack
   * channel too.
   */
  alias?: string;
  /** When work actually began, YYYY-MM-DD. Asked at creation; editable from the card since. */
  started_on?: string;
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
  author_links?: Array<{ name: string; member_id?: string; email?: string; twitter?: string }>;
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
  /** Both halves: every field the forms need, and every blocker in the funder's ruleset cleared. */
  ready: boolean;
  busy: boolean;
  error: string | null;
  artifacts: AdminBotReimbursementArtifact[];
  submissionProof?: string;
  /** Which finance office is paying. Undefined until the claimant chooses; nothing runs before. */
  funder?: AdminBotReimbursementFunder;
  /** The pre-submission report, once a check has run. */
  check?: AdminBotReimbursementCheck;
  /** Where the package went, once AdminBot mailed it. */
  submission?: { to: string; reply_to: string };
};

export type AdminBotDashboardData = {
  proposals: AdminBotActionProposal[];
  emailReviews?: AdminBotEmailReviewItem[];
  emailReviewCandidates?: AdminBotEmailReviewPaperflowCandidate[];
  emailReviewHistory?: AdminBotResolvedEmailReviewItem[];
  members: AdminBotLabMember[];
  papers: AdminBotPaperRecord[];
  papersLoadedAt: number | null;
  nudges: AdminBotPaperNudge[];
  /**
   * Who is going to each conference the lab has an accepted paper at.
   *
   * Optional because the route is admin-gated and newer than the service a browser may be talking
   * to: a member session and an older host both leave it empty, and the travel board simply does
   * not render rather than reporting a failure the reader can do nothing about.
   */
  conferenceRosters?: ConferenceRoster[];
  settings: AdminBotSettings | null;
  /** Undefined until the Settings tab has read it; null when nothing is stored. */
  sensitiveInfo?: AdminBotSensitiveInfoRecord | null;
  loadedAt: number | null;
};

export type AdminBotMemberListState = {
  rows: AdminBotLabMember[];
  total: number;
  limit: number;
  offset: number;
  query: string;
  loading: boolean;
  error: string | null;
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

/** The Meetings checkboxes' options, loaded with the Lab Members panel. */
export type AdminBotStandingMeetingsState = {
  meetings: StandingMeeting[];
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
};

export function createEmptyAdminBotStandingMeetings(): AdminBotStandingMeetingsState {
  return { meetings: [], loading: false, error: null, loadedAt: null };
}

export type AdminBotHost = {
  requestUpdate?: () => void;
  memberPrivilegeLevel?: string | null;
  adminBotStandingMeetings?: AdminBotStandingMeetingsState;
  client: GatewayBrowserClient | null;
  connected: boolean;
  // The dashboard's member-map card. Undefined means it has not been requested yet.
  adminBotMemberMap: MemberMap | null | undefined;
  adminBotMemberMapLoading: boolean;
  adminBotMemberMapRequestId?: number;
  adminBotLoading: boolean;
  adminBotError: string | null;
  adminBotUsingCachedReads?: boolean;
  adminBotOfflinePendingWrites?: number;
  adminBotData: AdminBotDashboardData;
  adminBotRosterLoadedAt?: number | null;
  adminBotRosterLoading?: boolean;
  adminBotRosterError?: string | null;
  adminBotRosterRequestId?: number;
  adminBotMemberList?: AdminBotMemberListState;
  adminBotBusyActionId: string | null;
  adminBotSelectedActionIds: string[];
  adminBotBulkActionBusy: boolean;
  adminBotNotice: { kind: "success" | "error"; text: string } | null;
  adminBotPhotoPolishBusy: boolean;
  adminBotPhotoApplyBusy: boolean;
  adminBotReimbursement: AdminBotReimbursementState;
  adminBotMemberNudge: AdminBotMemberNudgeState;
  // Last press of the CV digest job. Session-scoped: the durable record of a run is the audit
  // row and the document it wrote, so this only has to survive long enough to report the outcome.
  adminBotCvDigestJob: AdminBotCvDigestJobState;
  adminBotVenuePapers: AdminBotVenuePapersState;
  adminBotLabPapers: AdminBotLabPapersState;
  adminBotWorkshopNudges: WorkshopNudgeReviewState;
  adminBotVenueIndexJob: AdminBotCvDigestJobState;
  adminBotChannelNamingJob: AdminBotCvDigestJobState;
  // What the "Add project" form knows about the workspace's Slack channels. Loaded only when a
  // member ticks the already-exists box, because it is a walk over the whole workspace.
  myWorkChannelCheck: SlackChannelCheck;
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
  adminBotMeetingsRequestVersion?: number;
  adminBotMeetingsLoadingMore: boolean;
  adminBotMeetingsNextCursor: MeetingCursor | null;
  adminBotMeetingsVisibleCount: number;
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
  adminBotBroadcast?: LabBroadcast | null;
  adminBotBroadcastHistory?: LabBroadcast[];
  adminBotBroadcastDraft?: string;
  adminBotBroadcastBusy?: boolean;
  adminBotBroadcastNotice?: { kind: "success" | "error"; text: string } | null;
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
    emailReviews: [],
    emailReviewCandidates: [],
    emailReviewHistory: [],
    members: [],
    papers: [],
    papersLoadedAt: null,
    nudges: [],
    settings: null,
    loadedAt: null,
  };
}

export function createEmptyAdminBotMemberList(): AdminBotMemberListState {
  return {
    rows: [],
    total: 0,
    limit: 50,
    offset: 0,
    query: "",
    loading: false,
    error: null,
    loadedAt: null,
  };
}

export async function loadAdminBotMemberList(
  host: AdminBotHost,
  query = host.adminBotMemberList?.query ?? "",
  offset = host.adminBotMemberList?.offset ?? 0,
): Promise<void> {
  const previous = host.adminBotMemberList ?? createEmptyAdminBotMemberList();
  const limit = previous.limit;
  const pending: AdminBotMemberListState = {
    ...previous,
    rows: query === previous.query && offset === previous.offset ? previous.rows : [],
    query,
    offset,
    loading: true,
    error: null,
  };
  host.adminBotMemberList = pending;
  const session = loadStoredMemberSession();
  const isCurrent = () =>
    host.adminBotMemberList === pending &&
    loadStoredMemberSession()?.sessionToken === session?.sessionToken;
  try {
    if (!session) {
      const search = query.trim().toLocaleLowerCase();
      const matches = host.adminBotData.members.filter((member) =>
        [
          member.name,
          member.email,
          ...(member.research_topics ?? []),
          ...(member.projects ?? []),
        ].some((value) => value?.toLocaleLowerCase().includes(search)),
      );
      host.adminBotMemberList = {
        rows: matches.slice(offset, offset + limit),
        total: matches.length,
        limit,
        offset,
        query,
        loading: false,
        error: null,
        loadedAt: Date.now(),
      };
      return;
    }
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      q: query.trim(),
    });
    const result = await fetchMemberResource(
      `/lab/members?${params}`,
      session.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!isCurrent()) {
      return;
    }
    if (!result.ok) {
      throw new Error(
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "forbidden"
            ? "You do not have access to the lab roster."
            : "Could not load lab members. Please try again.",
      );
    }
    const response = readRecord(result.value);
    const members = readArray<AdminBotLabMember>(response, "members");
    // Older services return the complete roster. Keep the new UI usable during separate UI/API deploys.
    const filtered =
      typeof response.total === "number"
        ? members
        : members.filter((member) =>
            [
              member.name,
              member.email,
              ...(member.research_topics ?? []),
              ...(member.projects ?? []),
            ].some((value) =>
              value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
            ),
          );
    host.adminBotMemberList = {
      rows: typeof response.total === "number" ? members : filtered.slice(offset, offset + limit),
      total: typeof response.total === "number" ? response.total : filtered.length,
      limit,
      offset,
      query,
      loading: false,
      error: null,
      loadedAt: Date.now(),
    };
  } catch (error) {
    if (!isCurrent()) {
      return;
    }
    host.adminBotMemberList = {
      ...host.adminBotMemberList!,
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Load the standing meetings the Lab Members form offers as checkboxes.
 *
 * Only for a signed-in admin: the route is admin-only and names people's addresses. A failure is
 * kept as an error rather than an empty list, and the form then leaves the Meetings field out of
 * the save altogether -- see AdminBotLabMemberSaveInput.meetings.
 */
export async function loadAdminBotStandingMeetings(host: AdminBotHost): Promise<void> {
  const session = loadStoredMemberSession();
  if (!session) {
    return;
  }
  const previous = host.adminBotStandingMeetings ?? createEmptyAdminBotStandingMeetings();
  const pending = { ...previous, loading: true, error: null };
  host.adminBotStandingMeetings = pending;
  const result = await fetchStandingMeetings(
    session.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (
    host.adminBotStandingMeetings !== pending ||
    loadStoredMemberSession()?.sessionToken !== session.sessionToken
  ) {
    return;
  }
  host.adminBotStandingMeetings = result.ok
    ? { meetings: result.value, loading: false, error: null, loadedAt: Date.now() }
    : {
        ...pending,
        loading: false,
        error:
          result.kind === "unreachable"
            ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
            : (result.message ?? "Could not load the lab's meetings."),
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

export function readRecord(value: unknown): Record<string, unknown> {
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

export function formatAdminBotToolError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/tool not available:\s*adminbot_/iu.test(message) || /unknown tool/iu.test(message)) {
    return ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE;
  }
  return message;
}

export async function invokeAdminBotTool(
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

// Signed-in read path. The own profile is always required; the full paper list is required only
// when the active page uses it. Privileged extras are best-effort and stay empty when refused.
async function loadAdminBotOverSession(
  host: AdminBotHost,
  mode: AdminBotLoadMode,
  session: { sessionToken: string; baseUrl: string },
  includePapers: boolean,
): Promise<void> {
  const isCurrent = () => loadStoredMemberSession()?.sessionToken === session.sessionToken;
  host.adminBotLoading = true;
  host.adminBotError = null;
  host.adminBotUsingCachedReads = false;
  let usedCache = false;
  const read = async (path: string): Promise<unknown> => {
    const result = await fetchMemberResource(path, session.sessionToken, session.baseUrl);
    if (!result.ok) {
      throw new Error(
        result.kind === "unreachable" ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE : result.kind,
      );
    }
    if (result.cached) {
      usedCache = true;
    }
    return result.value;
  };
  const optional = async (path: string): Promise<unknown> => {
    const result = await fetchMemberResource(path, session.sessionToken, session.baseUrl);
    if (result.ok && result.cached) {
      usedCache = true;
    }
    return result.ok ? result.value : undefined;
  };
  const readSelf = async (): Promise<unknown> => {
    const result = await fetchMemberResource(
      "/lab/members/self",
      session.sessionToken,
      session.baseUrl,
    );
    if (result.ok) {
      if (result.cached) usedCache = true;
      return result.value;
    }
    if (result.kind !== "not-found" || !host.memberId) {
      throw new Error(
        result.kind === "unreachable" ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE : result.kind,
      );
    }
    // During an API-first rollout the old service has only the unpaged roster route. Filter its
    // already-redacted response to the authenticated member; never cache peers on this cold path.
    const legacy = await read("/lab/members");
    return {
      member: readArray<AdminBotLabMember>(legacy, "members").find(
        (member) => member.id === host.memberId,
      ),
    };
  };
  try {
    const selfResponse = await readSelf();
    if (!isCurrent()) {
      return;
    }
    const self = readRecord(readRecord(selfResponse).member) as AdminBotLabMember;
    if (!self.id) {
      throw new Error("Your member profile could not be loaded.");
    }
    const memberRows = host.adminBotRosterLoadedAt
      ? [...host.adminBotData.members.filter((member) => member.id !== self.id), self]
      : [self];
    // A roster request can finish while the slower paper request is in flight.
    const currentMemberRows = () =>
      host.adminBotRosterLoadedAt ? host.adminBotData.members : memberRows;
    // The profile and public deadlines can render while the larger paper read is still pending.
    // A reload after a save keeps what is already on screen and replaces it as reads land; clearing
    // it first blanked the whole page for the length of the reload.
    host.adminBotData = { ...host.adminBotData, members: memberRows };
    host.requestUpdate?.();
    const papers = includePapers ? await read("/papers") : undefined;
    if (!isCurrent()) {
      return;
    }
    host.adminBotData = {
      ...host.adminBotData,
      members: currentMemberRows(),
      ...(includePapers
        ? { papers: readArray<AdminBotPaperRecord>(papers, "papers"), papersLoadedAt: Date.now() }
        : {}),
      // Admin queues still need their own read before the first dashboard is complete; a reload
      // keeps the previous stamp so the page stays drawn.
      loadedAt: mode === "general" ? Date.now() : host.adminBotData.loadedAt,
    };
    host.requestUpdate?.();
    host.adminBotUsingCachedReads = usedCache;
    if (mode === "general") {
      return;
    }
    // The sensitive-info notes are read by the Settings tab alone (loadAdminBotSensitiveInfo), so
    // they no longer ride along on every admin page load.
    const [pending, emailReview, nudges, conferenceRosters, settings] = await Promise.all([
      optional("/proposals/pending?limit=50"),
      optional("/automation/email/review"),
      optional("/papers/nudges"),
      optional("/papers/conference-rosters"),
      optional("/settings"),
    ]);
    if (!isCurrent()) {
      return;
    }
    const settingsRecord = readRecord(settings);
    host.adminBotData = {
      proposals: readArray<AdminBotActionProposal>(pending, "proposals"),
      emailReviews: readArray<AdminBotEmailReviewItem>(emailReview, "reviews"),
      emailReviewCandidates: readArray<AdminBotEmailReviewPaperflowCandidate>(
        emailReview,
        "paperflow_candidates",
      ),
      emailReviewHistory: readArray<AdminBotResolvedEmailReviewItem>(
        emailReview,
        "recent_resolutions",
      ),
      members: currentMemberRows(),
      papers: host.adminBotData.papers,
      papersLoadedAt: host.adminBotData.papersLoadedAt,
      nudges: readArray<AdminBotPaperNudge>(nudges, "nudges"),
      conferenceRosters: readConferenceRosters(conferenceRosters),
      settings:
        Object.keys(settingsRecord).length > 0 ? (settingsRecord as AdminBotSettings) : null,
      sensitiveInfo: host.adminBotData.sensitiveInfo,
      loadedAt: Date.now(),
    };
    host.adminBotUsingCachedReads = usedCache;
  } catch (err) {
    if (isCurrent()) {
      host.adminBotError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (isCurrent()) {
      host.adminBotLoading = false;
      const pendingCount = await pendingQueuedAdminBotWriteCount(
        session.sessionToken,
        session.baseUrl,
      );
      if (isCurrent()) host.adminBotOfflinePendingWrites = pendingCount;
    }
  }
}

let sensitiveInfoRequest: { token: string; promise: Promise<void> } | null = null;

/** The admin-only sensitive-info notes, read when the Settings tab opens rather than on boot. */
export function loadAdminBotSensitiveInfo(host: AdminBotHost, force = false): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return Promise.resolve();
  }
  if (sensitiveInfoRequest?.token === stored.sessionToken && !force) {
    return sensitiveInfoRequest.promise;
  }
  const promise = (async () => {
    const result = await fetchMemberResource(
      "/sensitive-info",
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (loadStoredMemberSession()?.sessionToken !== stored.sessionToken || !result.ok) {
      return;
    }
    const record = readRecord(result.value);
    const markdown = readString(record, "markdown");
    const filePath = readString(record, "path");
    host.adminBotData = {
      ...host.adminBotData,
      sensitiveInfo: markdown ? { markdown, ...(filePath ? { path: filePath } : {}) } : null,
    };
  })();
  sensitiveInfoRequest = { token: stored.sessionToken, promise };
  return promise;
}

/** Full roster only for surfaces that use other members' schedules, names, or badges. */
export async function loadAdminBotRoster(host: AdminBotHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored || host.adminBotRosterLoading || host.adminBotRosterLoadedAt) {
    return;
  }
  const requestId = (host.adminBotRosterRequestId ?? 0) + 1;
  host.adminBotRosterRequestId = requestId;
  host.adminBotRosterLoading = true;
  host.adminBotRosterError = null;
  const isCurrent = () =>
    host.adminBotRosterRequestId === requestId &&
    loadStoredMemberSession()?.sessionToken === stored.sessionToken;
  try {
    const result = await fetchMemberResource(
      "/lab/members?view=summary",
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!isCurrent()) {
      return;
    }
    if (!result.ok) {
      throw new Error(
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : "Could not load lab members. Please try again.",
      );
    }
    const response = readRecord(result.value);
    const self = readRecord(response.self) as AdminBotLabMember;
    const roster = readArray<AdminBotLabMember>(response, "members");
    host.adminBotData = {
      ...host.adminBotData,
      members: self.id ? roster.map((member) => (member.id === self.id ? self : member)) : roster,
    };
    host.adminBotRosterLoadedAt = Date.now();
  } catch (error) {
    if (isCurrent()) {
      host.adminBotRosterError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (isCurrent()) {
      host.adminBotRosterLoading = false;
    }
  }
}

// Defaults are for the reload after a write: the viewer's own mode (a plain member asked in admin
// mode spends five reads on queues the service refuses), and the lab paper list only when this
// session has already loaded it -- a write on a page without papers has nothing to refresh there.
export async function loadAdminBot(
  host: AdminBotHost,
  mode: AdminBotLoadMode = loadStoredMemberSession() && host.memberPrivilegeLevel !== "admin"
    ? "general"
    : "admin",
  includePapers = Boolean(host.adminBotData.papersLoadedAt),
  preserveRoster = false,
): Promise<void> {
  // A write may have changed a member row; the next roster-dependent tab reloads it on demand.
  // Opening a paper page after a non-paper page changes no member rows, so keep its loaded roster.
  if (!preserveRoster) {
    // Profile edits may also change the Dashboard map; only that tab will fetch it again.
    invalidateMemberMap(host);
    host.adminBotRosterRequestId = (host.adminBotRosterRequestId ?? 0) + 1;
    host.adminBotRosterLoadedAt = null;
    host.adminBotRosterLoading = false;
    host.adminBotRosterError = null;
  }
  if (!preserveRoster && host.adminBotMemberList?.loadedAt) {
    host.adminBotMemberList = { ...host.adminBotMemberList, loadedAt: null };
  }
  // A signed-in member reads through their own session. The gateway tool path needs
  // operator.write, which a plain member's paired device deliberately does not hold, so for them
  // every tool call fails and the dashboard renders empty -- including after a successful save,
  // which is what made edits look like they never persisted.
  const stored = loadStoredMemberSession();
  if (stored) {
    await loadAdminBotOverSession(
      host,
      mode,
      {
        sessionToken: stored.sessionToken,
        baseUrl: resolveAdminBotBaseUrl(host.settings),
      },
      includePapers,
    );
    if (loadStoredMemberSession()?.sessionToken !== stored.sessionToken) {
      return;
    }
    return;
  }
  const startingClient = host.client;
  const gatewayLoadIsCurrent = () =>
    loadStoredMemberSession() === null && host.client === startingClient;
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
      if (!gatewayLoadIsCurrent()) {
        return;
      }
      host.adminBotData = {
        ...createEmptyAdminBotDashboardData(),
        members: readArray<AdminBotLabMember>(members, "members"),
        papers: readArray<AdminBotPaperRecord>(papers, "papers"),
        papersLoadedAt: Date.now(),
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
    if (!gatewayLoadIsCurrent()) {
      return;
    }
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
      emailReviews: [],
      emailReviewCandidates: [],
      emailReviewHistory: [],
      members: readArray<AdminBotLabMember>(members, "members"),
      papers: readArray<AdminBotPaperRecord>(papers, "papers"),
      papersLoadedAt: Date.now(),
      nudges: readArray<AdminBotPaperNudge>(nudges, "nudges"),
      settings:
        Object.keys(settingsRecord).length > 0 ? (settingsRecord as AdminBotSettings) : null,
      sensitiveInfo: markdown ? { markdown, ...(filePath ? { path: filePath } : {}) } : null,
      loadedAt: Date.now(),
    };
  } catch (err) {
    if (gatewayLoadIsCurrent()) {
      host.adminBotError = formatAdminBotToolError(err);
    }
  } finally {
    if (gatewayLoadIsCurrent()) {
      host.adminBotLoading = false;
    }
  }
}

// Approvals require a real privileged member session — the gateway service principal is
// rejected by the server (403) so that chat-driven privileged actions are impossible.
/**
 * The session if there is one, and the base URL either way.
 *
 * For the surfaces the access table opens to visitors: the conference-paper index is a published
 * programme and the search writes nothing, so it is readable without an account. The service is
 * still the authority -- these two routes are in its ANONYMOUS_ROUTES and rate-limited per IP like
 * the reimbursement pair; this only stops the UI refusing to ask.
 */
export function optionalSession(host: AdminBotHost): {
  sessionToken: string | null;
  baseUrl: string;
} {
  return {
    sessionToken: loadStoredMemberSession()?.sessionToken ?? null,
    baseUrl: resolveAdminBotBaseUrl(host.settings),
  };
}

export function requirePrivilegedSession(
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
export function cvErrorText(kind: string, action: string): string {
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

export function setAdminBotVenue(host: AdminBotHost, venueId: string): void {
  // The old result belonged to a different conference; keeping it on screen under a new heading
  // would be a lie about what was searched.
  host.adminBotVenuePapers = {
    ...host.adminBotVenuePapers,
    venueId,
    categories: [],
    loadingCategories: Boolean(venueId),
    categoryId: "",
    searching: false,
    result: null,
    error: null,
    expanded: [],
  };
  if (venueId) {
    void loadAdminBotVenueCategories(host);
  }
}

export async function loadAdminBotVenueCategories(host: AdminBotHost): Promise<void> {
  const venueId = host.adminBotVenuePapers.venueId;
  const requestedCategoryId = host.adminBotVenuePapers.categoryId;
  if (!venueId) {
    return;
  }
  const session = optionalSession(host);
  host.adminBotVenuePapers = {
    ...host.adminBotVenuePapers,
    loadingCategories: true,
    categories: [],
  };
  const result = await fetchVenueCategories(venueId, session.sessionToken, session.baseUrl);
  // A quick second selection must not let the first conference's slower response win the race.
  if (host.adminBotVenuePapers.venueId !== venueId) {
    return;
  }
  const categories = result.ok ? result.value.categories : [];
  host.adminBotVenuePapers = {
    ...host.adminBotVenuePapers,
    loadingCategories: false,
    categories,
    categoryId: categories.some((category) => category.id === requestedCategoryId)
      ? requestedCategoryId
      : "",
    error: result.ok
      ? null
      : result.message?.trim() || cvErrorText(result.kind, "load conference categories"),
  };
}

export function setAdminBotVenueCategory(host: AdminBotHost, categoryId: string): void {
  host.adminBotVenuePapers = {
    ...host.adminBotVenuePapers,
    categoryId,
    searching: false,
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

export function setWorkshopConference(host: AdminBotHost, key: string): void {
  host.adminBotWorkshopNudges = { ...host.adminBotWorkshopNudges, conferenceKey: key };
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

export function toggleAdminBotSelectedAction(host: AdminBotHost, proposalId: string): void {
  const selected = host.adminBotSelectedActionIds;
  host.adminBotSelectedActionIds = selected.includes(proposalId)
    ? selected.filter((id) => id !== proposalId)
    : [...selected, proposalId];
}

// Bulk-set the ticked rows -- used by the header checkbox, which both selects every listed
// proposal and (ticked again) clears the selection. Mirrors setAdminBotNudgeRecipients.
export function setAdminBotSelectedActions(host: AdminBotHost, proposalIds: string[]): void {
  host.adminBotSelectedActionIds = proposalIds;
}

// Autosaves can overlap when a member pauses and then keeps typing. Queue writes to the same
// record in request order: ignoring an old response is not enough if the server commits it last.
const memberSaveQueues = new WeakMap<AdminBotHost, Map<string, Promise<void>>>();

export function serializeMemberSave(
  host: AdminBotHost,
  key: string,
  work: () => Promise<void>,
): Promise<void> {
  let queue = memberSaveQueues.get(host);
  if (!queue) {
    queue = new Map();
    memberSaveQueues.set(host, queue);
  }
  const pending = (queue.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
  queue.set(key, pending);
  return pending.finally(() => {
    if (queue?.get(key) === pending) {
      queue.delete(key);
    }
  });
}

/** Queues the onboarding guide for a member just saved, and says what became of it. */
export async function onboardSavedMember(
  host: AdminBotHost,
  memberId: string,
  sessionToken: string,
  slackChannels?: string[],
): Promise<{ kind: "success" | "error"; text: string }> {
  const result = await queueMemberOnboardingGuide(
    memberId,
    sessionToken,
    resolveAdminBotBaseUrl(host.settings),
    slackChannels,
  );
  if (!result.ok) {
    const reason =
      result.kind === "unreachable"
        ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
        : result.kind === "forbidden"
          ? "your session no longer has admin access"
          : // The service names what it refused -- no address, a Member Type that sends no mail, a
            // guide already sent or queued -- and that sentence is the whole value of this notice.
            (result.message ?? "the onboarding guide could not be queued");
    return {
      kind: "error",
      text: `Saved member ${memberId}, but their onboarding guide was not queued: ${reason}`,
    };
  }
  return {
    kind: "success",
    text:
      result.value.status === "done"
        ? `Saved member ${memberId}. Their standard onboarding email has been sent.`
        : `Saved member ${memberId}. Their ${result.value.template_id} onboarding email draft is queued in Pending Actions. An admin must review, approve, and execute it there; no email has been sent yet.`,
  };
}

/** What the project form knows about the workspace's channels. */
export type SlackChannelCheck = {
  /** The member ticked "this channel already exists". */
  enabled: boolean;
  /** Channel names, once loaded. Null while unknown -- which is not the same as empty. */
  channels: string[] | null;
  loading: boolean;
  /** Set when the check could not be made at all. The form then asks rather than asserts. */
  error: string | null;
};

export const EMPTY_SLACK_CHANNEL_CHECK: SlackChannelCheck = {
  enabled: false,
  channels: null,
  loading: false,
  error: null,
};

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
): Promise<boolean> {
  host.adminBotNotice = null;
  const artifacts = {
    ...(paper.overleafEditUrl ? { overleaf_edit_url: paper.overleafEditUrl } : {}),
    ...(paper.overleafViewUrl ? { overleaf_view_url: paper.overleafViewUrl } : {}),
    ...(paper.overleafShareUrl ? { overleaf_share_url: paper.overleafShareUrl } : {}),
    ...(paper.brainstormingDocUrl ? { brainstorming_doc_url: paper.brainstormingDocUrl } : {}),
    ...(paper.submissionUrl ? { submission_url: paper.submissionUrl } : {}),
    ...(paper.googleDrivePdfUrl ? { google_drive_pdf_url: paper.googleDrivePdfUrl } : {}),
    ...(paper.arxivUrl ? { arxiv_url: paper.arxivUrl } : {}),
    ...(paper.googleSlidesUrl ? { google_slides_url: paper.googleSlidesUrl } : {}),
    ...(paper.posterUrl ? { poster_url: paper.posterUrl } : {}),
    // Sent even when empty, because clearing every venue has to be able to erase the key.
    ...(paper.venueTargets === undefined ? {} : { venue_targets: paper.venueTargets }),
    ...(paper.publicationTrack === undefined ? {} : { publication_track: paper.publicationTrack }),
    ...(paper.decisionSeen ? { decision_seen: paper.decisionSeen } : {}),
    // Sent even when empty so an accidental acknowledgement can be undone.
    ...(paper.decisionEmailSent === undefined
      ? {}
      : { decision_coauthor_email_sent: paper.decisionEmailSent }),
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
  // The author's own details, editable from their card. Kept apart from `acceptance` below only
  // because the latter needs to preserve explicit blank values used by the "Not said" controls.
  const details = {
    ...(paper.feedbackGivers === undefined ? {} : { feedback_givers: paper.feedbackGivers }),
    ...(paper.authorRoles === undefined ? {} : { author_roles: paper.authorRoles }),
    ...(paper.alias === undefined ? {} : { alias: paper.alias }),
    ...(paper.startedOn === undefined ? {} : { started_on: paper.startedOn }),
    ...(paper.authorLinks === undefined ? {} : { author_links: paper.authorLinks }),
    ...(paper.venue === undefined ? {} : { venue: paper.venue }),
  };
  const acceptance = {
    ...(paper.venueDecision ? { venue_decision: paper.venueDecision } : {}),
    ...(paper.acceptedVenue === undefined ? {} : { accepted_venue: paper.acceptedVenue }),
    ...(paper.acceptedYear === undefined
      ? {}
      : { accepted_year: paper.acceptedYear === "" ? "" : Number(paper.acceptedYear) }),
    ...(paper.isArchival === undefined
      ? {}
      : { is_archival: paper.isArchival === "" ? "" : paper.isArchival === "true" }),
    // Sent even when empty, so clearing the choice actually clears it. Dropping falsy values
    // here made Reset look like it worked and then quietly leave the old track on file.
    ...(paper.presentationType === undefined ? {} : { presentation_type: paper.presentationType }),
  };
  // Prefer the member's own session: the service scopes the write to what that member may change
  // (any paper for an admin, their own for an author). The gateway tool path stays as the fallback
  // for break-glass sessions that hold a gateway token but no member login.
  const stored = loadStoredMemberSession();
  if (stored) {
    let success = false;
    await serializeMemberSave(
      host,
      JSON.stringify(["paper", stored.sessionToken, paper.id]),
      async () => {
        if (loadStoredMemberSession()?.sessionToken !== stored.sessionToken) {
          return;
        }
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
        if (loadStoredMemberSession()?.sessionToken !== stored.sessionToken) {
          return;
        }
        if (!saved.ok) {
          host.adminBotNotice = { kind: "error", text: paperSaveErrorText(saved.kind) };
          return;
        }
        success = true;
        host.adminBotNotice = { kind: "success", text: `Saved paper ${paper.id}.` };
        const updated = saved.value as AdminBotPaperRecord;
        if (updated?.id === paper.id) {
          const papers = host.adminBotData.papers;
          host.adminBotData = {
            ...host.adminBotData,
            papers: papers.some((row) => row.id === paper.id)
              ? papers.map((row) => (row.id === paper.id ? { ...row, ...updated } : row))
              : [...papers, updated],
          };
        }
      },
    );
    return success;
  }
  try {
    await invokeAdminBotTool(host, "adminbot_upsert_paper", {
      id: paper.id,
      title: paper.title,
      authors: paper.authors,
      currentStep: paper.currentStep,
      ...(paper.venueDecision ? { venueDecision: paper.venueDecision } : {}),
      ...(paper.acceptedVenue === undefined ? {} : { acceptedVenue: paper.acceptedVenue }),
      ...(paper.acceptedYear === undefined
        ? {}
        : { acceptedYear: paper.acceptedYear === "" ? "" : Number(paper.acceptedYear) }),
      ...(paper.isArchival === undefined
        ? {}
        : { isArchival: paper.isArchival === "" ? "" : paper.isArchival === "true" }),
      ...(paper.presentationType === undefined ? {} : { presentationType: paper.presentationType }),
      ...(Object.keys(artifacts).length > 0 ? { artifacts } : {}),
      ...(paper.reminderStatus ? { reminder: { status: paper.reminderStatus } } : {}),
    });
    host.adminBotNotice = { kind: "success", text: `Saved paper ${paper.id}.` };
    await loadAdminBot(host, undefined, undefined, true);
    return true;
  } catch (err) {
    host.adminBotNotice = {
      kind: "error",
      text: formatAdminBotToolError(err),
    };
    return false;
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

export async function saveAdminBotSensitiveInfo(
  host: AdminBotHost,
  markdown: string,
): Promise<void> {
  host.adminBotNotice = null;
  try {
    await invokeAdminBotTool(host, "adminbot_update_sensitive_info", { markdown });
    host.adminBotNotice = { kind: "success", text: "Saved sensitive-information markdown." };
    // Nothing else changed, so patch the one field instead of reloading the whole workspace.
    const path = host.adminBotData.sensitiveInfo?.path;
    host.adminBotData = {
      ...host.adminBotData,
      sensitiveInfo: { markdown, ...(path ? { path } : {}) },
    };
  } catch (err) {
    host.adminBotNotice = {
      kind: "error",
      text: formatAdminBotToolError(err),
    };
  }
}

/**
 * Choose the finance office, and start the claim over on that ruleset.
 *
 * Changing funder clears the conversation rather than re-checking what is there: the two rulesets
 * ask for different evidence, so a draft assembled under one has gaps the other never prompted
 * for. Carrying it across would produce a package that looks checked and is not. The picker
 * disables itself once a conversation exists, so this only ever runs on an empty one.
 */
export function setAdminBotReimbursementFunder(
  host: Pick<AdminBotHost, "adminBotReimbursement">,
  funder: AdminBotReimbursementFunder,
): void {
  host.adminBotReimbursement = { ...createEmptyAdminBotReimbursementState(), funder };
}

// Narrowed to the slice it writes so the guest host (which has no client/session) can reuse it.
export function resetAdminBotReimbursement(
  host: Pick<AdminBotHost, "adminBotReimbursement">,
): void {
  host.adminBotReimbursement = createEmptyAdminBotReimbursementState();
}

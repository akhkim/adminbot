// Generated from extensions/adminbot/content/deadlines by
// scripts/adminbot-deadline-collect.py. Do not hand-edit; regenerate instead.

export type DeadlineRevision = {
  observed_at: string;
  deadline_aoe: string;
  deadline_at?: string;
  deadline_date?: string;
  deadline_timezone?: string;
  deadline_time_precision?: string;
  deadline_planning_at?: string;
  notification_aoe?: string;
  deadline_label?: string;
  link?: string;
};

/** One dated stage of a venue's calendar, other than the submission itself. */
export type DeadlineMilestone = {
  /** reviews | rebuttal | notification | cycle_end | camera_ready | conference */
  milestone: string;
  label: string;
  source_url?: string;
  evidence?: string;
  /** How to read the date: an AoE cutoff, a day the venue acts on, or a span. */
  kind: "deadline" | "date" | "period";
  /** Set for kind "deadline" and "date". */
  date?: string;
  /** Both set for kind "period". */
  starts?: string;
  ends?: string;
  timezone?: string;
  planning_at?: string;
};

export type DeadlineVenue = {
  notification_policy?: DeadlineMilestone & { status: string; checked_at?: string; evidence?: string };
  notification_status?: string;
  notification_previous_aoe?: string;
  notification_issues?: string[];
  deadline_observations?: { date: string; precision: string; source_url: string; document_id: string; extraction_kind: string; milestone: string; evidence: string; decision: string }[];
  abstract_requirement?: "required" | "not_required" | "unknown";
  abstract_requirement_evidence?: string;
  abstract_requirement_source_url?: string;
  abstract_requirement_conflict?: boolean;
  abstract_deadline_id?: string;
  id: string;
  name: string;
  venue_type: string;
  venue_group: string;
  deadline_at?: string;
  deadline_date?: string;
  deadline_timezone?: string;
  deadline_time_precision?: string;
  deadline_planning_at?: string;
  /** Stable dated-deadline identity; equal to the legacy id. */
  deadline_id: string;
  /** Canonical venue identity, with every accepted legacy form listed below. */
  venue_id: string;
  venue_aliases: string[];
  revisions: DeadlineRevision[];
  stale: boolean;
  track?: string;
  /** Conference family, e.g. "EMNLP". Empty when it is not one the lab tracks. */
  venue_family?: string;
  /** Where the parent conference meets, e.g. "Budapest, Hungary". A workshop
   *  inherits its conference's location. A multi-site event lists every site,
   *  separated by "; " — NeurIPS 2026 runs in Sydney, Atlanta and Paris at once.
   *  Empty for a venue with no fixed location (ARR cycles) or none published. */
  conference_location?: string;
  /** The one site a workshop meets at, when its own page named one —
   *  always one of the sites in `conference_location`, never a city from
   *  anywhere else. Empty when the parent has a single site (the inherited
   *  value already answers it), when the page named none of them, or when it
   *  named several and so has not said which. Read it in preference to
   *  `conference_location`, and fall back to that when it is empty. */
  workshop_location?: string;
  entry_type: "main_conference" | "demo_track" | "workshop" |
    "arr_direct_submission" | "arr_commitment" | "rebuttal" | "other";
  archival_status: "archival" | "non_archival" | "mixed" | "unknown";
  venue_priority: "primary" | "secondary" | "standard";
  /** Compatibility boolean. New consumers use archival_status. */
  archival?: boolean;
  /** ARR route: "direct" submits fresh, "commitment" attaches existing reviews. */
  submission_type?: string;
  /** Which sub-deadline this row is: abstract, full_paper, camera_ready, ...
   *  See MILESTONES in scripts/adminbot_deadlines.py. Empty when unclassified. */
  milestone?: string;
  /** The rest of this venue's calendar after the submission above: reviews,
   *  rebuttal window, decisions, camera-ready, the conference itself. Empty
   *  when the venue has published none of it. The board counts down to the
   *  submission only; these render as a quiet list beside it. */
  schedule: DeadlineMilestone[];
  schedule_status?: string;
  schedule_issues?: string[];
  schedule_checked_at?: string;
  schedule_extracted_at?: string;
  deadline_label: string;
  deadline_aoe: string;
  notification_aoe?: string;
  link?: string;
  homepage_url?: string;
  cfp_url?: string;
  openreview_url?: string;
  source_url?: string;
  source_checked_at?: string;
  deadline_source_kind?: string;
  deadline_source_status?: string;
  deadline_source_precision?: string;
  deadline_official_url?: string;
  deadline_extended: boolean;
  deadline_history_status?: string;
};

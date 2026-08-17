export const adminBotRiskTiers = ["T0", "T1", "T2", "T3", "T4"] as const;

export type AdminBotRiskTier = (typeof adminBotRiskTiers)[number];

export const adminBotActionTypes = [
  "candidate.accept_for_trial",
  "candidate.accept_direct",
  "candidate.decline",
  "slack.invite_guest",
  "slack.invite_member",
  "slack.send_message",
  "slack.profile_photo_update",
  "slack.channel_naming_notify_owner",
  "slack.rename_channel",
  "vector.invite",
  "calendar.create_tentative_hold",
  "calendar.send_invite",
  // Adds people to an event that already exists. Distinct from `calendar.reschedule`, which is the
  // only other way to touch an existing event: that one writes the whole attendee list, so using it
  // to invite two people would uninvite everyone already on the event.
  "calendar.add_attendees",
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

/**
 * The profile fields a member is expected to fill in, in the order the profile page asks for them.
 *
 * One list, deliberately here rather than on either side that uses it. The Control UI renders the
 * required marks and the completion ledger from this; the service's daily reminder chases exactly
 * the same set. Those were two hand-maintained lists that disagreed from the day they were written
 * — the service chased five fields the page called optional, and the page marked eight the service
 * never mentioned — so a member could fill in everything the page asked and still be nudged, or be
 * nudged for something the page told them was skippable. The contracts module is the one place both
 * may import (`extensions/` must not reach into `ui/`, and the UI already takes
 * `adminBotMemberRoles` from here), so it is the only place the list can live and stay true.
 *
 * Membership is "the member sheet's own columns, plus the CV": what the lab keeps a record of for
 * everyone. Fields that not everyone has an answer for (a Twitter, a graduation month) stay out —
 * a checklist that can never reach zero stops being a checklist and just nags. So do the fields the
 * lab plans *with* rather than files (hours per week, timezone): they are still editable and still
 * on the page, they simply are not what a member is chased about.
 *
 * `name` is here because the profile page marks it required, but the service leaves it out of the
 * reminder: validateLabMember already refuses to store a member without one, so it can never be the
 * reason a stored record is incomplete.
 *
 * `slack_user_id` is deliberately absent. It is still stored and still self-editable through the
 * whitelist -- the Slack directory sync writes it -- but it is no longer a field anybody types, so
 * chasing a member for it would be nagging them about something they cannot fix.
 */
export const adminBotMandatoryProfileFields = [
  "name",
  "calendar_email",
  "location",
  "research_topics",
  "correspondence_email",
  "whatsapp",
  "joined_month",
  "github_url",
  "linkedin_url",
  "linkedin_urn",
  "cv_url",
  "intake_form_url",
  "openreview_id",
] as const;

export type AdminBotMandatoryProfileField = (typeof adminBotMandatoryProfileFields)[number];

/**
 * Plain-English names for the fields above, used to compose the reminder.
 *
 * Deliberately not the UI's translated labels: this text goes out over Slack to a member who has no
 * locale set on it, and the message has to be byte-identical for every recipient so it can be sent
 * once rather than composed per person.
 */
export const adminBotMandatoryProfileFieldLabels: Record<AdminBotMandatoryProfileField, string> = {
  name: "Name",
  calendar_email: "Calendar email",
  location: "Location",
  research_topics: "Research topics",
  correspondence_email: "Correspondence email",
  whatsapp: "WhatsApp",
  joined_month: "Joined month",
  github_url: "GitHub",
  linkedin_url: "LinkedIn",
  linkedin_urn: "LinkedIn URN",
  cv_url: "CV",
  intake_form_url: "Application form response link",
  openreview_id: "OpenReview",
};

/**
 * When a member counts as active in Slack.
 *
 * One threshold, here rather than on either side that uses it, for the same reason the mandatory
 * profile fields ended up in one list: the sweep that counts messages and the badge that reads the
 * count must agree, or a member is told they are active by one surface and inactive by the other.
 *
 * Two messages rather than one: a single message is as likely to be an emoji reaction thread or an
 * out-of-office note as it is participation. Seven days rather than a month because the question the
 * badge answers is "is this person around right now".
 */
export const adminBotSlackActivityWindowDays = 7;
export const adminBotSlackActivityThreshold = 2;

/** Active, inactive, or not yet measured. */
export type AdminBotSlackActivity = "active" | "inactive" | "unknown";

/**
 * Whether a member reads as active from what the last sweep stored.
 *
 * `unknown` is a real answer and the default: before the first sweep, and for anyone whose Slack
 * account the roster has never linked, there is no measurement. Calling those members inactive
 * would be an accusation drawn from missing data rather than from silence, so the badge shows
 * nothing at all for them.
 */
export function adminBotSlackActivityOf(member: {
  slack_user_id?: string;
  /** Messages this member sent in the last adminBotSlackActivityWindowDays, from the Slack sweep. */
  slack_messages_7d?: number;
  /** When that count was last measured. Absent means never, which reads as "unknown", not zero. */
  slack_activity_checked_at?: string;
}): AdminBotSlackActivity {
  if (!member.slack_user_id?.trim() || !member.slack_activity_checked_at?.trim()) {
    return "unknown";
  }
  const count = member.slack_messages_7d;
  if (typeof count !== "number" || !Number.isFinite(count)) {
    return "unknown";
  }
  return count >= adminBotSlackActivityThreshold ? "active" : "inactive";
}

/**
 * Member-record fields nobody but the member and an admin may read.
 *
 * `GET /lab/members` serves whole member records to every signed-in member -- the roster loads at
 * sign-in and the Control UI reads from it -- so a field on the record is readable by the whole lab
 * in devtools no matter what the UI chooses to draw. That is the right default for a roster of
 * names, topics and links. It is the wrong one for what a member discloses about their health or
 * their family, which is written for one reader.
 *
 * So these are stripped on the way out unless the caller is the member themselves or an admin.
 * The service keeps the full record for its own work; this is a boundary rule, not storage.
 */
export const adminBotConfidentialMemberFields = ["personal_circumstances"] as const;

/**
 * The schedule half of the record: readable by the member it belongs to and by admins, nobody else.
 *
 * A schedule says when someone is on holiday, which course is eating their term, that they are
 * interning somewhere else, and -- in `availability_notes` -- whatever complication they wrote up
 * for the admins. That is planning data for the people who do the planning, not roster data for the
 * whole lab, so it travels under the same rule as `adminBotConfidentialMemberFields` rather than
 * being served to every signed-in member the way names and links are.
 *
 * Stripped only for *member* callers who are neither the member nor an admin. The service principal
 * stays entitled: it drives the availability importer and the scheduling tools, which cannot plan
 * against records they cannot read.
 */
export const adminBotScheduleMemberFields = [
  "availability",
  "time_off",
  "milestones",
  "availability_notes",
  "availability_doc_url",
  "availability_updated_at",
] as const;

/**
 * A member record with the confidential fields removed unless the viewer is entitled to them.
 *
 * Deletes the keys rather than blanking them: an empty string is indistinguishable from a member
 * who wrote nothing, which would quietly tell every reader that this person has "nothing to
 * declare" -- itself a disclosure.
 */
export function redactConfidentialMemberFields<T extends { id?: string }>(
  member: T,
  viewer: { memberId?: string; isAdmin: boolean; isMemberSession?: boolean },
): T {
  const entitled = viewer.isAdmin || Boolean(viewer.memberId && viewer.memberId === member.id);
  // A non-member principal (the service token) is entitled to the schedule but not to the
  // confidential disclosures, so the two sets cannot share one early return.
  if (entitled) {
    return member;
  }
  const copy = { ...member } as Record<string, unknown>;
  for (const field of adminBotConfidentialMemberFields) {
    delete copy[field];
  }
  if (viewer.isMemberSession) {
    for (const field of adminBotScheduleMemberFields) {
      delete copy[field];
    }
  }
  return copy as T;
}

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

export type AdminBotProfilePhotoAssessment = {
  compliant: boolean;
  issues: string[];
  summary: string;
  checked_at: string;
  photo_url?: string;
  source: "ai" | "heuristic";
};

export type AdminBotProfilePhotoPolishVariant = {
  id: string;
  image_data_url: string;
  created_at: string;
  note?: string;
};

export type AdminBotProfilePhotoReviewState = {
  assessment?: AdminBotProfilePhotoAssessment;
  last_guideline_dm_at?: string;
  variants?: AdminBotProfilePhotoPolishVariant[];
  selected_variant_id?: string;
};
// Why a member is not on lab work for a stretch. `personal` and `other_project` were added for the
// Control UI's time-availability tab, which asks members to categorise their non-Jinesis time:
// `personal` is time off that is nobody's business but their own (distinct from `vacation`, which
// reads as a holiday), and `other_project` is real work that simply is not Jinesis work.
//
// Appending only: these values are stored on member records, so removing or renaming one silently
// invalidates existing rows.
export const adminBotTimeOffKinds = [
  "vacation",
  "internship",
  "course_load",
  "travel",
  "conference",
  "personal",
  "other_project",
  "other",
] as const;

export type AdminBotTimeOffKind = (typeof adminBotTimeOffKinds)[number];

// Longest a member-supplied free-text label may be. Long enough for "Reading week (CSC2515)",
// short enough that it cannot be used as a storage channel.
export const ADMINBOT_MAX_LABEL_LENGTH = 120;

// Reserved project name for hours a member has explicitly declared as spare
// capacity ("can take on something new / help others"). It is a sentinel, not a
// real project, so it never earns a categorical colour slot in the charts and
// never appears in the member's own `projects` list.
export const ADMINBOT_OPEN_PROJECT = "__open__";

// The Google account the availability importer reads planning docs as, so a member has to share
// their doc with it (Viewer is enough) or the import silently finds nothing. Must stay in step with
// the account `scripts/adminbot-drive-download.ts` downloads with; the UI shows this same value so
// the instruction can never drift from the account actually doing the reading.
//
// It names a real mailbox, so it is deployment configuration. Resolved at the use site rather than
// read at module load: this file is the contract surface every route imports, and a required env
// read here would turn a missing var into a boot failure instead of a failure on the one action
// that needs it.
export const ADMINBOT_BOT_EMAIL_ENV = "ADMINBOT_BOT_EMAIL";

export function resolveAdminBotDriveAccount(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[ADMINBOT_BOT_EMAIL_ENV]?.trim() || undefined;
}

// One allocation of weekly hours over a date range. The same shape covers both
// horizons: a near-term entry is a one-week row with a project set, a term
// baseline is a long row with `project` omitted. Keeping them one type is what
// lets the form, the validator, and the timeline renderer stay single-path.
export type AdminBotAvailabilityRow = {
  start: string;
  end: string;
  project?: string;
  hours_per_week: number;
  note?: string;
  // Optional supporting page for the commitment — a course syllabus, a project board, a shared
  // schedule. https only; see validateExternalLink in kernel/service.ts.
  link?: string;
};

export type AdminBotTimeOffRow = {
  start: string;
  end: string;
  kind: AdminBotTimeOffKind;
  // "partial" still counts toward capacity at a reduced rate; "none" zeroes the
  // week. Callers must not infer this from `kind` — a conference can be either.
  availability: "none" | "partial";
  note?: string;
  // What the member called this when `kind` is "other". The enum stays closed so the categories
  // mean the same thing lab-wide; this is the escape hatch for the one that does not fit.
  label?: string;
  link?: string;
};

// A single dated milestone on a member's horizon — a thesis deadline, a defence, graduation. A
// date rather than a range: these are moments to plan back from, not stretches of time, which is
// what keeps them out of `availability` (hours over a range) and `time_off` (absence over a range).
//
// Conference submission deadlines deliberately do NOT live here: the Control UI merges these with
// the bundled venue snapshot it already ships, so nobody retypes a date the lab already tracks.
export type AdminBotMemberMilestone = {
  date: string;
  label: string;
  link?: string;
};

export type AdminBotLabMemberInput = {
  id: string;
  name: string;
  // Governance-owned: the department directory address, required to be @cs.toronto.edu for
  // everyone except external_collaborator (see validateCsEmail in kernel/service.ts).
  email?: string;
  // Self-editable and unrestricted in domain: whatever address the member actually uses for
  // Google Calendar, which is very often not their cs.toronto.edu address.
  calendar_email?: string;
  slack_user_id?: string;
  /**
   * Free text a member may share about health or family circumstances. Confidential: see
   * adminBotConfidentialMemberFields, which strips it for every reader but the member and admins.
   */
  personal_circumstances?: string;
  /** Messages sent in the last adminBotSlackActivityWindowDays, stamped by the Slack sweep. */
  slack_messages_7d?: number;
  /** When that count was last measured. Absent means never, which reads as unknown, not zero. */
  slack_activity_checked_at?: string;
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
  // Where the member lives. The member map and the timezone suggestion are keyed on this one.
  location?: string;
  // Where the member is right now, when that is not `location` — a conference trip, a term
  // abroad, an internship. Self-editable and stored, but it was never declared here, so every
  // reader had to reach for it untyped. Audience filters on the Calendar tab read both.
  current_city?: string;
  affiliation?: string;
  timezone?: string;
  personal_website?: string;
  // OpenReview tilde id (e.g. "~Jane_Doe1"). First-class rather than buried in `notes`
  // because the reviewing-cycle automation maps OpenReview profiles back to members
  // with it, and posts assignment edges against it.
  openreview_id?: string;
  // Account links, each validated server-side against its platform's real URL shape
  // (see SOCIAL_URL_FIELDS in kernel/service.ts) so a self-edit can't stash an arbitrary
  // redirect or lookalike link behind a "GitHub" label.
  cv_url?: string;
  // The member's own copy of their intake answers. Google Forms mails each respondent an edit link
  // scoped to their single submitted response, so this is per-person and only they can produce it
  // -- the lab cannot derive it from the shared form URL, which is why it is a field they fill in
  // rather than a link the profile can render for them.
  intake_form_url?: string;
  linkedin_url?: string;
  // The numeric LinkedIn URN behind a member's profile ("ACoAAB..." or the digits form), which the
  // social automation needs to @-mention someone in a post: LinkedIn's API addresses people by URN,
  // never by the vanity URL in `linkedin_url`, and offers no way to resolve one to the other.
  // Members read theirs off https://linkedin-urn-collector.vercel.app and paste it here.
  linkedin_urn?: string;
  twitter_url?: string;
  github_url?: string;
  scholar_url?: string;
  // Never propose or assign this person as an emergency reviewer, whatever their topic
  // match. Governance-owned: it encodes a standing commitment about someone's time, so
  // it is deliberately absent from the fields a member may edit on their own profile.
  reviewer_exempt?: boolean;
  // Last location read from this person's Slack profile, stamped by the member-map
  // refresh. Kept apart from `location` so the two sources never overwrite each other:
  // `location` is what they told us when they joined, this is what Slack knows now.
  // Promoted out of the free-text `notes` column, where ui/src/ui/adminbot/data/member-notes.ts
  // encoded them as "Label: value" lines with no server-side schema. Five of that convention's
  // seven keys already had first-class fields (location, research_topics, calendar_email,
  // github_url, personal_website), so the same fact was stored in two places and whichever the
  // reader happened to consult decided the answer. These are the two that had nowhere else to go.
  joined_month?: string;
  // When they left, for alumni. Empty for everyone currently on the sheet, but it is the column the
  // roster will eventually age members out by, so it is stored rather than inferred from `status`.
  graduated_month?: string;
  whatsapp?: string;
  // The address the lab writes to for outreach, kept apart from `email` (the login identity) and
  // `calendar_email` (the Google account invites go to). The roster spreadsheet has one for every
  // member, and it is frequently neither of the other two.
  correspondence_email?: string;
  // Kept for the rows the member-sheet import filled in; the profile page no longer offers it.
  // One named column per platform only ever covered the platforms someone thought of, so what the
  // page asks for now is `other_socials` below.
  lesswrong_url?: string;
  // Anywhere else the member posts, as free text: several links and the labels saying what they
  // are. Deliberately unvalidated as a URL -- it is a paragraph, not an address.
  other_socials?: string;
  // Profile photo, normally the member's Slack avatar carried over by the directory sync. Stored
  // as a URL rather than bytes: Slack already hosts and resizes it, and copying it would leave the
  // roster serving a stale face after someone changes theirs.
  avatar_url?: string;
  // Every channel the member is in, by name, as the directory sync last observed. Only what the
  // bot can see -- a private channel it is not in is invisible to it -- so absence is not proof.
  slack_channels?: string[];
  slack_location?: string;
  slack_location_updated_at?: string;
  profile_photo_review?: AdminBotProfilePhotoReviewState;
  // Coarse (country-level) location derived from the IP address of this person's most recent
  // successful login, via IP geolocation (see ip-geolocation.ts). Distinct from `location` and
  // `slack_location`, which are both self-reported: this one is inferred, so it is never taken
  // as an input and never overwrites either — it is only ever set by the login path itself.
  last_login_at?: string;
  last_login_country?: string;
  last_login_continent?: string;
  availability?: AdminBotAvailabilityRow[];
  time_off?: AdminBotTimeOffRow[];
  // Dated milestones the member is planning back from. Self-editable like the two lists above.
  milestones?: AdminBotMemberMilestone[];
  // The complication the three lists above cannot express: a custody arrangement, a visa date that
  // may move, a medical treatment that makes some weeks unpredictable. Written for the admins who
  // plan around it -- see adminBotScheduleMemberFields, which keeps it off every other member's
  // copy of the roster -- and self-editable, because the member is the one it happens to.
  availability_notes?: string;
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
// gog connector validates what it reads -- so this is the written-down shape of what that connector
// accepts, and what an approver is approving.
//
// `body_html` is additive and optional: `body` remains the canonical copy and the only required
// one, so every payload written before this field existed is still valid and still sends. When it
// is present the connector adds an HTML alternative to the same message; it is part of the approved
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
    | "lab_member.notes_migrated"
    | "paper.upserted"
    | "paper.deleted"
    | "onboarding.guide_sent"
    | "settings.updated"
    | "auth.login_succeeded"
    | "auth.login_failed"
    | "auth.rate_limited"
    | "auth.logged_out"
    | "auth.password_changed"
    | "auth.password_reset_requested"
    | "auth.password_reset_completed"
    | "auth.password_reset_email_sent"
    | "auth.password_reset_email_failed"
    | "auth.email_changed"
    | "auth.registration_submitted"
    | "auth.registration_approved"
    | "auth.registration_rejected"
    | "auth.calendar_invite_sent"
    | "auth.calendar_invite_failed"
    | "auth.approval_email_sent"
    | "auth.approval_email_failed"
    | "auth.dcs_form_submitted"
    | "auth.dcs_form_failed"
    | "auth.location_updated"
    | "auth.location_update_failed"
    | "member_nudge.sent"
    | "mandatory_fields.reminded"
    | "onboarding.step_updated"
    | "reimbursement.anonymous_use"
    | "openreview.cycle_run"
    | "openreview.milestone_sent"
    | "openreview.milestone_blocked"
    | "openreview.assignment_changed"
    | "member_map.refreshed"
    | "member_directory.slack_synced"
    | "profile_photo.reviewed"
    | "profile_photo.guideline_nudged"
    | "profile_photo.polished"
    | "profile_photo.applied"
    | "auth.login_location_updated"
    // Slack channel-naming enforcement. The sweep renames other people's channels, which is an
    // external effect with no undo, so who triggered a pass and what it did is recorded here.
    | "slack.channel_naming_checked"
    | "slack.channel_naming_swept";
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

// A single outstanding "forgot my password" request. Only the SHA-256 of the emailed token is
// stored, so a database reader cannot mint a reset link; `used_at` is stamped instead of deleting
// the row so a replayed link is distinguishable from an expired one in the audit trail.
export type AdminBotPasswordReset = {
  token_hash: string;
  member_id: string;
  created_at: string;
  expires_at: string;
  used_at?: string | null;
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

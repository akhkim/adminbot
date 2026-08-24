export const adminBotRiskTiers = ["T0", "T1", "T2", "T3", "T4"] as const;

export type AdminBotRiskTier = (typeof adminBotRiskTiers)[number];

export const adminBotActionTypes = [
  "slack.send_message",
  "slack.profile_photo_update",
  "slack.channel_naming_notify_owner",
  "slack.rename_channel",
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
  "social_media.post_publicly",
  "paper_publish.prepare",
  "paper.overleaf_edit",
  "paper_publish.submit",
  "paper_publish.nudge_author",
  "paper_publish.escalate_to_pi",
  "join_form.classify",
  // Mailing a signed document back to the member who asked for it. An external effect (Gmail with
  // an attachment), so it is a typed action rather than a call out of the service.
  "logistics.send_signed_document",
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
/**
 * How many timeline entries count as "has actually planned their term".
 *
 * Two, from the brainstorming doc: one row is somebody trying the page out, and the people a
 * sweep is looking for are the ones who never came back to it. Shared between the service (which
 * decides who gets chased) and the Profile Overview page (which decides who is flagged), because
 * a page that flags a different set from the one the reminder chases is a page nobody trusts.
 */
export const adminBotTimelineEntryTarget = 2;

/**
 * Which onboarding test batch a member is in, if any.
 *
 * Kept on the roster rather than read from the spreadsheet it originates in: a sweep that had to
 * open an xlsx on somebody's laptop is a sweep that runs only when that laptop is open. The
 * importer writes it (scripts/adminbot-import-test-onboard.mjs); nothing else does.
 *
 * Absent is meaningful. A member with no batch and no full-member privilege is deliberately out of
 * scope for the batch sweeps -- they are the people the lab has not started onboarding.
 */
export const adminBotTestOnboardBatches = [1, 2, 3] as const;
export type AdminBotTestOnboardBatch = (typeof adminBotTestOnboardBatches)[number];

/**
 * Does the lab's own Member Type column call this person a full member?
 *
 * The spreadsheet's column S, kept verbatim: a comma-separated list like "full",
 * "full, coauthor-major", "alumni, coauthor-minor", "external-prof". Matched token-wise rather
 * than by substring, so the answer is about what the list *says* rather than what it contains.
 *
 * This exists because `privilege_level` is not the same question and makes a bad proxy for it.
 * The roster marks nearly everyone the lab has ever collaborated with as `member` -- visiting
 * professors, alumni, one-paper coauthors -- so a sweep aimed at "full members" that read
 * privilege_level addressed 47 people out of 77 who the spreadsheet does not call full, including
 * two external professors. Whoever the lab means by "full member" is written down in one place,
 * and this reads that place.
 */
export function adminBotIsFullMemberType(memberType: string | undefined): boolean {
  return (memberType ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .includes("full");
}

/**
 * Privilege levels that count as being *on* the lab rather than adjacent to it.
 *
 * The timeline chase is aimed at these and not at collaborators or trials: a term plan is a thing
 * the lab asks of its own people, and asking a coauthor at another university when they are
 * working is both useless and slightly rude.
 */
export const adminBotFullMemberPrivileges = ["member", "admin"] as const;

/** Which gap a profile reminder pass chases. See sendMandatoryFieldsReminders. */
export type AdminBotProfileReminderScope = "profile" | "timeline" | "both";

export function isAdminBotFullMember(member: { privilege_level?: string }): boolean {
  return (adminBotFullMemberPrivileges as readonly string[]).includes(member.privilege_level ?? "");
}

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

/** How many entries a member has on their Time Availability page, by list. */
export type AdminBotMemberTimelineCounts = {
  availability: number;
  time_off: number;
  milestones: number;
  trips: number;
  total: number;
};

/**
 * One member's row on the profile overview: how much of their own record they have filled in.
 *
 * `filled_field_count` is carried rather than derived so every reader agrees on the denominator --
 * the mandatory field list is versioned in this file and a client that counted it itself would
 * drift the moment a field is added.
 */
export type AdminBotMemberProfileOverviewRow = {
  id: string;
  name: string;
  status?: string;
  privilege_level: AdminBotPrivilegeLevel;
  missing_fields: string[];
  filled_field_count: number;
  timeline: AdminBotMemberTimelineCounts;
  /** When the daily reminder pass last nudged them, so nobody is chased twice in a day. */
  last_reminded_at?: string;
};

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
  // Where a member will be for the next three weeks is planning data, like the rest of this list:
  // their own to read and edit, and visible to the admins who schedule around it.
  "trips",
  "dismissed_deadlines",
  "availability_notes",
  "availability_doc_url",
  "availability_updated_at",
] as const;

/**
 * Inferred location fine-grained enough that only the member and the admins should see it.
 *
 * `last_login_country` is deliberately not here: a country has been on every member's record,
 * visible lab-wide, since login geolocation shipped. A *city* is a different disclosure -- it says
 * which neighbourhood-sized place somebody was in last night, which nobody asked to publish -- so
 * it is held to the same audience as the schedule fields above: yourself, and the admins who
 * schedule around you.
 */
export const adminBotInferredLocationMemberFields = [
  "last_login_city",
  "last_login_timezone",
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
    for (const field of adminBotInferredLocationMemberFields) {
      delete copy[field];
    }
  }
  return copy as T;
}

/**
 * One accepted paper as it sits in a venue's search index.
 *
 * The embedding vector is stored beside the paper rather than recomputed per search: a venue is
 * thousands of papers and embedding them is the expensive half of this feature, while a member's
 * own interests are one short string embedded on demand. So the index is built rarely (an admin
 * job) and read constantly.
 */
export type AdminBotVenuePaper = {
  venue_id: string;
  paper_id: string;
  title: string;
  abstract: string;
  keywords: string[];
  /** Track as the venue words it: "ICLR 2025 Oral", "ACL 2025 Findings". */
  venue: string;
  pdf_url?: string;
  forum_url: string;
  vector: number[];
};

/** What an indexed venue looks like from outside: how much is in it, and how stale it is. */
export type AdminBotVenueIndexStatus = {
  venue_id: string;
  label: string;
  paper_count: number;
  indexed_at?: string;
  /**
   * The embedding model the vectors were built with. Recorded because a query embedded by a
   * different model is not comparable to them -- it scores as noise rather than failing loudly,
   * so the mismatch has to be visible somewhere.
   */
  embedding_model?: string;
};

/** A conference an admin has made searchable. */
export type AdminBotVenueSource = {
  /** OpenReview group id, e.g. "ICLR.cc/2025/Conference". */
  id: string;
  /** What a member sees in the picker, e.g. "ICLR 2025". */
  label: string;
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
  // How many hours a week this commitment actually takes, for a "partial" row.
  //
  // A whole-day row needs no figure: it zeroes the week by definition. A partial one was a claim
  // with no number attached — "around, but less" — which no chart could draw and no admin could
  // plan against, so a member with a twelve-hour-a-week course and a member with a standing
  // Tuesday call recorded the identical row. This is that missing number, in the same unit and
  // range as `AdminBotAvailabilityRow.hours_per_week` so the two stack.
  //
  // Omitted on a "none" row, and optional on a "partial" one: rows written before this field
  // existed have no answer, and inventing one would put hours on a chart nobody typed.
  hours_per_week?: number;
  note?: string;
  // What the member called this when `kind` is "other". The enum stays closed so the categories
  // mean the same thing lab-wide; this is the escape hatch for the one that does not fit.
  label?: string;
  link?: string;
};

/**
 * A stretch away from home: a conference, an internship, a term abroad, a month at a parent's.
 *
 * A range with a place on it, which is the one thing none of the other schedule rows carry. A
 * `time_off` row says a member is unavailable and a `trips` row says nothing about availability at
 * all -- somebody working normal hours from Berlin is fully available and six hours off the lab's
 * clock, which is exactly the case that kept producing 10am invites that land at 4pm. Logged the
 * same way a commitment is, because it is the same act: a member saying in advance what their next
 * few weeks look like.
 *
 * `timezone` is optional and derived from the city by the form. It is stored rather than re-derived
 * on read so a member who corrects the guess keeps their correction.
 */
export type AdminBotMemberTrip = {
  start: string;
  end: string;
  /** Free text, the way a member writes a place: "Berlin", "Berlin, Germany", "NeurIPS (Vancouver)". */
  city: string;
  timezone?: string;
  note?: string;
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
  // The wall-clock cutoff on `date`, as "HH:MM" on a 24-hour clock, and the zone that clock is
  // read in (an IANA name — "America/Toronto", not "EST"). Both optional and both meaningless
  // alone: a time with no zone is a number a reader in another country has to guess at, and a zone
  // with no time says nothing. A milestone with neither is a whole-day deadline, which is what
  // every stored row was before these fields existed.
  //
  // Kept off `date` rather than folded into an ISO instant because the date is what the timeline,
  // the countdown and the "in N days" label all sort and bucket by; an instant would make every
  // one of them re-derive a calendar day in a zone none of them knows.
  time?: string;
  timezone?: string;
};

// "HH:MM" on a 24-hour clock, which is what <input type="time"> hands back. Seconds are not
// accepted: no deadline in this system is stated to the second, and allowing them would mean two
// spellings of the same minute.
export const ADMINBOT_DEADLINE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/u;

/**
 * Whether a string names a time zone this runtime can actually resolve.
 *
 * Asked of Intl rather than checked against a bundled list: the list a validator ships goes stale,
 * and the only zones worth storing are the ones the formatter on the other end can print.
 */
export function isAdminBotTimezone(value: string): boolean {
  try {
    // Constructing is the check -- Intl throws a RangeError on a zone it cannot resolve. The
    // formatter is read back rather than discarded so this is an expression with a use, not a
    // `new` for side effects.
    return Boolean(
      new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone,
    );
  } catch {
    return false;
  }
}

// One dated line off a CV. `kind` is what makes a change newsworthy or not: a new `position` or
// `education` entry is a career move worth announcing, an `award` is worth congratulating, and
// anything the model cannot place lands in `other` and is reported but never drafted.
export type AdminBotCvEntryKind =
  | "position"
  | "education"
  | "award"
  // A paper. `organization` carries the venue ("NeurIPS 2026", "Nature"), rather than adding a
  // field: it is the thing that identifies the work alongside its title, which is exactly what
  // `organization` does for every other kind, and cvEntryKey already keys on it.
  | "publication"
  | "other";

export type AdminBotCvEntry = {
  kind: AdminBotCvEntryKind;
  title: string;
  organization: string;
  // Free text exactly as printed on the CV ("Sept 2025", "2024-present"). Kept verbatim because
  // it is what the newsletter quotes back, and because CVs write ranges a hundred ways.
  start?: string;
  end?: string;
  // `start` normalized to YYYY-MM, for deciding whether an entry describes something that just
  // happened. Absent whenever the model could not place the date with confidence — a missing value
  // means "unknown", never "old", so an undated entry is reported for a human rather than
  // silently dropped or silently announced.
  start_iso?: string;
};

// Why an added entry is, or is not, news.
//
// A CV edit is not a career event. Someone backfilling a 2019 internship has changed their
// document, not their career, and announcing it would be wrong in a way that is obvious to every
// reader but invisible to a plain diff. The three cases are kept apart rather than collapsed into
// a boolean so the console can show what was skipped and why.
export type AdminBotCvRecency = "recent" | "backfilled" | "undated";

export type AdminBotCvSnapshot = {
  fetched_at: string;
  // Hash of the extracted CV text. A re-scan whose hash is unchanged skips the model call
  // entirely, so repeat scans over an unchanged roster cost one fetch each and nothing more.
  content_hash: string;
  entries: AdminBotCvEntry[];
};

// What one member's CV produced on a scan. `status` is a closed set rather than an ok/error pair
// so the console can tell "nothing changed" apart from "we could not read it" -- they look the
// same in a count but mean opposite things to whoever is chasing the roster.
// One entry that appeared on a CV, with the judgement of whether it is news.
export type AdminBotCvChange = {
  entry: AdminBotCvEntry;
  recency: AdminBotCvRecency;
};

export type AdminBotCvScanMemberResult = {
  member_id: string;
  member_name: string;
  status: "unchanged" | "changed" | "first_scan" | "skipped" | "failed";
  // Present when status is "failed" or "skipped": why this member produced nothing.
  reason?: string;
  added: AdminBotCvChange[];
  // Removals carry no recency: taking a line off a CV says nothing about when the thing happened,
  // and it is never drafted either way.
  removed: AdminBotCvEntry[];
};

/**
 * Identity of a CV entry, for diffing and for the stored-change primary key.
 *
 * Dates are deliberately excluded. CVs get retyped and reformatted constantly ("Sept 2025" becomes
 * "09/2025"), and keying on the date would report every such edit as a new job. Recency is judged
 * separately, from `start_iso`.
 *
 * One definition, here rather than beside either caller, because the differ and the store must
 * agree exactly: if they drifted, a change would be re-reported on every scan.
 */
export function cvEntryKey(entry: AdminBotCvEntry): string {
  const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
  return [entry.kind, normalize(entry.title), normalize(entry.organization)].join(" ");
}

// A change, as stored. `detected_at` is when the scan noticed it, which is deliberately not the
// same as when it happened — a member who updates their CV in September for a July move is
// detected in September, and the digest window is about what the lab learned, not what occurred.
export type AdminBotCvChangeEvent = {
  member_id: string;
  member_name: string;
  detected_at: string;
  recency: AdminBotCvRecency;
  entry: AdminBotCvEntry;
};

export type AdminBotCvScanResult = {
  scanned_at: string;
  results: AdminBotCvScanMemberResult[];
  // Newsletter copy built from the newsworthy additions across every member. Empty when nothing
  // changed. Draft only -- publishing is not part of this flow.
  newsletter_draft: string;
};

export type AdminBotLabMemberInput = {
  id: string;
  name: string;
  /**
   * The lab spreadsheet's "Member Type" column, verbatim ("full", "full, coauthor-major",
   * "alumni", "external-prof", ...).
   *
   * Governance-owned and imported, for the same reason the batch is: it decides who a sweep
   * addresses. Read it through adminBotIsFullMemberType rather than comparing strings.
   */
  member_type?: string;
  /**
   * Onboarding test batch, imported from the lab spreadsheet's "Test Onboard" column.
   *
   * Governance-owned: it decides who a batch sweep addresses, so it is not something a member
   * sets about themselves. See adminBotTestOnboardBatches.
   */
  test_onboard_batch?: number;
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
  /**
   * City-level location of the most recent sign-in, and the timezone the provider reports for it.
   *
   * Finer-grained than `last_login_country`, and carried for one reason: scheduling. A member who
   * flew somewhere last night has a correct clock here days before they get round to editing their
   * profile, and a country is not a timezone. Inferred like the two fields above and under the same
   * rule -- never written to `location`, `current_city` or `timezone`, which are the member's own.
   *
   * Read only alongside `last_login_at`: a city is a statement about where someone was at that
   * moment, and a month-old one says nothing about today. See ADMINBOT_LOGIN_CITY_FRESH_DAYS.
   */
  last_login_city?: string;
  last_login_timezone?: string;
  /**
   * When the member last answered the "you seem to have moved" question, either way.
   *
   * Stamped on a confirmation *and* on a dismissal, because both are answers: someone who signs in
   * from a conference for a week should be able to say "no, still Toronto" and not be asked again
   * for that trip. A later move to a different country starts a new divergence and asks again.
   */
  location_prompt_answered_at?: string;
  /** The country the member was asked about when they last answered, so a new country re-asks. */
  location_prompt_answered_country?: string;
  availability?: AdminBotAvailabilityRow[];
  time_off?: AdminBotTimeOffRow[];
  // Dated milestones the member is planning back from. Self-editable like the two lists above.
  milestones?: AdminBotMemberMilestone[];
  // Where the member is when that is not home, over a range. Self-editable like the lists above,
  // and read by anything that needs a member's local time on a given date.
  trips?: AdminBotMemberTrip[];
  /**
   * Conference deadlines from the bundled snapshot that this member has taken off their own panel.
   *
   * By venue name rather than id: the snapshot is regenerated from OpenReview, and an id that
   * shifted between regenerations would quietly resurrect a row somebody dismissed. The name is
   * also what an added venue is stored as on `milestones`, so one identity covers both directions.
   *
   * A dismissal is per member and hides nothing for anyone else -- the lab's deadline board is
   * unaffected. Re-adding the venue from the picker brings it back as the member's own row.
   */
  dismissed_deadlines?: string[];
  // The complication the three lists above cannot express: a custody arrangement, a visa date that
  // may move, a medical treatment that makes some weeks unpredictable. Written for the admins who
  // plan around it -- see adminBotScheduleMemberFields, which keeps it off every other member's
  // copy of the roster -- and self-editable, because the member is the one it happens to.
  availability_notes?: string;
  // Link to the member's own planning doc in Drive, which the availability importer reads to
  // prefill the rows above. Member-owned and self-editable: whatever the importer gets wrong, the
  // member fixes in the same panel.
  availability_doc_url?: string;
  // Career facts from the last successful CV scan, kept so the next scan has something to diff
  // against. Deliberately holds the extracted *facts* and a hash, never the CV text: the roster is
  // read whole on every members/capacity load, and a stored CV body would bloat all of them.
  cv_snapshot?: AdminBotCvSnapshot;
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
  // How many months back a CV entry's start date may sit and still count as news. Configurable
  // because the right answer depends on how often a lab's members actually refresh their CVs:
  // too tight and a real move lands as backfilled, too wide and "recently" stops meaning it.
  cv_recency_window_months?: number;
  head_professor_member_id?: string;
  // Contact number the onboarding "what to expect" note hands to direct mentees. Governance
  // config rather than a repo constant: it is a real phone number, so it never belongs in the
  // source tree, and /settings is admin-gated on read as well as write.
  head_professor_whatsapp?: string;
  applicant_sheet_id?: string;
  /**
   * When the weekly group meeting is, for the reminders that are aimed at it.
   *
   * Settings rather than a constant: the meeting moves, and a nudge that fires against a
   * hard-coded Monday morning would keep firing after it moved. Weekday is 0 Sunday..6 Saturday.
   */
  group_meeting_weekday?: number;
  group_meeting_time?: string;
  group_meeting_timezone?: string;
  applicant_last_reviewed_at?: string;
  /**
   * Recorded meetings shorter than this are filed but not listed. A test call, a two-minute room
   * check and a meeting somebody rejoined by accident all produce a cloud recording, and a tab
   * three-quarters full of them is a tab nobody reads. Zero shows everything.
   */
  meeting_minimum_minutes?: number;
  /** See AdminBotSettings.venue_sources. */
  venue_sources?: AdminBotVenueSource[];
};

export type AdminBotSettings = {
  paper_escalation_business_days: number;
  cv_recency_window_months: number;
  head_professor_member_id?: string;
  head_professor_whatsapp?: string;
  applicant_sheet_id?: string;
  /** See the note on AdminBotSettingsInput. Defaults live in contracts/group-meeting.ts. */
  group_meeting_weekday?: number;
  group_meeting_time?: string;
  group_meeting_timezone?: string;
  applicant_last_reviewed_at?: string;
  /** See the note on AdminBotSettingsInput. Optional so a settings row written before meetings existed still parses. */
  meeting_minimum_minutes?: number;
  /**
   * Conferences members can search for relevant papers, newest first as an admin orders them.
   *
   * Admin-owned rather than free entry: each venue is a few thousand papers to fetch and embed,
   * so an arbitrary id typed by a member would be a multi-minute job triggered by a typo.
   */
  venue_sources?: AdminBotVenueSource[];
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

/**
 * What the venue said. `pending` is the normal state; a `reject` prunes every branch downstream of
 * the decision, and the paper comes back as a new attempt at another venue rather than as a new
 * record -- keeping the history of a paper on the paper.
 */
export const adminBotPaperVenueDecisions = ["pending", "accept", "reject"] as const;

export type AdminBotPaperVenueDecision = (typeof adminBotPaperVenueDecisions)[number];

/** How the paper appears at the venue. Ordered least to most prominent. */
export const adminBotPaperPresentationTypes = [
  "poster",
  "findings",
  "main",
  "spotlight",
  "oral",
  "award",
] as const;

export type AdminBotPaperPresentationType = (typeof adminBotPaperPresentationTypes)[number];

/**
 * One author, and who they are.
 *
 * Three states, and the distinction matters:
 *   - `member_id` set: a lab member. The paper appears on their My Projects page, and every sweep
 *     that walks the roster can reach them.
 *   - `email` set: an external coauthor. They appear in this list, on the paper card, and nowhere
 *     else in AdminBot -- no roster row, no account, no nudges, nothing addressed to them. The
 *     address is recorded so the lab knows who the person on the paper actually is.
 *   - neither: a name nobody has linked yet. Legacy rows and imports start here; the card offers
 *     to resolve them.
 *
 * Never both. A member's address belongs on their roster row, and carrying a second copy here
 * would be a second place for it to go stale.
 */
export type AdminBotPaperAuthorLink = {
  /** The printed spelling, exactly as the paper prints it. Marks and all. */
  name: string;
  member_id?: string;
  email?: string;
};

export type AdminBotPaperRecordInput = {
  id: string;
  title: string;
  /**
   * The author list, in the order the paper prints it. Free text, because it is how the *paper*
   * spells the names -- which is not always how the roster does, and is the thing a reader
   * recognises. Order is load-bearing: the PaperFlow stage nudges walk it to find the first full
   * member (workflows/papers/paperflow-stages.ts).
   */
  authors: string[];
  /**
   * The same author list, with each entry linked to whoever it names.
   *
   * `authors` above is how the *paper* spells the names, and matching it back to the roster is
   * guesswork: a co-first author signs "Joeun Yook*", a BibTeX paste says "Yook, Joeun", an accent
   * is dropped, two people share a surname. That guess decided whose My Projects page a paper
   * appeared on, so a paper filed by one coauthor was invisible to the rest until somebody
   * happened to spell a name the way the roster did.
   *
   * This is the answer recorded rather than inferred: one entry per author, in print order, each
   * carrying the printed spelling plus either a roster id (a lab member) or an email (somebody who
   * is not on the roster and is not being added to it).
   *
   * `authors` is regenerated from this list on write, so the two cannot disagree -- and a caller
   * that only knows the names (the admin form, an agent tool, an import) may still write `authors`
   * alone, in which case the service resolves what it unambiguously can and leaves the rest as
   * unlinked entries.
   */
  author_links?: AdminBotPaperAuthorLink[];
  /**
   * People asked to read and comment on the draft, as names. Distinct from `authors`: a feedback
   * giver has not signed the paper and may never appear on it, and distinct from the social
   * coauthor-consent rows, which are about a post rather than the draft. Kept because "who have
   * we actually shown this to" is a question the card could not answer at all before.
   */
  feedback_givers?: string[];
  /**
   * What each author actually does on this paper, in prose.
   *
   * Free text and deliberately not a per-author map: contributions do not divide cleanly by name
   * ("Ada and Rahul ran the experiments; Zhijing advised throughout"), the CRediT-style taxonomies
   * that try are filled in badly or not at all, and the thing a reader wants at submission time is
   * a paragraph they can paste into the contributions statement. One field, one paragraph.
   *
   * Distinct from `notes`, which is the paper's own scratchpad. This is about people.
   */
  author_roles?: string;
  current_step: AdminBotPaperStep;
  // Who the nudges go to by default. Free-text `authors` cannot answer this: it is how the paper
  // spells the names, not who on the roster owes the work.
  first_author_member_id?: string;
  // The venue as a plain string ("ICLR 2027") and its deadline as a date, so a hard-deadline nudge
  // does not have to guess which of the deadline board's rows this paper meant.
  venue?: string;
  deadline?: string;
  venue_decision?: AdminBotPaperVenueDecision;
  /** Increments on reject -> new venue. Same record, next try. */
  attempt?: number;
  /** Admin-only exemption from the 24-month dormancy rule. */
  dormant_override?: boolean;
  // Acceptance details. Author-provided, and only meaningful once `venue_decision` is `accept`;
  // the conference branch (who is going, posters, reimbursements) stays shut until all four are
  // in, because none of it can be asked sensibly without them. Nothing infers these today --
  // reading them off OpenReview is plausible later, and would still end in the author confirming.
  accepted_venue?: string;
  accepted_year?: number;
  // Archival vs non-archival decides whether this counts as a publication, which is why it is
  // asked rather than guessed: the same workshop can be either in different years.
  is_archival?: boolean;
  presentation_type?: AdminBotPaperPresentationType;
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
    // One pass over the back catalogue, linking printed author names to the people they name.
    | "paper_author_links.backfilled"
    // Carries the whole retired record in `details`, because a merge has no undo.
    | "lab_member.merged"
    | "paper.upserted"
    | "paper_slot.updated"
    | "paper_slot.waived"
    | "paper_slots.nudged"
    | "paperflow_stages.nudged"
    | "paperflow_stage.evidenced"
    | "paper_social_draft.saved"
    | "paper_social_draft.circulated"
    | "paper_social_consent.recorded"
    | "paper_attendee.updated"
    | "paper_reimbursement.updated"
    | "paper_slots.backfilled"
    // One author's account of one week. The prose stays out of `details` -- see the service.
    | "paper_weekly_update.saved"
    | "paper_weekly_updates.nudged"
    // The pre-meeting pre-registration reminder, keyed by the meeting it was sent before.
    | "prereg.nudged"
    | "paper.deleted"
    | "onboarding.guide_sent"
    | "settings.updated"
    // What somebody thought of one surface. Carries the rating, never the comment -- a comment can
    // name a person, and the audit log is read by more people than the feedback table is.
    | "feedback.recorded"
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
    // A member asking the lab for something, and the lab answering. The submit line is what makes
    // "nobody told me" checkable; the status line is who answered and when.
    | "logistics_request.submitted"
    | "logistics_request.status_changed"
    | "logistics_request.withdrawn"
    // The signed document going back to the member who asked for it, and the copies being dropped
    // once it has.
    | "logistics_request.signed_document_sent"
    | "logistics_request.files_cleared"
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
    // Where members are. An observation is a fact about a person's whereabouts, and the answer to
    // the prompt is the only thing that turns one into a profile change, so both are recorded.
    | "member.location_observed"
    | "member.location_prompt_answered"
    // Recorded meetings. Filing one is not an external effect, but attendance is personal data
    // and a summary is machine-written, so who filed or corrected what stays answerable.
    | "meeting.recorded"
    | "meeting.updated"
    | "meeting.attendance_updated"
    | "meeting.deleted"
    // Slack channel-naming enforcement. The sweep renames other people's channels, which is an
    // external effect with no undo, so who triggered a pass and what it did is recorded here.
    | "slack.channel_naming_checked"
    | "slack.channel_naming_swept"
    // The CV digest job. It rewrites a Google Doc without going through propose/approve -- the
    // job is admin-only on both the tab and the route -- so the audit row is the only record that
    // the document changed and who changed it.
    | "cv.digest_published"
    | "cv.digest_failed"
    // Rebuilding the conference paper indexes. It spends a few minutes of an external API's quota
    // and replaces what every member then searches, so who triggered one is worth keeping.
    | "venue_index.rebuilt";
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

// ---------------------------------------------------------------------------
// Where members are, over time
//
// The roster already carries three location fields, and each answers a different question:
// `location` is where a member lives, `current_city` is where they are right now, and
// `last_login_country` is where they last signed in from. All three are point-in-time: each write
// overwrites the last, so nothing in the system could ever answer "when did they move".
//
// That question is what a scheduling lab actually needs. A member on a three-month internship in
// Berlin who never edits their profile keeps getting invited to a 10am Toronto meeting that is 4pm
// where they are, and nothing surfaces the mismatch — the login geolocation *knows*, and
// deliberately does not write it anywhere a scheduler would look, because an inferred country must
// never silently overwrite what a person told us about themselves.
//
// So observations are appended here instead of overwriting anything, and divergence between what
// is inferred and what is on the profile becomes a question put to the member rather than a write
// behind their back. The member's answer is the only thing that changes the profile.
// ---------------------------------------------------------------------------

export const adminBotLocationSources = [
  "self_reported",
  "login_ip",
  "slack_profile",
  "admin",
] as const;

export type AdminBotLocationSource = (typeof adminBotLocationSources)[number];

export type AdminBotMemberLocationEntry = {
  id: string;
  member_id: string;
  observed_at: string;
  source: AdminBotLocationSource;
  /** The text the source gave, kept verbatim so an unresolved place is still diagnosable. */
  raw: string;
  /** Gazetteer key, when the text resolved to a place the map knows. */
  place_key?: string;
  place_label?: string;
  country?: string;
  /**
   * Only ever set on a self-report. Inference states a country and never a timezone: the two are
   * not the same claim, and countries with several zones would make it a guess presented as fact.
   */
  timezone?: string;
};

/** What the member is being asked to confirm, and the evidence for asking. */
export type AdminBotLocationDrift = {
  member_id: string;
  /** Where the recent sign-ins say they are. */
  observed_country: string;
  observed_label?: string;
  /** What the profile says, for the question to quote back. */
  profile_location?: string;
  profile_country?: string;
  /** When the divergence started, and how many sign-ins have agreed with it since. */
  since: string;
  observation_count: number;
};

// ---------------------------------------------------------------------------
// Meetings
//
// A recorded group meeting: the link members open, who was there, and a summary of what was said.
//
// The account this comes from is an educational Zoom with developer mode off, so there is no API
// behind any of it. A record is assembled from the notice Zoom mails the host (link, topic, time),
// a participant CSV a host exports by hand (attendance), and the cloud recording's own transcript
// (summary). Each arrives separately and none is guaranteed, so every field past the link is
// optional and a record is worth keeping with only some of them.
//
// What is deliberately absent is the transcript itself. It is read, summarized and dropped: lab
// meetings discuss unpublished work and people's circumstances, and a verbatim record of that in
// a database that backs a web UI is a liability nobody asked for. `transcript` keeps the fact that
// one was processed, not what it said.
// ---------------------------------------------------------------------------

/** Where an attendance line came from. Ranked in `mergeAttendance`: manual beats every import. */
export type AdminBotMeetingAttendanceSource = "participant_report" | "transcript" | "manual";

export type AdminBotMeetingAttendee = {
  /** Set when the row resolved to someone on the roster. Absent means a guest, or an unmatched name. */
  member_id?: string;
  /** The name as Zoom reported it, kept even when matched so an admin can see what was matched. */
  display_name: string;
  email?: string;
  joined_at?: string;
  minutes?: number;
  source: AdminBotMeetingAttendanceSource;
  /** False records a considered absence — an admin unticking someone an import added. */
  present: boolean;
};

export type AdminBotMeetingActionItem = {
  text: string;
  owner_member_id?: string;
  /** The name the summarizer read off the transcript, when it did not resolve to a member. */
  owner_name?: string;
};

export type AdminBotMeetingSummary = {
  overview: string;
  decisions: string[];
  action_items: AdminBotMeetingActionItem[];
  generated_at: string;
  /** Which local model wrote it. Recorded because a summary is machine-written and readers should be able to tell which machine. */
  model: string;
};

export type AdminBotMeetingRecordingLinks = {
  /** The Zoom share URL from the notice. The one field a meeting record cannot be created without. */
  share_url?: string;
  passcode?: string;
  /** Copy on the lab's Drive, which is what survives Zoom's cloud retention window deleting the original. */
  drive_url?: string;
};

export type AdminBotMeetingTranscriptState = {
  processed_at: string;
  /** Speakers the transcript named, which is what pre-ticks the attendance roster. */
  speaker_names: string[];
  duration_seconds?: number;
};

export type AdminBotMeetingRecordInput = {
  id: string;
  topic: string;
  /** RFC3339. Falls back to when the notice was received if Zoom's date line did not parse. */
  started_at: string;
  duration_minutes?: number;
  host_email?: string;
  recording: AdminBotMeetingRecordingLinks;
  transcript?: AdminBotMeetingTranscriptState;
  summary?: AdminBotMeetingSummary;
  attendees?: AdminBotMeetingAttendee[];
  /** How the record got here: parsed from a forwarded notice, or filed by hand in the Control UI. */
  source: "zoom_email" | "manual";
  notes?: string;
};

export type AdminBotMeetingRecord = AdminBotMeetingRecordInput & {
  created_at: string;
  updated_at: string;
  /**
   * How many people were present. Derived on read, never stored: a member is not shown the roster,
   * and a headcount is the part of it that is useful to whoever missed the meeting without naming
   * anybody. Absent on the admin view, which has the roster itself.
   */
  attendee_count?: number;
};

// ---------------------------------------------------------------------------
// Logistics requests
//
// The routine asks a member makes of the lab: sign these documents, write these recommendation
// letters, book me this meeting. Each has a fixed shape, which is why they are templates in the
// Control UI and one record type here rather than free-text tickets.
//
// A submitted request is a stored record, not a typed action -- storing one reaches nothing outside
// this service, so a member never waits on an approval to be heard. The one outbound step is the
// signed document going back, and that is `logistics.send_signed_document` above.
//
// The kinds are open-coded rather than one payload blob because an admin's queue sorts and filters
// on them, and because each kind carries different fields that the service validates separately.
// ---------------------------------------------------------------------------

export const adminBotLogisticsRequestKinds = [
  "document_signature",
  "recommendation_letters",
  "book_meeting",
] as const;

export type AdminBotLogisticsRequestKind = (typeof adminBotLogisticsRequestKinds)[number];

/**
 * Where a request stands, from the lab's side.
 *
 * `submitted` is the only status a member can create, and `withdrawn` the only one they can move it
 * to: everything between is the lab saying what it has done, and a requester grading their own
 * request would make the column useless to the people working through the list.
 */
export const adminBotLogisticsRequestStatuses = [
  "submitted",
  "in_progress",
  "completed",
  "declined",
  "withdrawn",
] as const;

export type AdminBotLogisticsRequestStatus = (typeof adminBotLogisticsRequestStatuses)[number];

/** Statuses that mean nobody is waiting on this request any more. */
export const adminBotLogisticsSettledStatuses = [
  "completed",
  "declined",
  "withdrawn",
] as const satisfies readonly AdminBotLogisticsRequestStatus[];

/**
 * A file travelling with a request, bytes and all.
 *
 * Base64 in the record rather than a blob store because there is no blob store: every other record
 * here is one JSON payload in one row, and a second storage system for the handful of PDFs a lab
 * signs each term would be more moving parts than the feature is worth. Two things keep that safe:
 * the size caps in `workflows/logistics/requests.ts`, and the fact that the bytes are dropped once
 * the request is settled -- see `clearSettledRequestFiles`. What is left then is this same record
 * with `size` and `name` intact and `data_base64` gone, which still reads as a complete history.
 */
export type AdminBotLogisticsAttachment = {
  name: string;
  /** Bytes of the decoded file, checked against the caps rather than trusted from the client. */
  size: number;
  /** As the browser reported it. Advisory: the service never executes or renders these. */
  content_type?: string;
  /** Standard base64, no data: prefix. Absent on a list read, and after the request is settled. */
  data_base64?: string;
};

/** One school on a recommendation letters request, as the member filled the row in. */
export type AdminBotLogisticsSchool = {
  school: string;
  /** yyyy-mm-dd. Both deadlines are optional: a member often knows one before the other. */
  application_deadline?: string;
  /** HH:mm, in `deadline_timezone`. A date with no time is treated as end of that day. */
  application_deadline_time?: string;
  letter_deadline?: string;
  letter_deadline_time?: string;
  /** IANA zone both times on this row are read in. Blank means the dates are whole-day. */
  deadline_timezone?: string;
  application_status?: string;
  letter_status?: string;
  program?: string;
  program_link?: string;
  notes?: string;
};

/** One line of what the member actually did, which is the part a letter template cannot supply. */
export type AdminBotLogisticsFact = {
  project: string;
  contribution: string;
};

/** One proposed meeting on a book-meeting request. */
export type AdminBotLogisticsMeeting = {
  purpose: string;
  /** yyyy-mm-ddTHH:mm as typed, read in `timezone`. */
  preferred_time?: string;
  timezone?: string;
  length_minutes?: number;
  /** When the member added the row, which is what decides order of service. */
  submitted_at?: string;
};

export type AdminBotLogisticsRequestInput = {
  kind: AdminBotLogisticsRequestKind;
  /** Document signature. */
  documents?: AdminBotLogisticsAttachment[];
  description?: string;
  attachments?: AdminBotLogisticsAttachment[];
  /** Recommendation letters. */
  schools?: AdminBotLogisticsSchool[];
  facts?: AdminBotLogisticsFact[];
  cv_overleaf_url?: string;
  drive_folder_url?: string;
  /** Book meeting. */
  meetings?: AdminBotLogisticsMeeting[];
};

export type AdminBotLogisticsRequest = AdminBotLogisticsRequestInput & {
  id: string;
  /** Who asked. Taken from the session, never from the body: a request is signed by whoever sent it. */
  member_id: string;
  /** The roster name at submission time, so a queue stays readable after someone leaves. */
  member_name: string;
  status: AdminBotLogisticsRequestStatus;
  submitted_at: string;
  updated_at: string;
  /**
   * RFC3339 instant of the soonest thing this request is working towards, or absent when it names
   * none. Derived on write from the dates, times and zones the member gave, so every reader sorts
   * the same way and no client has to re-implement "which of these is soonest".
   */
  deadline_at?: string;
  /**
   * What the lab sent back, signed.
   *
   * Kept only until it has been mailed and the request settled; what survives is the name and the
   * fact that it was sent, which is what an admin looking at an old request needs to know.
   */
  signed_documents?: AdminBotLogisticsAttachment[];
  /** When the signed document was mailed to the requester, and to which address. */
  signed_sent_at?: string;
  signed_sent_to?: string;
  /** When the stored file bytes were dropped, so a reader can tell "never had one" from "gone". */
  files_cleared_at?: string;
  /** What the lab said back, shown to the member. Set with the status. */
  resolution_note?: string;
  /** Which admin last moved the status, for the member reading "declined" and wondering who by. */
  decided_by?: string;
  decided_at?: string;
};

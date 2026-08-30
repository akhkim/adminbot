// The parts of a paper's life that are lists rather than single artifacts: the social drafts and
// who has signed off on them, who is actually going to the conference, and who has been
// reimbursed. Plus the ledger that keeps every nudge in the lab on one clock.
//
// These are separate tables rather than more slots because a slot answers "is this one thing
// done" and each of these is "how many of these are done, and by whom". A slot row cannot carry
// four consents, and four consents cannot share one `provided_at`.

// --- social drafts -----------------------------------------------------------------------

export const adminBotSocialPlatforms = ["x", "linkedin"] as const;

export type AdminBotSocialPlatform = (typeof adminBotSocialPlatforms)[number];

/**
 * `draft` is written but not shown to anyone, `circulated` means the consent rows exist and the
 * authors have been asked, `approved` means nobody is still pending or asking for changes, and
 * `superseded` is what a regeneration does to the version before it.
 */
export const adminBotSocialDraftStatuses = [
  "draft",
  "circulated",
  "approved",
  "superseded",
] as const;

export type AdminBotSocialDraftStatus = (typeof adminBotSocialDraftStatuses)[number];

/**
 * A stored social draft.
 *
 * Stored, reversing the earlier "the text lives in the proposal and nowhere else" rule, for one
 * concrete reason: a post that names a senior author has to be shown to that author before it
 * goes out, and you cannot ask for consent on something you threw away. Regeneration supersedes
 * rather than overwrites, so "what did they actually approve" stays answerable afterwards.
 */
export type AdminBotSocialDraftRecord = {
  id: string;
  paper_id: string;
  platform: AdminBotSocialPlatform;
  body: string;
  /** Which model wrote it, or empty when a person did. */
  model?: string;
  generated_at: string;
  generated_by_member_id?: string;
  status: AdminBotSocialDraftStatus;
  /** Set on the older row when a newer draft replaces it. */
  superseded_by?: string;
};

export const adminBotSocialConsentDecisions = ["pending", "ok", "changes_requested"] as const;

export type AdminBotSocialConsentDecision = (typeof adminBotSocialConsentDecisions)[number];

/**
 * One named author's sign-off on one draft.
 *
 * This is what "coauthor feedback" actually means, made queryable: a draft is approved when no
 * row on it is still `pending` or `changes_requested`.
 *
 * Rows exist only for authors who resolve to a roster member. AdminBot has no way to reach an
 * external coauthor and no standing to chase one, so inventing a row for them would create a
 * consent that can never be collected and a draft that can never be approved. External names stay
 * in the paper's `authors` list and are the first author's problem to handle by email, which is
 * what happens today anyway.
 */
export type AdminBotSocialConsentRecord = {
  draft_id: string;
  member_id: string;
  decision: AdminBotSocialConsentDecision;
  comment?: string;
  asked_at: string;
  decided_at?: string;
};

// --- conference logistics ----------------------------------------------------------------

export const adminBotAttendanceStates = ["yes", "no", "unknown"] as const;

export type AdminBotAttendanceState = (typeof adminBotAttendanceStates)[number];

/**
 * Who is going, author-provided. Nothing infers travel.
 *
 * `attendee_key` is the primary key alongside `paper_id`, and it is a stored column rather than
 * the `coalesce(member_id, name)` the spec asked for: SQLite cannot key on an expression. The
 * service computes it once (the member id, or the folded-down name for somebody with no roster
 * row) so both stores agree on what counts as the same person twice.
 */
export type AdminBotConferenceAttendeeRecord = {
  paper_id: string;
  attendee_key: string;
  member_id?: string;
  name: string;
  attending: AdminBotAttendanceState;
  confirmed_at?: string;
};

export const adminBotReimbursementStates = [
  "not_applicable",
  "pending",
  "submitted",
  "reimbursed",
] as const;

export type AdminBotReimbursementState = (typeof adminBotReimbursementStates)[number];

/**
 * One author's reimbursement on one paper.
 *
 * Status only. The actual claim is filed through the existing logistics reimbursement flow, which
 * knows about receipts and forms; this row is the lab's answer to "is that person square yet",
 * which is the last thing a paper is waiting on. Deliberately not linked to a logistics request
 * id: a claim can cover two conferences and a trip can be reimbursed outside AdminBot entirely,
 * so a foreign key here would be wrong more often than it was right.
 */
export type AdminBotPaperReimbursementRecord = {
  paper_id: string;
  member_id: string;
  status: AdminBotReimbursementState;
  submitted_at?: string;
  completed_at?: string;
};

// --- the nudge ledger --------------------------------------------------------------------

/**
 * Which part of AdminBot a nudge is about.
 *
 * The ledger is keyed by domain so one sweep can gather everything a person owes -- a paper slot
 * here, an unfilled profile field there -- and send them one message instead of three. Adding a
 * domain is adding a string and a gatherer, not another table with its own cadence.
 */
export const adminBotNudgeDomains = [
  "paper_slot",
  // The venue-cycle stages chased by email rather than in the Slack sweep. Same ledger because
  // the cadence still belongs to the person: an author who was emailed about reviews this morning
  // should not also be Slacked about a poster this afternoon.
  "paperflow_stage",
  "social_consent",
  "conference_attendance",
  "paper_reimbursement",
  // A thesis on somebody's own timeline: the read-the-guidebook nudge before it, and the reminder
  // to the head professor to grade it after. Same ledger for the same reason as the rest -- the
  // cadence belongs to the person, and a thesis week is exactly when nobody needs a fourth Slack
  // message about a poster.
  "thesis_milestone",
  // Leaving: the member confirming their finishing month, the admins being asked to make the
  // transition, and the yearly ceremony. Same ledger for the same reason -- somebody wrapping up
  // is already hearing from AdminBot about handovers.
  "graduation",
  "profile_field",
] as const;

export type AdminBotNudgeDomain = (typeof adminBotNudgeDomains)[number];

/**
 * When somebody was last chased about one specific thing, and how often.
 *
 * Moved off `paper_slots` on purpose. Cadence is a property of the person being messaged, not of
 * the artifact: four rows on four tables each with their own `last_nudged_at` is four independent
 * clocks, and four clocks with the same period is a person who gets four Slack messages in one
 * morning. One table means the sweep can ask "what does this person owe, across everything" in a
 * single query, and answer it once.
 *
 * `subject_id` is domain-shaped -- `<paper_id>:<slot>` for a slot, a member field key for a
 * profile field -- because the ledger never joins back to anything. It only ever answers "have we
 * already asked, and when".
 */
/**
 * One workshop-matching pass, and what it produced.
 *
 * The match is a cross-product -- every upcoming workshop against every paper -- which on this
 * roster is thousands of model calls and tens of minutes. That never fitted inside the request the
 * button makes, so the browser gave up and the page reported the service as unreachable. It is
 * kept here instead: the pass runs to completion server-side and writes its answer, and opening
 * the page reads the answer rather than starting the work again.
 *
 * Still on command, not on a schedule. Pressing Refresh starts a pass; everyone who opens the page
 * afterwards sees what it found, until somebody asks for a newer one.
 */
export type AdminBotWorkshopMatchRun = {
  id: string;
  /** `running` while the pass is in flight; `ready` and `failed` are both terminal. */
  status: "running" | "ready" | "failed";
  started_at: string;
  finished_at?: string;
  /** Who pressed Refresh. A pass is somebody's decision, and it costs real model time. */
  started_by?: string;
  /** Model calls finished and total, so a page open mid-pass can say how far along it is. */
  calls_done: number;
  calls_total: number;
  /**
   * Model calls that were counted as done because they gave up, not because they answered.
   *
   * A failed call still advances `calls_done` -- it has to, or a pass with one bad batch never
   * reaches its total and the page spins forever. That makes `calls_done` alone a lie about how
   * much of the answer is real, so the count of the ones that failed travels beside it and the
   * page says "2540 of 2540, 37 failed" rather than pretending to a complete sweep.
   */
  calls_failed?: number;
  /**
   * When this run last moved.
   *
   * A pass is a fire-and-forget async task inside the service process, so a restart leaves its row
   * saying `running` with nobody working on it -- and the "one pass at a time" guard then refuses
   * every new pass forever. Progress time is what tells a stuck row from a live one.
   */
  progress_at?: string;
  /** The preview payload, once the pass finished. */
  payload_json?: string;
  /** Why it failed, when it did. */
  error?: string;
};

export type AdminBotNudgeLedgerRecord = {
  domain: AdminBotNudgeDomain;
  subject_id: string;
  /** Who was asked. The cadence belongs to them. */
  member_id: string;
  last_nudged_at?: string;
  nudge_count: number;
  /** Author-set, and bounded by the service. */
  snoozed_until?: string;
};

/** How far ahead somebody may push a nudge. Long enough for a conference week, no longer. */
export const adminBotNudgeMaxSnoozeDays = 14;

/** The ledger id for one paper slot. */
export function adminBotPaperSlotSubjectId(paperId: string, slot: string): string {
  return `${paperId}:${slot}`;
}

/**
 * A stable key for an attendee who may or may not be on the roster.
 *
 * Members key by id so a rename does not split their row in two. Everyone else keys by their name
 * folded down to letters and digits, which is the best available answer for free text and at
 * least collapses "Jane Doe" and "jane  doe".
 */
export function adminBotAttendeeKey(memberId: string | undefined, name: string): string {
  if (memberId) {
    return `member:${memberId}`;
  }
  return `name:${name
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")}`;
}

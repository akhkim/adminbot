// The rules for one paper's evidence: what a stored row means, what a write to one does, and
// which of them are worth nudging about right now.
//
// Pure, and deliberately so. The service owns the store, the roster and the outbound message; this
// file only turns records into decisions, which is what makes the nudge sweep testable without a
// database or a Slack connector.
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  adminBotNudgeMaxSnoozeDays,
  adminBotPaperSlotSubjectId,
  type AdminBotNudgeLedgerRecord,
  type AdminBotPaperReimbursementRecord,
  type AdminBotSocialConsentRecord,
  type AdminBotSocialDraftRecord,
} from "../../contracts/paper-cycle.js";
import {
  isStaleDeadline,
  parsePaperFeedback,
  STALE_DEADLINE_DAYS,
} from "../../contracts/paper-feedback.js";
import {
  hasPaperImpactText,
  isEmptyPaperImpactStatement,
  isPaperImpactSlot,
  paperImpactMissingFields,
  parsePaperImpactStatement,
} from "../../contracts/paper-impact.js";
import {
  ADMINBOT_QUICK_POINTERS_DOC_URL,
  adminBotPaperSlotBranchPriority,
  adminBotPaperSlotEscalateAfterNudges,
  adminBotPaperSlotRegistry,
  adminBotPaperSlots,
  isAdminBotPaperSlotSettled,
  isAdminBotPosterPhysicalState,
  isConfidentialPaperSlot,
  validateAdminBotPaperSecret,
  validateAdminBotPaperSlotUrl,
  type AdminBotPaperSlot,
  type AdminBotPaperSlotBranch,
  type AdminBotPaperSlotDefinition,
  type AdminBotPaperSlotInput,
  type AdminBotPaperSlotOwner,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";
import {
  isPaperMentorReviewStale,
  paperMentorFixesDetail,
  paperMentorReviewDetail,
  paperMentorReviewState,
  type PaperMentorContext,
} from "./papermentor-nudges.js";

/** A paper this old is dormant: it is not late, it is resting, and nudging it trains people to ignore nudges. */
const DORMANT_MONTHS = 24;

const MONTH_MS = 1000 * 60 * 60 * 24 * 30.44;
const DAY_MS = 1000 * 60 * 60 * 24;

export function isAdminBotPaperSlot(value: unknown): value is AdminBotPaperSlot {
  return typeof value === "string" && (adminBotPaperSlots as readonly string[]).includes(value);
}

/** An unwritten slot is `missing`, not absent. Every read sees all 25 rows so the UI never has to fill gaps. */
export function blankPaperSlot(paperId: string, slot: AdminBotPaperSlot): AdminBotPaperSlotRecord {
  return { paper_id: paperId, slot, status: "missing" };
}

/**
 * Whether the two derived social gates are satisfied, read from the drafts rather than the slots.
 *
 * A gate is `provided` when an approved draft exists for that platform. Storing a second copy of
 * that fact in `paper_slots` would be storing something derivable, and the copy would be free to
 * disagree with the drafts table the moment a draft was superseded.
 */
function derivedSocialStatus(
  slot: AdminBotPaperSlot,
  drafts: AdminBotSocialDraftRecord[],
): AdminBotPaperSlotRecord["status"] {
  const platform = slot === "x_draft" ? "x" : "linkedin";
  return drafts.some((draft) => draft.platform === platform && draft.status === "approved")
    ? "provided"
    : "missing";
}

/**
 * Every slot for one paper, stored rows first and blanks for the rest, in registry order.
 *
 * Registry order rather than storage order: it is the order the work happens in, and it is the
 * order the card renders, so a slot never moves position because somebody filled it in.
 */
export function paperSlotRows(
  paperId: string,
  stored: AdminBotPaperSlotRecord[],
  drafts: AdminBotSocialDraftRecord[] = [],
): AdminBotPaperSlotRecord[] {
  const byslot = new Map(stored.map((record) => [record.slot, record]));
  return adminBotPaperSlots.map((slot) => {
    const row = byslot.get(slot) ?? blankPaperSlot(paperId, slot);
    if (!adminBotPaperSlotRegistry[slot].derived) {
      return row;
    }
    // A waiver still wins over the derived value: an admin excusing a paper from a social post is
    // a decision, and recomputing over the top of it would silently undo it.
    return row.status === "waived" ? row : { ...row, status: derivedSocialStatus(slot, drafts) };
  });
}

/**
 * One paper's slots as they may be shown to this reader.
 *
 * Credentials are dropped rather than blanked, exactly as `redactConfidentialMemberFields` does
 * it: an empty value is indistinguishable from "there is no password on this paper", which is
 * itself a disclosure about the paper's state.
 */
export function redactPaperSlots(
  rows: AdminBotPaperSlotRecord[],
  entitled: boolean,
): AdminBotPaperSlotRecord[] {
  if (entitled) {
    return rows;
  }
  return rows.map((row) => {
    if (
      !isConfidentialPaperSlot(row.slot) &&
      !row.slot.startsWith("feedback_") &&
      !isPaperImpactSlot(row.slot)
    ) {
      return row;
    }
    const { value_text: _dropped, ...rest } = row;
    return rest;
  });
}

export type PaperSlotWriteResult =
  | { ok: true; record: AdminBotPaperSlotRecord }
  | { ok: false; error: string };

/**
 * Apply a member's write to one slot.
 *
 * `status` is derived here and never accepted from input: it is the one column the nudge pass
 * trusts, so letting a caller set it directly would let a member mark their own missing artifact
 * as provided without providing anything.
 *
 * A failed check stores the value as `invalid` rather than rejecting the write outright. The
 * author needs to see what they typed alongside the reason it was refused -- throwing it away and
 * showing an error means they retype it from memory.
 */
export function applyPaperSlotWrite(params: {
  existing: AdminBotPaperSlotRecord;
  input: AdminBotPaperSlotInput;
  memberId: string;
  now: Date;
}): PaperSlotWriteResult {
  const { existing, input, memberId } = params;
  const nowIso = params.now.toISOString();
  const definition = adminBotPaperSlotRegistry[existing.slot];
  // A waived slot stays waived until an admin lifts it. Otherwise an autosave from the card would
  // quietly undo the override the moment the author touched the field.
  if (existing.status === "waived") {
    return { ok: false, error: `${definition.label} was waived by an admin` };
  }
  if (definition.derived) {
    return {
      ok: false,
      error: `${definition.label} follows the social drafts and cannot be set directly`,
    };
  }

  const provided = (extra: Partial<AdminBotPaperSlotRecord>): AdminBotPaperSlotRecord => ({
    ...existing,
    status: "provided",
    provided_by_member_id: memberId,
    provided_at: nowIso,
    invalid_reason: undefined,
    ...extra,
  });

  switch (definition.kind) {
    case "bool": {
      if (typeof input.done !== "boolean") {
        return { ok: false, error: `${definition.label} takes a yes or no` };
      }
      return { ok: true, record: input.done ? provided({}) : clearedSlot(existing) };
    }
    case "text": {
      const value = (input.value_text ?? "").trim();
      return value
        ? { ok: true, record: provided({ value_text: value }) }
        : { ok: true, record: clearedSlot(existing) };
    }
    case "feedback": {
      const value = (input.value_text ?? "").trim();
      if (!value) {
        return { ok: true, record: clearedSlot(existing) };
      }
      const feedback = parsePaperFeedback(value);
      if (!feedback) {
        return {
          ok: false,
          error:
            "Feedback needs a reason, an HTTPS manuscript link and valid deadline times; feedback-by cannot follow submission cutoff.",
        };
      }
      // A newly entered cutoff that is months behind is almost always the wrong year (2025 typed
      // for 2026). Stored, it would sit on the PI queue as a long-overdue item, so ask for the year
      // instead. Only a cutoff that changed is checked: closing or noting an old request keeps
      // its original date and must still go through.
      const stored = existing.value_text ? parsePaperFeedback(existing.value_text) : null;
      if (
        !feedback.reviewed &&
        feedback.hard_deadline !== stored?.hard_deadline &&
        isStaleDeadline(feedback.hard_deadline, params.now)
      ) {
        return {
          ok: false,
          error: `The submission cutoff is more than ${STALE_DEADLINE_DAYS} days in the past. Check the year.`,
        };
      }
      return { ok: true, record: provided({ value_text: JSON.stringify(feedback) }) };
    }
    case "impact": {
      // The service has already merged this write into the stored statement and checked who may
      // change what (mergePaperImpactWrite), so this only decides the status the value earns.
      const value = (input.value_text ?? "").trim();
      const statement = value ? parsePaperImpactStatement(value) : null;
      if (value && !statement) {
        return { ok: false, error: "The impact statement could not be read." };
      }
      if (!statement || isEmptyPaperImpactStatement(statement)) {
        return { ok: true, record: clearedSlot(existing) };
      }
      const stored = JSON.stringify(statement);
      if (!hasPaperImpactText(statement)) {
        // Only a correction or a note so far: nothing has been written, so it is still missing,
        // but the correction has to survive or the classifier's guess comes back.
        return { ok: true, record: { ...clearedSlot(existing), value_text: stored } };
      }
      const missing = paperImpactMissingFields(statement);
      if (missing.length > 0) {
        // A saved draft. Kept rather than refused, so an unfinished statement is not lost.
        return {
          ok: true,
          record: {
            ...existing,
            status: "invalid",
            value_text: stored,
            provided_by_member_id: memberId,
            provided_at: nowIso,
            invalid_reason: `Still needed: ${missing.join(", ")}`,
          },
        };
      }
      return { ok: true, record: provided({ value_text: stored }) };
    }
    case "secret6": {
      const value = (input.value_text ?? "").trim();
      if (!value) {
        return { ok: true, record: clearedSlot(existing) };
      }
      const check = validateAdminBotPaperSecret(value);
      // Note what is *not* here: the rejected value is not stored. Everywhere else keeping the bad
      // input is the kindness, but this one is a credential -- a mistyped password is still a
      // password somebody uses, and it does not belong in a row every author can read.
      if (!check.ok) {
        return { ok: false, error: check.reason };
      }
      return {
        ok: true,
        record: provided({ value_text: value, validated_at: nowIso }),
      };
    }
    case "enum": {
      const value = (input.value_text ?? "").trim();
      const note = (input.value_note ?? "").trim();
      if (!value) {
        return { ok: true, record: clearedSlot(existing) };
      }
      if (!isAdminBotPosterPhysicalState(value)) {
        return { ok: false, error: `${value} is not one of the states this slot accepts` };
      }
      return {
        ok: true,
        record: provided({ value_text: value, ...(note ? { value_note: note } : {}) }),
      };
    }
    case "link": {
      const value = (input.url ?? "").trim();
      // Verification belongs to the URL, not to the field that happens to hold it.
      const verification =
        value === existing.url
          ? {}
          : {
              verified_by: undefined,
              verified_at: undefined,
              verified_title: undefined,
              previous_submission_id: undefined,
              identity_review: undefined,
            };
      if (!value) {
        return { ok: true, record: clearedSlot(existing) };
      }
      const check = validateAdminBotPaperSlotUrl(existing.slot, value);
      if (!check.ok) {
        return {
          ok: true,
          record: {
            ...existing,
            ...verification,
            status: "invalid",
            url: value,
            provided_by_member_id: memberId,
            provided_at: nowIso,
            invalid_reason: check.reason,
            validated_at: undefined,
          },
        };
      }
      return { ok: true, record: provided({ ...verification, url: value, validated_at: nowIso }) };
    }
  }
}

/** Back to missing. The nudge counters are not here to reset -- they live in the ledger. */
function clearedSlot(existing: AdminBotPaperSlotRecord): AdminBotPaperSlotRecord {
  return { paper_id: existing.paper_id, slot: existing.slot, status: "missing" };
}

/** An admin override. `reason` is required: a waiver nobody can explain later is just missing data. */
export function waivePaperSlot(params: {
  existing: AdminBotPaperSlotRecord;
  memberId: string;
  reason: string;
  now: Date;
}): PaperSlotWriteResult {
  const reason = params.reason.trim();
  if (!reason) {
    return { ok: false, error: "a waiver needs a reason" };
  }
  return {
    ok: true,
    record: {
      ...params.existing,
      status: "waived",
      waived_by_member_id: params.memberId,
      waived_reason: reason,
      provided_at: params.existing.provided_at ?? params.now.toISOString(),
    },
  };
}

/** Whether a paper is resting rather than late. Silent by design, so nobody games the clock. */
export function isPaperDormant(paper: AdminBotPaperRecord, now: Date): boolean {
  if (paper.dormant_override) {
    return false;
  }
  const started = Date.parse(paper.created_at ?? "");
  if (!Number.isFinite(started)) {
    return false;
  }
  return (now.getTime() - started) / MONTH_MS > DORMANT_MONTHS;
}

/** Rejected attempts and papers explicitly marked presented have no outstanding workflow. */
export function isPaperClosed(paper: AdminBotPaperRecord): boolean {
  const completedAt = paper.artifacts?.completed_at;
  return (
    paper.venue_decision === "reject" ||
    (typeof completedAt === "string" && completedAt.trim().length > 0)
  );
}

/**
 * Whether the conference branch is open on this paper.
 *
 * All four acceptance details, not just the decision: "who is going" and "has everyone been
 * reimbursed" cannot be asked sensibly of a paper whose venue and year nobody has recorded, and a
 * poster question aimed at a paper that turned out to be an oral is noise.
 */
export function isConferenceBranchOpen(paper: AdminBotPaperRecord): boolean {
  return (
    paper.venue_decision === "accept" &&
    Boolean(paper.accepted_venue?.trim()) &&
    typeof paper.accepted_year === "number" &&
    typeof paper.is_archival === "boolean" &&
    Boolean(paper.presentation_type)
  );
}

/** Which acceptance details are still missing, for the nudge and the card. */
export function missingAcceptanceDetails(paper: AdminBotPaperRecord): string[] {
  if (paper.venue_decision !== "accept") {
    return [];
  }
  const missing: string[] = [];
  if (!paper.accepted_venue?.trim()) {
    missing.push("accepted venue");
  }
  if (typeof paper.accepted_year !== "number") {
    missing.push("year");
  }
  if (typeof paper.is_archival !== "boolean") {
    missing.push("archival or not");
  }
  if (!paper.presentation_type) {
    missing.push("presentation type");
  }
  return missing;
}

/** One thing one person owes, whatever kind of thing it is. */
export type NudgeItem = {
  domain: AdminBotNudgeLedgerRecord["domain"];
  subjectId: string;
  /** Registry owner role, or the role the item is asked of. */
  owner: AdminBotPaperSlotOwner;
  /** The line that appears in the message. Never contains a credential. */
  label: string;
  /**
   * Why this one is not simply missing, appended to the line. Carries the validation refusal, so
   * the fix travels with the nudge instead of waiting for the author to open the card and find it.
   */
  detail?: string;
  /** Lower sorts first, from the branch table. */
  priority: number;
  /** Deadline-bearing and nudged past the limit -- the PI hears about this one too. */
  deadlineBearing: boolean;
  /** Only set for slot items, so the card can point at the field. */
  slot?: AdminBotPaperSlot;
  definition?: AdminBotPaperSlotDefinition;
};

/**
 * The slots on one paper that are worth asking about right now.
 *
 * The walk is the whole policy in one place:
 *   - open means `missing` or `invalid`; provided and waived are done
 *   - a slot is only actionable once everything upstream of it is settled, so nobody is asked for
 *     an arXiv link on a paper that has not been submitted
 *   - and once everything in its `chaseAfter` is settled, which is how a field can be open on the
 *     card without being anybody's next move: the social drafts may be written off the PDF, but
 *     nobody is chased for an announcement before there is a link to announce
 *   - advisory slots (`required: false`) never appear: they block nothing, so chasing them spends
 *     the lab's attention on bookkeeping
 *
 * Cadence and snoozing are not here. They belong to the person being messaged, so the service
 * filters this list against the ledger rather than this function reading a clock.
 */
// The slides reminder carries the second half of the ask: a talk is also added to its topic's
// mega deck, which the Quick Pointers doc links from each theme's section. The service swaps this
// for the recipient's own deck when ADMINBOT_TALK_MATERIALS_JSON names one (see talk-materials.ts).
const SLIDES_DETAIL = `make the talk slides and link them here, then add them to your topic's mega deck (linked from each theme's section of <${ADMINBOT_QUICK_POINTERS_DOC_URL}|Quick Pointers>) -- add your own slides; never delete, overwrite or rearrange anyone else's`;

/**
 * What doing it looks like, for a slot that is simply empty.
 *
 * The label names the artifact; this says where it comes from or what shape it takes, so a
 * nudge can be acted on without opening the card to read the field's hint. Shorter than the
 * registry's `hint` on purpose: this is one line in a Slack list, and the hint is the card's
 * paragraph. A slot missing here gets the label alone, which is right for the self-explanatory ones.
 */
const NUDGE_HOW: Partial<Record<AdminBotPaperSlot, string>> = {
  project_folder: "paste the Google Drive folder or doc where this paper lives",
  overleaf_share:
    "in Overleaf, Share → turn on link sharing → copy the “Anyone with this link can edit” link",
  pdf_ready: "tick it once Overleaf compiles with no errors and this is the PDF you would submit",
  submission: "paste your paper's page on the venue's system (the OpenReview forum, CMT or HotCRP)",
  submission_id: "the ID the venue assigned you, shown on the submission page",
  drive_pdf_arxiv: "upload the exact PDF you will post publicly to Drive and paste its link",
  authors_ack: "tick it once the author list and acknowledgements are final",
  arxiv_paper_password: "the six-character code arXiv gives you so coauthors can claim the paper",
  pi_approval: "the explicit yes to post the paper publicly",
  arxiv: "paste the arXiv abstract page (arxiv.org/abs/…), not the PDF",
  x_draft: "write it with the drafting tool on the paper's Social tab",
  linkedin_draft: "write it with the drafting tool on the paper's Social tab",
  coauthor_feedback: "tick it once the draft posts have gone round the coauthors",
  social_final: "tick it once the coauthors' comments are folded in",
  x_post: "paste the link to the first post once it is live",
  linkedin_post: "paste the link to the post once it is live",
  poster: "paste a link to the poster file, or ask an admin to waive it if there is no poster",
  talk_video: "paste a link to the recording, or ask an admin to waive it if there is none",
};

/**
 * Why the stored value does not count, worded so the author can fix it from the message.
 *
 * A link row is re-checked against today's rules rather than trusting the reason stored with it:
 * the reason was written when the value was, and the wording it carries is whatever the validator
 * said that day -- often a bare rule ("must be a /abs/ URL") from before the refusals said what to
 * paste instead. A link that passes the check now was refused by a verifier (a Drive file
 * AdminBot cannot open, an arXiv id with no paper), and that stored reason is the one to show.
 *
 * Never echoes the value. Most of it would be harmless, but an Overleaf edit link grants write
 * access to whoever holds it, and the label's promise is that a nudge carries no credential.
 */
function invalidSlotDetail(record: AdminBotPaperSlotRecord): string | undefined {
  const definition = adminBotPaperSlotRegistry[record.slot];
  const recheck =
    definition.kind === "link" && record.url
      ? validateAdminBotPaperSlotUrl(record.slot, record.url)
      : undefined;
  const reason = recheck && !recheck.ok ? recheck.reason : record.invalid_reason;
  if (!reason) {
    return undefined;
  }
  return `${definition.kind === "link" ? "the link saved here" : "what is saved here"} does not work: ${reason}`;
}
export function actionablePaperSlots(
  paper: AdminBotPaperRecord,
  stored: AdminBotPaperSlotRecord[],
  now: Date,
  drafts: AdminBotSocialDraftRecord[] = [],
  papermentor: PaperMentorContext = {},
): NudgeItem[] {
  if (isPaperDormant(paper, now) || isPaperClosed(paper)) {
    return [];
  }
  const rows = new Map(paperSlotRows(paper.id, stored, drafts).map((row) => [row.slot, row]));
  // A slot is behind us when something downstream of it is already provided: a paper that is on
  // OpenReview compiled, whether or not anybody ticked "PDF compiles". The OpenReview sync writes
  // `submission` without `pdf_ready`, and without this the talk branch (slides, then poster) was
  // gated forever behind a core step nobody will go back and fill in. Passed slots count as
  // reached for gating and are not chased themselves.
  const passed = passedPaperSlots(rows);
  const settled = (slot: AdminBotPaperSlot) =>
    passed.has(slot) || isAdminBotPaperSlotSettled(rows.get(slot)?.status ?? "missing");

  // What the reviewer has said about this paper, which two of the slots below speak for. A review
  // that has gone stale re-opens its own slot -- and only while the paper is unsubmitted, because
  // asking somebody to re-review a paper that is already with a venue is asking for work that
  // cannot change anything. The stored row keeps saying the review happened: it did.
  const reviewState = paperMentorReviewState(papermentor, now);
  const reviewStale = isPaperMentorReviewStale(reviewState) && !settled("submission");

  const out: NudgeItem[] = [];
  for (const slot of adminBotPaperSlots) {
    const definition = adminBotPaperSlotRegistry[slot];
    if (!definition.required) {
      continue;
    }
    const record = rows.get(slot);
    if (!record) {
      continue;
    }
    const reopened = slot === "papermentor_review" && reviewStale;
    if ((isAdminBotPaperSlotSettled(record.status) || passed.has(slot)) && !reopened) {
      continue;
    }
    // Both lists, not either: `chaseAfter` says when the lab starts asking, `upstream` says when
    // the field is fillable at all, and asking for something that cannot yet be filled in is the
    // one combination neither list should be able to produce. For almost every slot `chaseAfter`
    // is absent and this is exactly the upstream check it has always been.
    if (![...definition.upstream, ...(definition.chaseAfter ?? [])].every(settled)) {
      continue;
    }
    // Four sources for the line under the label, in the order they matter: a value the service
    // refused, what the reviewer said, the slides' second half, and what a valid answer looks like.
    const invalid = record.status === "invalid" ? invalidSlotDetail(record) : undefined;
    const detail =
      invalid ??
      (slot === "papermentor_review"
        ? paperMentorReviewDetail(reviewState)
        : slot === "fixes_merged"
          ? paperMentorFixesDetail(papermentor.latest, now)
          : slot === "slides"
            ? SLIDES_DETAIL
            : undefined) ??
      NUDGE_HOW[slot];
    out.push({
      domain: "paper_slot",
      subjectId: adminBotPaperSlotSubjectId(paper.id, slot),
      owner: definition.owner,
      label: definition.label,
      ...(detail ? { detail } : {}),
      priority: adminBotPaperSlotBranchPriority[definition.branch],
      deadlineBearing: definition.deadlineBearing,
      slot,
      definition,
    });
  }
  return out;
}

/**
 * Every slot that is a transitive `upstream` ancestor of a provided slot.
 *
 * Only `provided` counts, not `waived`: a waiver says "not needed", not "done", and must not
 * silently close the steps before it.
 */
export function passedPaperSlots(
  rows: ReadonlyMap<AdminBotPaperSlot, { status: string }>,
): Set<AdminBotPaperSlot> {
  const passed = new Set<AdminBotPaperSlot>();
  const stack: AdminBotPaperSlot[] = [];
  for (const [slot, row] of rows) {
    if (row.status === "provided") {
      stack.push(...adminBotPaperSlotRegistry[slot].upstream);
    }
  }
  while (stack.length > 0) {
    const slot = stack.pop()!;
    if (passed.has(slot)) {
      continue;
    }
    passed.add(slot);
    stack.push(...adminBotPaperSlotRegistry[slot].upstream);
  }
  return passed;
}

/**
 * Whether a ledger entry says this item may go out now.
 *
 * One function for every domain, which is the point of the ledger: a snooze on a profile field and
 * a snooze on a poster mean the same thing and are read the same way.
 */
export function isNudgeDue(
  entry: AdminBotNudgeLedgerRecord | undefined,
  now: Date,
  intervalMs: number,
): boolean {
  if (!entry) {
    return true;
  }
  if (entry.snoozed_until && Date.parse(entry.snoozed_until) > now.getTime()) {
    return false;
  }
  if (!entry.last_nudged_at) {
    return true;
  }
  return Date.parse(entry.last_nudged_at) <= now.getTime() - intervalMs;
}

export function shouldEscalate(
  item: NudgeItem,
  entry: AdminBotNudgeLedgerRecord | undefined,
): boolean {
  return item.deadlineBearing && (entry?.nudge_count ?? 0) >= adminBotPaperSlotEscalateAfterNudges;
}

/** Bounds an author-set snooze. Long enough for a conference week, no longer. */
export function boundSnooze(
  rawUntil: string,
  now: Date,
): { ok: true; until: string } | { ok: false; error: string } {
  const until = Date.parse(rawUntil);
  if (Number.isNaN(until)) {
    return { ok: false, error: "snoozed_until must be a date" };
  }
  if (until > now.getTime() + adminBotNudgeMaxSnoozeDays * DAY_MS) {
    return {
      ok: false,
      error: `a nudge can be snoozed for at most ${adminBotNudgeMaxSnoozeDays} days`,
    };
  }
  return { ok: true, until: new Date(until).toISOString() };
}

/**
 * How complete one paper's evidence is, for the card header and the overview row.
 *
 * Advisory slots are excluded from the denominator for the same reason they are excluded from the
 * nudge: a progress bar that can never reach 100% because of optional bookkeeping stops being a
 * progress bar.
 */
export function paperSlotProgress(
  paperId: string,
  stored: AdminBotPaperSlotRecord[],
  drafts: AdminBotSocialDraftRecord[] = [],
): { provided: number; total: number } {
  const rows = new Map(paperSlotRows(paperId, stored, drafts).map((row) => [row.slot, row]));
  const required = adminBotPaperSlots.filter((slot) => adminBotPaperSlotRegistry[slot].required);
  const provided = required.filter((slot) =>
    isAdminBotPaperSlotSettled(rows.get(slot)?.status ?? "missing"),
  ).length;
  return { provided, total: required.length };
}

/**
 * Is this paper finished?
 *
 * Every required artifact in, everybody on the paper accounted for at the conference, and every
 * author who actually went square on their expenses. The last two are the ones that matter: "the
 * paper looks done" is a judgement someone makes and then forgets to revisit, and travel is what
 * stays genuinely outstanding for weeks after everything else is finished.
 *
 * `attendees` is the merged roll-call from workflows/papers/conference-attendance.ts, not the
 * stored rows -- an author nobody has answered for arrives here as `unknown`, which is what lets
 * an unanswered roll-call hold the cycle open. Passing raw store rows would read a paper nobody
 * has filled in as one where nobody is travelling.
 *
 * Derived, never stored -- see the note at the top of contracts/paper-slots.ts.
 */
export function isCycleClosed(params: {
  paper: AdminBotPaperRecord;
  slots: AdminBotPaperSlotRecord[];
  drafts: AdminBotSocialDraftRecord[];
  attendees: AdminBotConferenceAttendeeLike[];
  reimbursements: AdminBotPaperReimbursementRecord[];
}): boolean {
  const { provided, total } = paperSlotProgress(params.paper.id, params.slots, params.drafts);
  if (provided < total) {
    return false;
  }
  // Only once the branch is open. Before that nobody has been asked who is travelling, so an
  // unanswered roll-call is the acceptance details being missing, not the authors being slow --
  // and the card already says so through `missingAcceptanceDetails`.
  if (
    isConferenceBranchOpen(params.paper) &&
    params.attendees.some((entry) => entry.attending === "unknown")
  ) {
    return false;
  }
  const attending = params.attendees.filter((entry) => entry.attending === "yes");
  const byMember = new Map(params.reimbursements.map((row) => [row.member_id, row]));
  return attending.every((entry) => {
    if (!entry.member_id) {
      // Somebody with no roster row cannot be reimbursed through the lab, so they cannot hold the
      // cycle open. Recording that they went is still worth doing.
      return true;
    }
    const status = byMember.get(entry.member_id)?.status;
    return status === "reimbursed" || status === "not_applicable";
  });
}

type AdminBotConferenceAttendeeLike = { member_id?: string; attending: string };

/** One thing already in on a paper, as the nudge's "Already in" line shows it. */
export type NudgeDoneItem = {
  /** Short, so a paper with fifteen things done still fits on a line. */
  label: string;
  /** Only for a link the reader can safely be handed back; see `paperSlotsAlreadyIn`. */
  url?: string;
};

/** The "Already in" names. The registry labels are written for the card's rows and run long. */
const DONE_LABEL: Partial<Record<AdminBotPaperSlot, string>> = {
  project_folder: "project folder",
  overleaf_view: "Overleaf read-only link",
  overleaf_share: "Overleaf edit link",
  papermentor_review: "PaperMentor review",
  fixes_merged: "review fixes",
  pdf_ready: "clean PDF",
  submission: "submission page",
  submission_id: "submission ID",
  drive_pdf_arxiv: "Drive PDF",
  authors_ack: "author list",
  arxiv_paper_password: "arXiv password",
  pi_approval: "PI approval",
  arxiv: "arXiv",
  x_draft: "X draft",
  linkedin_draft: "LinkedIn draft",
  coauthor_feedback: "coauthor feedback",
  social_final: "final social copy",
  x_post: "X post",
  linkedin_post: "LinkedIn post",
  slides: "slides",
  poster: "poster",
  talk_video: "talk video",
};

/**
 * Advisory slots worth naming as done anyway. The read-only Overleaf link is the one people
 * actually paste in channels, so leaving it off would make "Already in" look like it was missed.
 */
const DONE_ADVISORY: ReadonlySet<AdminBotPaperSlot> = new Set(["overleaf_view"]);

/**
 * Links that are named as done but never repeated. The Overleaf edit link grants write access to
 * whoever holds it (see its hint in the registry), and a nudge is forwarded, pasted and read
 * over shoulders far more freely than the paper record it came from.
 */
const DONE_NEVER_LINKED: ReadonlySet<AdminBotPaperSlot> = new Set([
  "overleaf_share",
  "overleaf_edit",
]);

/**
 * What one paper already has, for the line that tells a person their work was seen.
 *
 * Read off the same rows as `paperSlotProgress` and with the same test, so the message and the
 * card cannot disagree about what is done. `provided` only: a waiver is an admin saying it is not
 * needed, which is not something the author did. No value is ever read -- only the URL of a link
 * slot, and only for slots that are neither confidential nor in `DONE_NEVER_LINKED` -- so the
 * password, feedback and impact text cannot reach the line however the filter above changes.
 */
export function paperSlotsAlreadyIn(
  paperId: string,
  stored: AdminBotPaperSlotRecord[],
  drafts: AdminBotSocialDraftRecord[] = [],
): NudgeDoneItem[] {
  const out: NudgeDoneItem[] = [];
  for (const row of paperSlotRows(paperId, stored, drafts)) {
    const definition = adminBotPaperSlotRegistry[row.slot];
    if (row.status !== "provided" || (!definition.required && !DONE_ADVISORY.has(row.slot))) {
      continue;
    }
    const label = DONE_LABEL[row.slot] ?? definition.label;
    const url =
      definition.kind === "link" &&
      !isConfidentialPaperSlot(row.slot) &&
      !DONE_NEVER_LINKED.has(row.slot)
        ? slackSafeUrl(row.url)
        : undefined;
    out.push(url ? { label, url } : { label });
  }
  return out;
}

/**
 * A URL that can sit inside Slack's `<url|text>` without breaking it, or nothing.
 *
 * `|` and `>` end the link early and `<` opens a new one; whitespace is not a URL. A stored link
 * was validated as https when it was saved, so this only ever drops something odd -- and a name
 * without its link is a better line than a link that swallows the rest of the message.
 */
function slackSafeUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value || !value.startsWith("https://") || /[\s<>|]/u.test(value)) {
    return undefined;
  }
  return value;
}

/** The project page's tab for each branch: ui/src/ui/adminbot/projects/model.ts `PROJECT_LANES`. */
const PROJECT_LANE_SEGMENT: Record<AdminBotPaperSlotBranch, string> = {
  core: "writing",
  venue: "venue",
  archive: "archival",
  talk: "talk",
  social: "social",
};

/**
 * Where on the Control UI this paper's open items are: `/my-work/<paper>`, plus the lane when
 * every item is a slot in one lane, so the link lands on the fields being asked about. Items in
 * several lanes get the project page, which shows all of them; guessing one lane would hide the rest.
 */
export function paperNudgeUrl(params: {
  controlUiUrl: string;
  paperId: string;
  items: readonly NudgeItem[];
}): string {
  const base = `${params.controlUiUrl.replace(/\/+$/u, "")}/my-work/${encodeURIComponent(params.paperId)}`;
  // An item with no slot behind it (attendance, a reimbursement, a broken link) has no lane of
  // its own, so it counts as "somewhere else" and the link stays on the whole project.
  const lanes = new Set(params.items.map((item) => item.definition?.branch));
  const [only] = lanes;
  return lanes.size === 1 && only ? `${base}/${PROJECT_LANE_SEGMENT[only]}` : base;
}

/**
 * The message, composed from the items themselves.
 *
 * One person, one message, however many papers and however many kinds of thing they owe -- which
 * is the whole reason the cadence moved into a shared ledger. Grouped by paper so the reader can
 * see which of their three papers each line belongs to.
 *
 * Each paper says what is already in before what is still needed. A message that only lists gaps
 * reads the same to somebody who did nothing and to somebody who did nine things out of ten, and
 * the second person is the one it discourages.
 */
export function buildNudgeMessage(params: {
  groups: Array<{
    title: string;
    venue?: string;
    deadline?: string;
    items: NudgeItem[];
    /**
     * Replaces the "*title*" line for a group that is not a paper, e.g. the person's own time
     * availability riding along in the same message.
     */
    heading?: string;
    /** What this paper already has, from `paperSlotsAlreadyIn`. */
    done?: NudgeDoneItem[];
    /** This paper on the Control UI, from `paperNudgeUrl`. */
    url?: string;
  }>;
  now: Date;
}): string {
  const lines: string[] = [];
  let linked = false;
  for (const group of params.groups) {
    if (group.heading) {
      lines.push(group.heading);
    } else {
      const url = slackSafeUrl(group.url);
      linked ||= Boolean(url);
      if (!url && !group.done?.length) {
        // Nothing to add, so the old one-line heading: no reason to spend two lines on it.
        lines.push(`*${group.title}* still needs:`);
      } else {
        lines.push(url ? `*${group.title}* — <${url}|open it in AdminBot>` : `*${group.title}*`);
        if (group.done?.length) {
          const done = group.done.map((item) =>
            item.url ? `<${item.url}|${item.label}>` : item.label,
          );
          lines.push(`Already in: ${done.join(", ")}`);
        }
        lines.push("Still needs:");
      }
    }
    for (const item of group.items) {
      lines.push(item.detail ? `• ${item.label} — ${item.detail}` : `• ${item.label}`);
    }
    const deadline = group.deadline ? Date.parse(group.deadline) : Number.NaN;
    if (Number.isFinite(deadline)) {
      const days = Math.ceil((deadline - params.now.getTime()) / DAY_MS);
      // Naming the venue costs one word and saves the reader working out which of their three
      // deadlines this is.
      const venue = group.venue ? `${group.venue} ` : "";
      lines.push(
        days >= 0
          ? `The ${venue}deadline is in ${days} day${days === 1 ? "" : "s"}.`
          : `The ${venue}deadline passed ${Math.abs(days)} day${days === -1 ? "" : "s"} ago.`,
      );
    }
    lines.push("");
  }
  lines.push(
    linked
      ? "Each link opens that paper in AdminBot, where these are filled in. If something here is already done or does not apply, reply and say so."
      : "Fill these in on My Projects & Papers in AdminBot.",
  );
  return lines.join("\n");
}

/**
 * Which of a paper's named authors are lab members, and which the first author is.
 *
 * Free-text author names are how the paper spells them, not who is on the roster, so a match is a
 * convenience and never an identity.
 */
export function resolveConsentAudience(params: {
  authors: string[];
  roster: Array<{ id: string; name: string }>;
  exclude?: string;
}): string[] {
  const byName = new Map(
    params.roster.map((member) => [member.name.trim().toLocaleLowerCase(), member.id]),
  );
  const seen = new Set<string>();
  for (const author of params.authors) {
    const id = byName.get(author.trim().toLocaleLowerCase());
    if (id && id !== params.exclude) {
      seen.add(id);
    }
  }
  return [...seen];
}

/** A draft is approved once nobody is still pending and nobody is asking for changes. */
export function draftConsentState(consents: AdminBotSocialConsentRecord[]): {
  approved: boolean;
  pending: AdminBotSocialConsentRecord[];
  changesRequested: AdminBotSocialConsentRecord[];
} {
  const pending = consents.filter((row) => row.decision === "pending");
  const changesRequested = consents.filter((row) => row.decision === "changes_requested");
  return {
    approved: pending.length === 0 && changesRequested.length === 0,
    pending,
    changesRequested,
  };
}

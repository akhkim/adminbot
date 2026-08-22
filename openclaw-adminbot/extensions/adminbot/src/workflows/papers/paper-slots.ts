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
  type AdminBotPaperSlotDefinition,
  type AdminBotPaperSlotInput,
  type AdminBotPaperSlotOwner,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";

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
    if (!isConfidentialPaperSlot(row.slot)) {
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
      if (!value) {
        return { ok: true, record: clearedSlot(existing) };
      }
      const check = validateAdminBotPaperSlotUrl(existing.slot, value);
      if (!check.ok) {
        return {
          ok: true,
          record: {
            ...existing,
            status: "invalid",
            url: value,
            provided_by_member_id: memberId,
            provided_at: nowIso,
            invalid_reason: check.reason,
            validated_at: undefined,
          },
        };
      }
      return { ok: true, record: provided({ url: value, validated_at: nowIso }) };
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

/** A rejected paper that has not been re-aimed has no frontier: the next move is a venue decision. */
export function isPaperClosed(paper: AdminBotPaperRecord): boolean {
  return paper.venue_decision === "reject";
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
 *   - advisory slots (`required: false`) never appear: they block nothing, so chasing them spends
 *     the lab's attention on bookkeeping
 *
 * Cadence and snoozing are not here. They belong to the person being messaged, so the service
 * filters this list against the ledger rather than this function reading a clock.
 */
export function actionablePaperSlots(
  paper: AdminBotPaperRecord,
  stored: AdminBotPaperSlotRecord[],
  now: Date,
  drafts: AdminBotSocialDraftRecord[] = [],
): NudgeItem[] {
  if (isPaperDormant(paper, now) || isPaperClosed(paper)) {
    return [];
  }
  const rows = new Map(paperSlotRows(paper.id, stored, drafts).map((row) => [row.slot, row]));
  const settled = (slot: AdminBotPaperSlot) =>
    isAdminBotPaperSlotSettled(rows.get(slot)?.status ?? "missing");

  const out: NudgeItem[] = [];
  for (const slot of adminBotPaperSlots) {
    const definition = adminBotPaperSlotRegistry[slot];
    if (!definition.required) {
      continue;
    }
    const record = rows.get(slot);
    if (!record || isAdminBotPaperSlotSettled(record.status)) {
      continue;
    }
    if (!definition.upstream.every(settled)) {
      continue;
    }
    out.push({
      domain: "paper_slot",
      subjectId: adminBotPaperSlotSubjectId(paper.id, slot),
      owner: definition.owner,
      label: definition.label,
      ...(record.status === "invalid" && record.invalid_reason
        ? { detail: `the value on file was rejected: ${record.invalid_reason}` }
        : {}),
      priority: adminBotPaperSlotBranchPriority[definition.branch],
      deadlineBearing: definition.deadlineBearing,
      slot,
      definition,
    });
  }
  return out;
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
 * Every required artifact in, and every author who actually went to the conference square on their
 * expenses. The second half is the one that matters: "the paper looks done" is a judgement someone
 * makes and then forgets to revisit, and the reimbursement is the thing that is genuinely
 * outstanding for weeks after everything else is finished.
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

/**
 * The message, composed from the items themselves.
 *
 * One person, one message, however many papers and however many kinds of thing they owe -- which
 * is the whole reason the cadence moved into a shared ledger. Grouped by paper so the reader can
 * see which of their three papers each line belongs to.
 */
export function buildNudgeMessage(params: {
  groups: Array<{ title: string; venue?: string; deadline?: string; items: NudgeItem[] }>;
  now: Date;
}): string {
  const lines: string[] = [];
  for (const group of params.groups) {
    lines.push(`*${group.title}* still needs:`);
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
  lines.push("Fill these in on My Projects & Papers in AdminBot.");
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

// The rules for one paper's evidence slots: what a stored row means, what a write to one does,
// and which of them are worth nudging about right now.
//
// Pure, and deliberately so. The service owns the store, the roster and the outbound message; this
// file only turns records into decisions, which is what makes the nudge pass testable without a
// database or a Slack connector.
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  adminBotPaperSlotBranchPriority,
  adminBotPaperSlotEscalateAfterNudges,
  adminBotPaperSlotMaxSnoozeDays,
  adminBotPaperSlotRegistry,
  adminBotPaperSlots,
  isAdminBotPaperSlotSettled,
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

/** An unwritten slot is `missing`, not absent. Every read sees all 23 rows so the UI never has to fill gaps. */
export function blankPaperSlot(paperId: string, slot: AdminBotPaperSlot): AdminBotPaperSlotRecord {
  return { paper_id: paperId, slot, status: "missing", nudge_count: 0 };
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
): AdminBotPaperSlotRecord[] {
  const byslot = new Map(stored.map((record) => [record.slot, record]));
  return adminBotPaperSlots.map((slot) => byslot.get(slot) ?? blankPaperSlot(paperId, slot));
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
 * A failed URL check stores the value as `invalid` rather than rejecting the write outright. The
 * author needs to see what they pasted alongside the reason it was refused -- throwing it away and
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

  if (input.snoozed_until !== undefined) {
    const until = Date.parse(input.snoozed_until);
    if (Number.isNaN(until)) {
      return { ok: false, error: "snoozed_until must be a date" };
    }
    const cap = params.now.getTime() + adminBotPaperSlotMaxSnoozeDays * DAY_MS;
    if (until > cap) {
      return {
        ok: false,
        error: `a slot can be snoozed for at most ${adminBotPaperSlotMaxSnoozeDays} days`,
      };
    }
    return {
      ok: true,
      record: { ...existing, snoozed_until: new Date(until).toISOString() },
    };
  }

  switch (definition.kind) {
    case "bool": {
      if (typeof input.done !== "boolean") {
        return { ok: false, error: `${definition.label} takes a yes or no` };
      }
      return {
        ok: true,
        record: input.done
          ? {
              ...existing,
              status: "provided",
              provided_by_member_id: memberId,
              provided_at: nowIso,
              invalid_reason: undefined,
            }
          : clearedSlot(existing),
      };
    }
    case "text": {
      const value = (input.value_text ?? "").trim();
      if (!value) {
        return { ok: true, record: clearedSlot(existing) };
      }
      return {
        ok: true,
        record: {
          ...existing,
          status: "provided",
          value_text: value,
          provided_by_member_id: memberId,
          provided_at: nowIso,
          invalid_reason: undefined,
        },
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
      return {
        ok: true,
        record: {
          ...existing,
          status: "provided",
          url: value,
          provided_by_member_id: memberId,
          provided_at: nowIso,
          validated_at: nowIso,
          invalid_reason: undefined,
        },
      };
    }
  }
}

/**
 * Back to missing, keeping the counters.
 *
 * `nudge_count` and `last_nudged_at` survive on purpose: clearing a slot you were being chased
 * about must not reset the escalation clock, or the escalation is one click away from never
 * happening.
 */
function clearedSlot(existing: AdminBotPaperSlotRecord): AdminBotPaperSlotRecord {
  return {
    paper_id: existing.paper_id,
    slot: existing.slot,
    status: "missing",
    nudge_count: existing.nudge_count,
    ...(existing.last_nudged_at ? { last_nudged_at: existing.last_nudged_at } : {}),
    ...(existing.snoozed_until ? { snoozed_until: existing.snoozed_until } : {}),
  };
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

export type ActionablePaperSlot = {
  slot: AdminBotPaperSlot;
  definition: AdminBotPaperSlotDefinition;
  record: AdminBotPaperSlotRecord;
  owner: AdminBotPaperSlotOwner;
  /** Deadline-bearing and nudged past the limit -- the PI hears about this one too. */
  escalate: boolean;
};

/**
 * The slots on one paper that are worth asking about right now.
 *
 * The walk is the whole nudge policy in one place:
 *   - open means `missing` or `invalid`; provided and waived are done
 *   - a slot is only actionable once everything upstream of it is settled, so nobody is asked for
 *     an arXiv link on a paper that has not been submitted
 *   - a snoozed slot is skipped until its clock runs out
 *   - advisory slots (`required: false`) never appear: they block nothing, so chasing them spends
 *     the lab's attention on bookkeeping
 *
 * Ranked by branch priority, then by registry order, so the answer is stable run to run.
 */
export function actionablePaperSlots(
  paper: AdminBotPaperRecord,
  stored: AdminBotPaperSlotRecord[],
  now: Date,
): ActionablePaperSlot[] {
  if (isPaperDormant(paper, now) || isPaperClosed(paper)) {
    return [];
  }
  const rows = new Map(paperSlotRows(paper.id, stored).map((row) => [row.slot, row]));
  const settled = (slot: AdminBotPaperSlot) =>
    isAdminBotPaperSlotSettled(rows.get(slot)?.status ?? "missing");

  const out: ActionablePaperSlot[] = [];
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
    if (record.snoozed_until && Date.parse(record.snoozed_until) > now.getTime()) {
      continue;
    }
    out.push({
      slot,
      definition,
      record,
      owner: definition.owner,
      escalate:
        definition.deadlineBearing && record.nudge_count >= adminBotPaperSlotEscalateAfterNudges,
    });
  }

  const order = new Map(adminBotPaperSlots.map((slot, index) => [slot, index]));
  return out.toSorted(
    (left, right) =>
      adminBotPaperSlotBranchPriority[left.definition.branch] -
        adminBotPaperSlotBranchPriority[right.definition.branch] ||
      (order.get(left.slot) ?? 0) - (order.get(right.slot) ?? 0),
  );
}

/**
 * How complete one paper's evidence is, for the card header and the overview row.
 *
 * Advisory slots are excluded from the denominator for the same reason they are excluded from the
 * nudge: a progress bar that can never reach 100% because of optional bookkeeping stops being a
 * progress bar.
 */
export function paperSlotProgress(stored: AdminBotPaperSlotRecord[]): {
  provided: number;
  total: number;
} {
  const required = adminBotPaperSlots.filter((slot) => adminBotPaperSlotRegistry[slot].required);
  const rows = new Map(stored.map((record) => [record.slot, record]));
  const provided = required.filter((slot) =>
    isAdminBotPaperSlotSettled(rows.get(slot)?.status ?? "missing"),
  ).length;
  return { provided, total: required.length };
}

/**
 * The message, composed from the slots themselves.
 *
 * It names the artifacts rather than the step, because "you are on Overleaf writing" is not
 * something a person can act on and "the PaperMentor review and a clean PDF" is. The deadline line
 * only appears when the paper actually carries one -- an invented urgency is worse than none.
 */
export function buildPaperSlotNudgeMessage(params: {
  paper: AdminBotPaperRecord;
  entries: ActionablePaperSlot[];
  now: Date;
}): string {
  const { paper, entries } = params;
  const lines = [`*${paper.title}* still needs:`];
  for (const entry of entries) {
    const reason =
      entry.record.status === "invalid" && entry.record.invalid_reason
        ? ` — the link on file was rejected: ${entry.record.invalid_reason}`
        : "";
    lines.push(`• ${entry.definition.label}${reason}`);
  }
  const deadline = paper.deadline ? Date.parse(paper.deadline) : Number.NaN;
  if (Number.isFinite(deadline)) {
    const days = Math.ceil((deadline - params.now.getTime()) / DAY_MS);
    const venue = paper.venue ? `${paper.venue} ` : "";
    lines.push(
      days >= 0
        ? `The ${venue}deadline is in ${days} day${days === 1 ? "" : "s"}.`
        : `The ${venue}deadline passed ${Math.abs(days)} day${days === -1 ? "" : "s"} ago.`,
    );
  }
  lines.push("Fill these in on My Projects & Papers in AdminBot.");
  return lines.join("\n");
}

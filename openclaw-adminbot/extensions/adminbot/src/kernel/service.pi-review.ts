// Head-professor gate on PI review slots, cut from service.ts so it stays under its file-size
// ratchet. Pure: the service supplies the head professor and whether the writer is a PI approver, and returns the 403.
import type { AdminBotNudgeLedgerRecord } from "../contracts/paper-cycle.js";
import { parsePaperFeedback } from "../contracts/paper-feedback.js";
import {
  mergePaperImpactWrite,
  paperImpactApprovalBlock,
  paperImpactStatus,
  parsePaperImpactStatement,
  type PaperSafetyInput,
} from "../contracts/paper-impact.js";
import { PI_REVIEW_ACK_DOMAIN } from "../workflows/papers/pi-review-ack.js";
import type { PiReviewRow } from "../workflows/papers/pi-review.js";

/**
 * Why this write needs a PI reviewer and the writer is not one, or null when it may go ahead.
 * Approving publication, and marking feedback reviewed or noted, belong to the head professor and
 * the PI approvers the host names next to her. Whether the writer is one of those approvers is the
 * route's call (api/routes/pi-approvers.ts), since it depends on the session, not only the id.
 */
export function piReviewSlotDenial(params: {
  slot: string;
  valueText?: string | null;
  memberId?: string;
  headProfessorMemberId?: string | null;
  piApprover?: boolean;
  /** An admin "viewing as" the writer: never the PI's own yes, whoever is being viewed. */
  viewAs?: boolean;
}): string | null {
  const writer = params.memberId?.trim();
  const head = params.headProfessorMemberId?.trim();
  if (params.piApprover || (!params.viewAs && writer && head && writer === head)) {
    return null;
  }
  if (params.slot === "pi_approval") {
    return "Only the head professor or a PI approver can approve publication.";
  }
  if (params.slot.startsWith("feedback_") && params.valueText) {
    const feedback = parsePaperFeedback(params.valueText);
    if (feedback?.reviewed || feedback?.review_note) {
      return "Only the head professor or a PI approver can record paper feedback completion.";
    }
  }
  return null;
}

/**
 * The impact-statement write as it will be stored, with the review and the safety correction
 * either changed by somebody allowed to or carried over from the stored row. A refusal carries
 * the status to answer with.
 */
export function paperImpactSlotWrite(params: {
  existingValueText?: string;
  valueText?: string | null;
  memberId: string;
  headProfessorMemberId?: string | null;
  privileged: boolean;
  now: string;
}): { ok: true; valueText: string } | { ok: false; status: 400 | 403; error: string } {
  const merged = mergePaperImpactWrite({
    existing: parsePaperImpactStatement(params.existingValueText),
    valueText: params.valueText ?? undefined,
    memberId: params.memberId,
    isHeadProfessor: Boolean(
      params.headProfessorMemberId?.trim() &&
      params.memberId === params.headProfessorMemberId.trim(),
    ),
    privileged: params.privileged,
    now: params.now,
  });
  return merged.ok ? { ok: true, valueText: JSON.stringify(merged.statement) } : merged;
}

/**
 * Why the PI's yes to publication must wait on the impact statement, or null. Only the yes is
 * held: withdrawing an approval, or approving a paper the check does not cover, goes through.
 */
export function piApprovalImpactDenial(params: {
  slot: string;
  done?: boolean;
  paper: PaperSafetyInput;
  impactValueText?: string;
}): string | null {
  if (params.slot !== "pi_approval" || params.done !== true) {
    return null;
  }
  return paperImpactApprovalBlock(
    paperImpactStatus(params.paper, parsePaperImpactStatement(params.impactValueText)),
  );
}

type AckLedger = {
  listNudgeLedger(domain?: string): AdminBotNudgeLedgerRecord[];
  saveNudgeLedgerEntry(record: AdminBotNudgeLedgerRecord): void;
};

/** The My Desk rows marked reviewed and not since undone, by their state-bearing key. */
export function piReviewAckedKeys(ledger: Pick<AckLedger, "listNudgeLedger">): Set<string> {
  return new Set(
    ledger
      .listNudgeLedger(PI_REVIEW_ACK_DOMAIN)
      .filter((entry) => entry.nudge_count > 0)
      .map((entry) => entry.subject_id),
  );
}

/**
 * Marks one My Desk row reviewed, or undoes that. Only a key the desk is showing right now, open
 * or already reviewed, can be written: anything else is a stale tab or a made-up key, and storing
 * it would hide nothing and grow the ledger.
 */
export function writePiReviewAck(
  ledger: AckLedger,
  params: {
    key: string;
    reviewed: boolean;
    actor: string;
    rows: readonly PiReviewRow[];
    now: string;
  },
):
  | { ok: true; status: 200; payload: { key: string; reviewed: boolean } }
  | { ok: false; status: 400 | 404; error: { message: string } } {
  const key = params.key.trim();
  if (!key) {
    return { ok: false, status: 400, error: { message: "key is required" } };
  }
  if (!params.rows.some((row) => row.ack_key === key)) {
    return {
      ok: false,
      status: 404,
      error: { message: "That item is no longer on the desk. Reload My Desk and try again." },
    };
  }
  ledger.saveNudgeLedgerEntry({
    domain: PI_REVIEW_ACK_DOMAIN,
    subject_id: key,
    member_id: params.actor,
    last_nudged_at: params.now,
    nudge_count: params.reviewed ? 1 : 0,
  });
  return { ok: true, status: 200, payload: { key, reviewed: params.reviewed } };
}

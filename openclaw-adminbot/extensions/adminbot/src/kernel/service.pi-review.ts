// Head-professor gate on PI review slots, cut from service.ts so it stays under its file-size
// ratchet. Pure: the service supplies the head professor and whether the writer is a PI approver, and returns the 403.
import { parsePaperFeedback } from "../contracts/paper-feedback.js";
import {
  mergePaperImpactWrite,
  paperImpactApprovalBlock,
  paperImpactStatus,
  parsePaperImpactStatement,
  type PaperSafetyInput,
} from "../contracts/paper-impact.js";

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
}): string | null {
  const writer = params.memberId?.trim();
  const head = params.headProfessorMemberId?.trim();
  if (params.piApprover || (writer && head && writer === head)) {
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

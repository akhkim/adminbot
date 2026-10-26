// Head-professor gate on PI review slots, cut from service.ts so it stays under its file-size
// ratchet. Pure: the service supplies the configured head professor and returns the 403.
import { parsePaperFeedback } from "../contracts/paper-feedback.js";
import {
  mergePaperImpactWrite,
  paperImpactApprovalBlock,
  paperImpactStatus,
  parsePaperImpactStatement,
  type PaperSafetyInput,
} from "../contracts/paper-impact.js";

/**
 * Why this write needs the head professor and the writer is not them, or null when it may go
 * ahead. Approving publication, and marking feedback reviewed or noted, are the PI's alone.
 */
export function piReviewSlotDenial(params: {
  slot: string;
  valueText?: string | null;
  memberId?: string;
  headProfessorMemberId?: string | null;
}): string | null {
  if (params.memberId === params.headProfessorMemberId?.trim()) {
    return null;
  }
  if (params.slot === "pi_approval") {
    return "Only the head professor can approve publication.";
  }
  if (params.slot.startsWith("feedback_") && params.valueText) {
    const feedback = parsePaperFeedback(params.valueText);
    if (feedback?.reviewed || feedback?.review_note) {
      return "Only the head professor can record paper feedback completion.";
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

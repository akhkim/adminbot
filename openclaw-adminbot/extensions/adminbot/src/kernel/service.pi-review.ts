// Head-professor gate on PI review slots, cut from service.ts so it stays under its file-size
// ratchet. Pure: the service supplies the configured head professor and returns the 403.
import { parsePaperFeedback } from "../contracts/paper-feedback.js";

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

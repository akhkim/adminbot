// Opening one paper from a list that names it: Active Papers' rows and My Desk's PI review queue.
//
// Everybody lands on the paper's project page -- the page its authors work on -- except the head
// professor, who gets the review dialog (review-dialog.ts): the manuscript, the feedback asked of
// her, and publication approval, rather than the authors' whole checklist. Which one opens is a
// matter of presentation; the service checks every write either way.
import type { AppViewState } from "../../app-view-state.ts";
import { isHeadProfessorViewer } from "../access.ts";
import { loadAdminBotPaperSlots } from "../controllers/paper-slots.ts";
import { navigateToProject } from "./model.ts";

export function isPiReviewViewer(state: AppViewState): boolean {
  return isHeadProfessorViewer({
    memberId: state.memberId,
    headProfessorMemberId: state.adminBotData?.settings?.head_professor_member_id,
  });
}

export function openPaperForViewer(
  state: AppViewState,
  paperId: string,
  requestHostUpdate?: () => void,
): void {
  if (isPiReviewViewer(state)) {
    state.adminBotPaperCardId = paperId;
    // The review reads the paper's cycle -- the feedback requests and the approval slot.
    void loadAdminBotPaperSlots(state, paperId).finally(() => requestHostUpdate?.());
    requestHostUpdate?.();
    return;
  }
  navigateToProject(state, paperId);
}

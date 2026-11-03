// Opening one paper from a list that names it: Active Papers' rows and My Desk's PI review queue.
//
// Everybody lands on the paper's project page -- the page its authors work on -- except the head
// professor and the PI approvers settings name next to her, who get the review dialog
// (review-dialog.ts): the manuscript, the feedback asked of the PI, and publication approval,
// rather than the authors' whole checklist. Which one opens is a matter of presentation; the
// service checks every write either way.
import type { AppViewState } from "../../app-view-state.ts";
import { isHeadProfessorViewer } from "../access.ts";
import { loadAdminBotPaperSlots } from "../controllers/paper-slots.ts";
import { navigateToProject } from "./model.ts";

export function isPiReviewViewer(state: AppViewState): boolean {
  const settings = state.adminBotData?.settings;
  const viewer = state.memberId?.trim();
  return (
    isHeadProfessorViewer({
      memberId: state.memberId,
      headProfessorMemberId: settings?.head_professor_member_id,
    }) ||
    Boolean(viewer && settings?.pi_approver_member_ids?.some((id) => id.trim() === viewer))
  );
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

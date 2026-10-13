// My Projects & Papers: the sidebar's project list, the card list, and each project's page -- and
// the head professor's review dialog, which draws the same paper through the same writes.
//
// The wiring from those views to the controllers lives here, built once, so the project page, the
// flat view, the sheet and the review dialog cannot grow different save paths. See scope.ts for
// what every surface is handed.
import { nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { EMPTY_SLACK_CHANNEL_CHECK, saveAdminBotPaper } from "../controllers/admin.ts";
import { loadSlackChannelNames } from "../controllers/directory.ts";
import {
  circulateAdminBotSocialDraft,
  editAdminBotTrip,
  loadAdminBotPaperSlots,
  recordAdminBotSocialConsent,
  saveAdminBotPaperSlot,
  saveAdminBotPaperWeeklyUpdate,
  saveAdminBotSocialDraft,
  saveAdminBotTrip,
  setAdminBotPaperAttendee,
  setAdminBotPaperReimbursement,
  withdrawAdminBotTrip,
} from "../controllers/paper-slots.ts";
import { deleteAdminBotPaper } from "../controllers/papers.ts";
import { loadAdminBotRecentEdits } from "../controllers/recent-edits.ts";
import type { ProjectsNavState } from "../projects/nav.ts";
import { isPiReviewViewer } from "../projects/open-paper.ts";
import { renderPaperReviewDialog, type ReviewPaper } from "../projects/review-dialog.ts";
import { renderMyProjects } from "../projects/view.ts";
import type { PaperWorkspaceProps } from "../projects/workspace.ts";
import { paperTripDraftFrom } from "../views/paper-cycle.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

/**
 * The stored trip for one conference, from whichever loaded cycle carries it. A trip belongs to a
 * conference, not a paper, so every paper at that venue holds the same row.
 */
function tripFor(state: AppViewState, conferenceKey: string) {
  return Object.values(state.adminBotPaperSlots).find(
    (cycle) => cycle.conferenceKey === conferenceKey,
  )?.myTrip;
}

export function paperWorkspaceProps(
  state: AppViewState,
  scope: Pick<AdminBotSurfaceScope, "accessRole" | "requestHostUpdate">,
): PaperWorkspaceProps {
  const { requestHostUpdate } = scope;
  // A write can change what is open on a project, so the sidebar's summaries are read again after
  // it lands: null is what asks for them (renderApp), and the read is cheap.
  const done = () => {
    state.myProjects = null;
    requestHostUpdate?.();
  };
  return {
    onSavePaper: (paper) => void saveAdminBotPaper(state, paper).finally(done),
    onSaveBlocker: (paper) =>
      saveAdminBotPaper(state, paper).finally(() => {
        state.myProjects = null;
      }),
    onRerender: () => requestHostUpdate?.(),
    onLoadRecentEdits: (subject, id) => {
      void loadAdminBotRecentEdits(state, subject, id).finally(() => requestHostUpdate?.());
    },
    overview: state.adminBotPaperSlotOverview,
    slots: state.adminBotPaperSlots,
    slotsBusyId: state.adminBotPaperSlotsBusyId,
    slotsError: state.adminBotPaperSlotsError,
    slotsNotice: state.adminBotPaperSlotsNotice,
    // Which drawing the card list lands on, not what anybody may do: the role already resolved for
    // the whole render, so it cannot disagree with the tabs beside it.
    viewerIsAdmin: scope.accessRole === "admin",
    onLoadSlots: (paperId) => {
      void loadAdminBotPaperSlots(state, paperId).finally(() => requestHostUpdate?.());
    },
    onSaveSlot: (paperId, slot, input) => {
      void saveAdminBotPaperSlot(state, paperId, slot, input).finally(done);
    },
    // The reader's own travel answers, keyed by conference. Wired here rather than in the view so
    // the page stays a renderer: one trip covers every paper at a venue, and the controller knows
    // which other loaded cycles to refresh when one is saved.
    tripDrafts: state.adminBotTripDrafts,
    tripSavingKey: state.adminBotTripSavingKey,
    onEditTrip: (conferenceKey, patch) => {
      editAdminBotTrip(
        state,
        conferenceKey,
        patch,
        paperTripDraftFrom(tripFor(state, conferenceKey)),
      );
      requestHostUpdate?.();
    },
    onSaveTrip: (conferenceKey) => {
      void saveAdminBotTrip(
        state,
        conferenceKey,
        state.adminBotTripDrafts[conferenceKey] ??
          paperTripDraftFrom(tripFor(state, conferenceKey)),
      ).finally(() => requestHostUpdate?.());
    },
    onWithdrawTrip: (conferenceKey) => {
      void withdrawAdminBotTrip(state, conferenceKey).finally(() => requestHostUpdate?.());
    },
    memberId: state.memberId ?? null,
    memberName: (memberId: string) =>
      (state.adminBotData?.members ?? []).find((member) => member.id === memberId)?.name ??
      memberId,
    onSaveDraft: (paperId, platform, body, xThread) => {
      void saveAdminBotSocialDraft(state, paperId, platform, body, xThread).finally(done);
    },
    onCirculateDraft: (paperId, draftId) => {
      void circulateAdminBotSocialDraft(state, paperId, draftId).finally(done);
    },
    onConsent: (paperId, draftId, decision, comment) => {
      void recordAdminBotSocialConsent(state, paperId, draftId, decision, comment).finally(done);
    },
    onSetAttendee: (paperId, name, memberId, attending) => {
      void setAdminBotPaperAttendee(state, paperId, name, memberId, attending).finally(() =>
        requestHostUpdate?.(),
      );
    },
    onSetReimbursement: (paperId, memberId, status) => {
      void setAdminBotPaperReimbursement(state, paperId, memberId, status).finally(() =>
        requestHostUpdate?.(),
      );
    },
    onSaveWeeklyUpdate: (paperId, body) => {
      void saveAdminBotPaperWeeklyUpdate(state, paperId, body).finally(() => requestHostUpdate?.());
    },
    // Offered on every project page. The service is the gate -- an admin may remove any paper, an
    // author only one they wrote -- so this does not try to guess which is which.
    onDeletePaper: (paper) => {
      void deleteAdminBotPaper(state, paper).finally(done);
    },
    channelCheck: state.myWorkChannelCheck,
    // Ticking loads the workspace's channel names; unticking drops them, so the next tick asks
    // again rather than judging an alias against a list from an hour ago.
    onChannelCheckToggle: (enabled) => {
      if (!enabled) {
        state.myWorkChannelCheck = { ...EMPTY_SLACK_CHANNEL_CHECK };
        requestHostUpdate?.();
        return;
      }
      void loadSlackChannelNames(state).finally(() => requestHostUpdate?.());
    },
  };
}

export function renderProjectsSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  if (state.tab !== "myWork" || scope.rosterPendingForTab) {
    return nothing;
  }
  return renderMyProjects(state as ProjectsNavState, paperWorkspaceProps(state, scope));
}

/**
 * The head professor's review of the paper a queue row or an Active Papers row opened. Resolved
 * from the id on every render: the papers list is re-read on every load, and the PI review queue
 * carries enough of a paper to review it before the lab list has arrived.
 */
export function renderPaperReviewSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  if (
    (state.tab !== "adminbotPapers" && state.tab !== "adminbotProfessor") ||
    !state.adminBotPaperCardId ||
    !isPiReviewViewer(state)
  ) {
    return nothing;
  }
  const selectedReview = state.adminBotPiReview?.find(
    (row) => row.paperId === state.adminBotPaperCardId,
  );
  const paper: ReviewPaper | undefined =
    scope.activePaperCard ??
    (selectedReview
      ? {
          id: selectedReview.paperId,
          title: selectedReview.title,
          authors: selectedReview.authors,
          artifacts: { google_drive_pdf_url: selectedReview.drivePdfUrl },
        }
      : undefined);
  if (!paper) {
    return nothing;
  }
  return renderPaperReviewDialog({
    paper,
    props: paperWorkspaceProps(state, scope),
    onClose: () => {
      state.adminBotPaperCardId = null;
      scope.requestHostUpdate?.();
    },
  });
}

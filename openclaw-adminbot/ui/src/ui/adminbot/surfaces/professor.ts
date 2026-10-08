// The PI's desk: the professor view and the wiring from its callbacks to the controllers.
//
// Cut from renderApp in app-render.ts so it stays under its file-size ratchet. See scope.ts for
// what every surface is handed.

import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { createLazyView, notifyLazyViewHost, renderLazyView } from "../../lazy-view.ts";
import { isHeadProfessorViewer } from "../access.ts";
import { loadStoredMemberSession } from "../auth/session.ts";
import { loadAdminBotPaperSlots, saveAdminBotPaperSlot } from "../controllers/paper-slots.ts";
import { loadAdminBotProfileOverview } from "../controllers/profile-overview.ts";
import { navigateToProject } from "../projects/model.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

// The page's view loads on first visit rather than in the first bundle.
const lazyProfessor = createLazyView(() => import("../views/professor.ts"), notifyLazyViewHost);
const lazyPiReview = createLazyView(
  () => import("../views/paper-pi-review.ts"),
  notifyLazyViewHost,
);

/**
 * The head professor's focused review of the paper she opened from the queue: feedback and
 * publication approval, not the authors' whole checklist. Resolved from the id on every render so
 * a reloaded papers list never leaves the dialog editing a stale record.
 */
function renderPiReviewDialog(state: AppViewState, requestHostUpdate?: () => void) {
  const paper = state.adminBotPaperCardId
    ? (state.adminBotData?.papers ?? []).find((entry) => entry.id === state.adminBotPaperCardId)
    : undefined;
  if (!paper) {
    return nothing;
  }
  return renderLazyView(lazyPiReview, (m) =>
    m.renderPaperPiReviewDialog({
      paper,
      props: {
        slots: state.adminBotPaperSlots,
        slotsBusyId: state.adminBotPaperSlotsBusyId,
        slotsError: state.adminBotPaperSlotsError,
        onLoadSlots: (paperId) => {
          void loadAdminBotPaperSlots(state, paperId).finally(() => requestHostUpdate?.());
        },
        onSaveSlot: (paperId, slot, input) => {
          void saveAdminBotPaperSlot(state, paperId, slot, input).finally(() =>
            requestHostUpdate?.(),
          );
        },
      },
      onClose: () => {
        state.adminBotPaperCardId = null;
        requestHostUpdate?.();
      },
    }),
  );
}

export function renderProfessorSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  const { adminBotMode, requestHostUpdate } = scope;
  if (state.tab !== "adminbotProfessor" || adminBotMode !== "admin") {
    return nothing;
  }
  const headProfessor = isHeadProfessorViewer({
    memberId: state.memberId,
    headProfessorMemberId: state.adminBotData?.settings?.head_professor_member_id,
  });
  return html`${renderLazyView(lazyProfessor, (m) =>
    m.renderProfessorView({
      localChatSessionToken: loadStoredMemberSession()?.sessionToken ?? "",
      requests: state.adminBotLogisticsRequests ?? [],
      requestsLoading: state.adminBotLogisticsRequestsLoading,
      papers: state.adminBotData?.papers ?? [],
      profiles: state.adminBotProfileOverview ?? [],
      escalated: state.adminBotEscalatedNudges ?? [],
      piReview: state.adminBotPiReview ?? [],
      piReviewLoading: state.adminBotProfileOverviewLoading,
      piReviewError: state.adminBotPiReviewError,
      onRetryPiReview: () => {
        void loadAdminBotProfileOverview(state).finally(() => requestHostUpdate?.());
      },
      onOpen: (tab) => state.setTab(tab),
      // The head professor reviews in place; any other admin goes to the project page.
      onOpenPaper: (paperId) => {
        if (!headProfessor) {
          navigateToProject(state, paperId);
          return;
        }
        state.adminBotPaperCardId = paperId;
        void loadAdminBotPaperSlots(state, paperId).finally(() => requestHostUpdate?.());
        requestHostUpdate?.();
      },
      expanded: state.professorExpandedLists,
      onToggleExpand: (id) => {
        const next = new Set(state.professorExpandedLists);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        state.professorExpandedLists = next;
        requestHostUpdate?.();
      },
      broadcast: state.adminBotBroadcast ?? null,
      broadcastDraft: state.adminBotBroadcastDraft,
      broadcastExpiry: state.adminBotBroadcastExpiry,
      broadcastAvailability: state.adminBotBroadcastAvailability,
      broadcastTimezone: state.adminBotBroadcastTimezone,
      broadcastBusy: state.adminBotBroadcastBusy,
      broadcastNotice: state.adminBotBroadcastNotice,
      onBroadcastDraftChange: (value) => {
        state.adminBotBroadcastDraft = value;
        requestHostUpdate?.();
      },
      onBroadcastExpiryChange: (value) => {
        state.adminBotBroadcastExpiry = value;
        requestHostUpdate?.();
      },
      onBroadcastAvailabilityChange: (value) => {
        state.adminBotBroadcastAvailability = value;
        requestHostUpdate?.();
      },
      onBroadcastTimezoneChange: (value) => {
        state.adminBotBroadcastTimezone = value;
        requestHostUpdate?.();
      },
      onBroadcastPublish: (draft) => {
        void state.publishBroadcast?.(draft).finally(() => requestHostUpdate?.());
      },
    }),
  )}${headProfessor ? renderPiReviewDialog(state, requestHostUpdate) : nothing}`;
}

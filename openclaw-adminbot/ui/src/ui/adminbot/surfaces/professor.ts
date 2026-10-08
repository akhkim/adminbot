// The PI's desk: the professor view and the wiring from its callbacks to the controllers.
//
// Cut from renderApp in app-render.ts so it stays under its file-size ratchet. See scope.ts for
// what every surface is handed.

import { nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { createLazyView, notifyLazyViewHost, renderLazyView } from "../../lazy-view.ts";
import { loadStoredMemberSession } from "../auth/session.ts";
import { loadAdminBotPaperSlots } from "../controllers/paper-slots.ts";
import { loadAdminBotProfileOverview } from "../controllers/profile-overview.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

// The page's view loads on first visit rather than in the first bundle.
const lazyProfessor = createLazyView(() => import("../views/professor.ts"), notifyLazyViewHost);

export function renderProfessorSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  const { adminBotMode, requestHostUpdate } = scope;
  return state.tab === "adminbotProfessor" && adminBotMode === "admin"
    ? renderLazyView(lazyProfessor, (m) =>
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
          onOpenPaper: (paperId) => {
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
      )
    : nothing;
}

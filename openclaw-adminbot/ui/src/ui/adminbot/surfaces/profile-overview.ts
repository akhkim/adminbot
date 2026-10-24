// The Lab Overview: the view and the wiring from its callbacks to the controllers.
//
// Cut from renderApp in app-render.ts so it stays under its file-size ratchet. See scope.ts for
// what every surface is handed.

import { nothing } from "lit";
import { profileOverviewFilterParams } from "../../../../../extensions/adminbot/src/workflows/members/profile-overview-filter.js";
import type { AppViewState } from "../../app-view-state.ts";
import { rereadProfileOverview } from "../controllers/profile-overview-paging.ts";
import {
  loadMoreAdminBotProfileOverview,
  remindAdminBotIncompleteProfiles,
  seedAdminBotNudgeList,
} from "../controllers/profile-overview.ts";
import { remainingRows } from "../load-more.ts";
import { renderAdminBotProfileOverview } from "../views/profile-overview.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

export function renderProfileOverviewSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  const { requestHostUpdate } = scope;
  if (state.tab !== "adminbotProfileOverview") {
    return nothing;
  }
  const page = state.adminBotProfileOverviewPage;
  const listed = page.view === "list";
  return renderAdminBotProfileOverview({
    members: listed ? state.adminBotProfileOverview : [],
    mandatoryFieldCount: state.adminBotProfileOverviewFieldCount,
    adoption: state.adminBotProfileAdoption ?? null,
    loading: state.adminBotProfileOverviewLoading,
    error: state.adminBotProfileOverviewError,
    notice: state.adminBotProfileOverviewNotice,
    reminding: state.adminBotProfileOverviewReminding,
    filter: state.adminBotProfileOverviewFilter,
    remindCount: listed && page.remindCount !== null ? page.remindCount : undefined,
    more: {
      remaining: listed
        ? remainingRows(page.total, state.adminBotProfileOverview.length, page.nextCursor)
        : 0,
      loading: page.loadingMore,
      onLoadMore: () => {
        void loadMoreAdminBotProfileOverview(state).finally(() => requestHostUpdate?.());
        requestHostUpdate?.();
      },
    },
    onFilterChange: (filter) => {
      const typed = filter.search !== state.adminBotProfileOverviewFilter.search;
      state.adminBotProfileOverviewFilter = filter;
      rereadProfileOverview(state, requestHostUpdate, { debounce: typed });
      requestHostUpdate?.();
    },
    onRemind: (remindScope) => {
      void remindAdminBotIncompleteProfiles(
        state,
        remindScope,
        profileOverviewFilterParams(state.adminBotProfileOverviewFilter),
      ).finally(() => requestHostUpdate?.());
    },
    onSeedNudgeList: () => {
      void seedAdminBotNudgeList(state).finally(() => requestHostUpdate?.());
    },
    // The follow-up to a thin row is a look at the person, which is Lab Members' job.
    onOpenMember: (memberId: string) => {
      state.selectedMemberId = memberId;
      state.setTab("adminbotMembers");
    },
  });
}

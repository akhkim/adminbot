// Dashboard: where the signed-in member stands, and what is waiting on them.
//
// Cut from renderApp in app-render.ts: the tab's view and the wiring from its callbacks to the
// controllers. See scope.ts for what every surface is handed.

import { nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { loadAdminBot } from "../controllers/admin.ts";
import { renderDashboard } from "../views/dashboard.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

export function renderDashboardSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  const { accessRole, adminBotMode, needsPapersForTab } = scope;
  return state.tab === "dashboard"
    ? renderDashboard(
        state,
        accessRole,
        () => void loadAdminBot(state, adminBotMode, needsPapersForTab),
      )
    : nothing;
}

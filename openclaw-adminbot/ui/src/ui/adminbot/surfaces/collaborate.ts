// Collaborate: the lab-sharing directory.
//
// Cut from renderApp in app-render.ts: the tab's view and the wiring from its callbacks to the
// controllers. See scope.ts for what every surface is handed.

import { nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { renderLabSharing } from "../views/lab-sharing.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

export function renderCollaborateSurface(state: AppViewState, _scope: AdminBotSurfaceScope) {
  return state.tab === "labSharing" ? renderLabSharing(state) : nothing;
}

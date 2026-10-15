// Collaborate: the lab-sharing directory.
//
// Cut from renderApp in app-render.ts: the tab's view and the wiring from its callbacks to the
// controllers. See scope.ts for what every surface is handed.

import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { renderLabSharing } from "../views/lab-sharing.ts";
import { renderNearbyNowSurface } from "./events.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

export function renderCollaborateSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  return state.tab === "labSharing"
    ? html`${renderNearbyNowSurface(state, scope)}${renderLabSharing(state)}`
    : nothing;
}

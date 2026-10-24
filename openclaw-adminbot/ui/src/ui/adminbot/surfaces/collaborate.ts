// Collaborate: the lab-sharing directory.
//
// Cut from renderApp in app-render.ts: the tab's view and the wiring from its callbacks to the
// controllers. See scope.ts for what every surface is handed.

import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { createLazyView, notifyLazyViewHost, renderLazyView } from "../../lazy-view.ts";
import { renderNearbyNowSurface } from "./events.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

// The page's view loads on first visit rather than in the first bundle.
const lazyLabSharing = createLazyView(() => import("../views/lab-sharing.ts"), notifyLazyViewHost);

export function renderCollaborateSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  return state.tab === "labSharing"
    ? html`${renderNearbyNowSurface(state, scope)}${renderLazyView(lazyLabSharing, (m) =>
        m.renderLabSharing(state),
      )}`
    : nothing;
}

// The /travel half of Events: the "Find lab members nearby" card and opt-in location sharing.
//
// The card's view and the wiring from its callbacks to controllers/lab-travel.ts. Every action
// re-renders when it settles. See scope.ts for what every surface is handed. It used to be the
// Travel tab's surface; Events took that tab over and draws this card itself.

import type { AppViewState } from "../../app-view-state.ts";
import {
  disableSharing,
  enableSharing,
  loadLabTravel,
  lookup,
  needsLabTravelLoad,
  shareFromThisDevice,
  shareTypedCity,
  syncLocationTracking,
} from "../controllers/lab-travel.ts";
import { renderTravelNearby } from "../views/lab-travel.nearby.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

/**
 * Runs on every render, whichever tab is showing.
 *
 * Keeps an opted-in member's shared location current on every tab, not only Events: "who is near
 * me" is answered for whoever opens AdminBot in a new city, wherever they land. Cheap when nothing
 * changed; it reads the opt-in once per session and stops on sign-out. Opening Events loads it.
 */
export function syncLabTravel(state: AppViewState, requestHostUpdate: (() => void) | undefined) {
  syncLocationTracking(state, () => requestHostUpdate?.());
  if (state.tab === "events" && needsLabTravelLoad(state)) {
    void loadLabTravel(state).finally(() => requestHostUpdate?.());
  }
}

/** The nearby card, for Events to place under its own lists. */
export function renderTravelNearbySurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  const update = () => scope.requestHostUpdate?.();
  const settle = (work: Promise<unknown>) => {
    update();
    void work.finally(update);
  };
  return renderTravelNearby({
    overview: state.labTravel ?? null,
    loading: Boolean(state.labTravelLoading),
    error: state.labTravelError ?? null,
    notice: state.labTravelNotice ?? null,
    busy: state.labTravelBusy ?? null,
    onRetry: () => {
      state.labTravelError = null;
      settle(loadLabTravel(state));
    },
    sharing: state.labTravelSharing ?? null,
    device: state.labTravelDevice ?? { status: "idle" },
    onEnableSharing: () => settle(enableSharing(state, update)),
    onDisableSharing: () => settle(disableSharing(state)),
    onShareFromDevice: () => {
      shareFromThisDevice(state, update);
      update();
    },
    cityDraft: state.labTravelCityDraft ?? "",
    onCityDraftChange: (value) => {
      state.labTravelCityDraft = value;
      update();
    },
    onShareCity: () => settle(shareTypedCity(state)),
    lookupDraft: state.labTravelLookupDraft ?? { place: "", from: "", to: "" },
    onLookupDraftChange: (draft) => {
      state.labTravelLookupDraft = draft;
      update();
    },
    onLookup: () => settle(lookup(state)),
    lookup: state.labTravelLookup ?? null,
    lookupError: state.labTravelLookupError ?? null,
  });
}

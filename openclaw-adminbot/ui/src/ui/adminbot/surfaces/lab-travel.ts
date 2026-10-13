// Travel: conference RSVPs per site, the member's other travel plans, and opt-in location sharing.
//
// The tab's view and the wiring from its callbacks to controllers/lab-travel.ts. Every action
// re-renders when it settles. See scope.ts for what every surface is handed.

import { nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import {
  disableSharing,
  editRsvpDraft,
  enableSharing,
  loadLabTravel,
  lookup,
  needsLabTravelLoad,
  openRsvp,
  savePlans,
  saveRsvp,
  shareFromThisDevice,
  shareTypedCity,
  syncLocationTracking,
  withdrawRsvp,
} from "../controllers/lab-travel.ts";
import { EMPTY_TRIP_DRAFT } from "../views/lab-travel.plans.ts";
import { renderLabTravel } from "../views/lab-travel.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

/**
 * Runs on every render, whichever tab is showing.
 *
 * Keeps an opted-in member's shared location current on every tab, not only Travel: "who is near
 * me" is answered for whoever opens AdminBot in a new city, wherever they land. Cheap when nothing
 * changed; it reads the opt-in once per session and stops on sign-out. Opening the tab loads it.
 */
export function syncLabTravel(state: AppViewState, requestHostUpdate: (() => void) | undefined) {
  syncLocationTracking(state, () => requestHostUpdate?.());
  if (state.tab === "labTravel" && needsLabTravelLoad(state)) {
    void loadLabTravel(state).finally(() => requestHostUpdate?.());
  }
}

export function renderLabTravelSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  if (state.tab !== "labTravel") {
    return nothing;
  }
  const update = () => scope.requestHostUpdate?.();
  const settle = (work: Promise<unknown>) => {
    update();
    void work.finally(update);
  };
  return renderLabTravel(
    {
      overview: state.labTravel ?? null,
      loading: Boolean(state.labTravelLoading),
      error: state.labTravelError ?? null,
      notice: state.labTravelNotice ?? null,
      busy: state.labTravelBusy ?? null,
      onRetry: () => {
        state.labTravelError = null;
        settle(loadLabTravel(state));
      },
      rsvpOpen: state.labTravelRsvpOpen ?? null,
      rsvpDrafts: state.labTravelRsvpDrafts ?? {},
      onOpenRsvp: (key) => {
        openRsvp(state, key);
        update();
      },
      onEditRsvp: (site, patch) => {
        editRsvpDraft(state, site, patch);
        update();
      },
      onSaveRsvp: (site) => settle(saveRsvp(state, site)),
      onWithdrawRsvp: (site) => settle(withdrawRsvp(state, site)),
      planDraft: state.labTravelPlanDraft ?? EMPTY_TRIP_DRAFT,
      onPlanDraftChange: (draft) => {
        state.labTravelPlanDraft = draft;
        update();
      },
      onSavePlans: (trips) => settle(savePlans(state, trips)),
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
    },
    state.memberId ?? null,
  );
}

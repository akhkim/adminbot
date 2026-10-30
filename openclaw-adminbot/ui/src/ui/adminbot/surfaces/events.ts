// Events: upcoming lab-relevant events, who is going, who is nearby, and the meetup-intro opt-ins.
//
// The tab's view and the wiring from its callbacks to controllers/events.ts. Every action
// re-renders when it settles. See scope.ts for what every surface is handed.
import { nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import {
  loadEvents,
  needsEventsLoad,
  sayHi,
  toggleGoing,
  updateMeetupPreferences,
} from "../controllers/events.ts";
import { renderEvents, renderMeetupToggle } from "../views/events.ts";
import { renderTravelNearbySurface } from "./lab-travel.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

/** Tabs that draw part of the overview: Events itself and the profile's meetup toggle. */
const EVENTS_TABS = new Set(["events", "profile"]);

/** Opening one of those tabs loads it; self-limiting because the read marks itself loading at once. */
export function syncEvents(state: AppViewState, requestHostUpdate: (() => void) | undefined) {
  if (EVENTS_TABS.has(state.tab) && needsEventsLoad(state)) {
    void loadEvents(state).finally(() => requestHostUpdate?.());
  }
}

export function renderEventsSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  if (state.tab !== "events") {
    return nothing;
  }
  const update = () => scope.requestHostUpdate?.();
  const settle = (work: Promise<unknown>) => {
    update();
    void work.finally(update);
  };
  return renderEvents({
    overview: state.events ?? null,
    loading: Boolean(state.eventsLoading),
    error: state.eventsError ?? null,
    notice: state.eventsNotice ?? null,
    busy: state.eventsBusy ?? null,
    onRetry: () => {
      state.eventsError = null;
      settle(loadEvents(state));
    },
    onToggleGoing: (card, going) => settle(toggleGoing(state, card, going)),
    onPreferences: (patch) => settle(updateMeetupPreferences(state, patch)),
    onSayHi: (target) => settle(sayHi(state, target)),
    nearby: renderTravelNearbySurface(state, scope),
  });
}

function settler(scope: AdminBotSurfaceScope) {
  const update = () => scope.requestHostUpdate?.();
  return (work: Promise<unknown>) => {
    update();
    void work.finally(update);
  };
}

/** The profile's one-tap meetup switch, once the overview has loaded. */
export function renderMeetupToggleSurface(state: AppViewState, scope: AdminBotSurfaceScope) {
  if (!state.events) {
    return nothing;
  }
  const settle = settler(scope);
  return renderMeetupToggle({
    preferences: state.events.preferences,
    busy: state.eventsBusy === "prefs",
    onToggle: (on) => settle(updateMeetupPreferences(state, { events: on, city: on })),
    onManage: () => state.setTab("events"),
  });
}

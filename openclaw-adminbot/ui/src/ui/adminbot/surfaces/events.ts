// Events: upcoming lab-relevant events, who is going, who is nearby, and the meetup-intro opt-ins.
//
// The tab's view and the wiring from its callbacks to controllers/events.ts. Every action
// re-renders when it settles. See scope.ts for what every surface is handed.
import { nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import {
  loadEvents,
  needsEventsLoad,
  toggleGoing,
  updateMeetupPreferences,
} from "../controllers/events.ts";
import { renderEvents } from "../views/events.ts";
import type { AdminBotSurfaceScope } from "./scope.ts";

/** Opening the tab loads it; self-limiting because the read marks itself loading at once. */
export function syncEvents(state: AppViewState, requestHostUpdate: (() => void) | undefined) {
  if (state.tab === "events" && needsEventsLoad(state)) {
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
  });
}

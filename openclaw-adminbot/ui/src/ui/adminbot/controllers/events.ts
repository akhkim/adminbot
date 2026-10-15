// The Events tab's reads and writes.
//
// Every write re-reads the overview rather than patching it, as on Travel: one Going tap changes
// the card's avatars, its "you're going" state and possibly the in-town prompt at once.
import type { UiSettings } from "../../storage.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import {
  fetchEventsOverview,
  saveMeetupPreferences,
  setEventGoing,
  type EventCard,
  type EventsOverview,
} from "../data/events.ts";
import { isTravelViewer } from "./lab-travel.ts";

export type EventsNotice = { kind: "success" | "error"; text: string };

export type EventsHost = {
  settings: UiSettings;
  memberPrivilegeLevel?: string | null;
  events?: EventsOverview;
  /** The session token the overview was read with, so a different member never sees it. */
  eventsLoadedFor?: string | null;
  eventsLoading?: boolean;
  eventsError?: string | null;
  eventsNotice?: EventsNotice | null;
  /** What is in flight: "prefs" or "rsvp:<key>". */
  eventsBusy?: string | null;
};

export type EventsState = Omit<EventsHost, "settings" | "memberPrivilegeLevel">;

function sessionToken(): string | null {
  return loadStoredMemberSession()?.sessionToken ?? null;
}

export async function loadEvents(host: EventsHost): Promise<void> {
  const token = sessionToken();
  if (!token) {
    return;
  }
  host.eventsLoading = true;
  try {
    const result = await fetchEventsOverview(resolveAdminBotBaseUrl(host.settings));
    if (sessionToken() !== token) {
      return; // signed out or switched member while this was in flight
    }
    if (!result.ok) {
      host.eventsError = result.error;
      return;
    }
    host.events = result.value;
    host.eventsLoadedFor = token;
    host.eventsError = null;
  } finally {
    host.eventsLoading = false;
  }
}

/** Whether the tab has to read before it can draw. Same audience as Travel. */
export function needsEventsLoad(host: EventsHost): boolean {
  const token = sessionToken();
  return Boolean(
    token &&
    isTravelViewer(host.memberPrivilegeLevel) &&
    !host.eventsLoading &&
    !host.eventsError &&
    (!host.events || host.eventsLoadedFor !== token),
  );
}

async function act(
  host: EventsHost,
  busy: string,
  run: (baseUrl: string) => Promise<{ ok: true } | { ok: false; error: string }>,
): Promise<void> {
  host.eventsBusy = busy;
  host.eventsNotice = null;
  try {
    const result = await run(resolveAdminBotBaseUrl(host.settings));
    if (!result.ok) {
      host.eventsNotice = { kind: "error", text: result.error };
      return;
    }
    await loadEvents(host);
  } finally {
    host.eventsBusy = null;
  }
}

export function toggleGoing(host: EventsHost, card: EventCard, going: boolean) {
  return act(host, `rsvp:${card.key}`, (baseUrl) => setEventGoing(baseUrl, card, going));
}

export function updateMeetupPreferences(
  host: EventsHost,
  patch: Partial<{ events: boolean; city: boolean; snoozed_until: string | null }>,
) {
  return act(host, "prefs", (baseUrl) => saveMeetupPreferences(baseUrl, patch));
}

/** Forget everything this tab holds. Signing out, or becoming somebody else. */
export function clearEvents(host: EventsState): void {
  host.events = undefined;
  host.eventsLoadedFor = null;
  host.eventsLoading = false;
  host.eventsError = null;
  host.eventsNotice = null;
  host.eventsBusy = null;
}

// Conference Overview's side of the wire: read the board, and write the viewer's own trip.
//
// Two calls, and the read is deliberately not gated on being signed in. The page is public in the
// same way the deadline board is, so a signed-out visitor gets the cards; the service decides what
// else rides along with them. The write needs a session and there is no anonymous fallback for it,
// because there is nobody to record the answer against.

import type { UiSettings } from "../../storage.ts";
import {
  fetchConferenceOverview,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  saveConferenceTrip,
  type ConferenceSummary,
  type ConferenceTrip,
} from "../auth/session.ts";
import type { ConferenceTripDraft } from "../views/conferences.ts";

export type AdminBotConferencesState = {
  conferences: ConferenceSummary[];
  /** The viewer's own trips, keyed by conference so the form can find its own row. */
  mine: Record<string, ConferenceTrip>;
  /** In-progress edits, keyed the same way. Cleared per conference once its save lands. */
  drafts: Record<string, ConferenceTripDraft>;
  loading: boolean;
  loadedAt: number | null;
  savingKey: string | null;
  error: string | null;
  notice: string | null;
};

export function createEmptyConferencesState(): AdminBotConferencesState {
  return {
    conferences: [],
    mine: {},
    drafts: {},
    loading: false,
    loadedAt: null,
    savingKey: null,
    error: null,
    notice: null,
  };
}

export type AdminBotConferencesHost = {
  settings: UiSettings;
  adminBotConferences: AdminBotConferencesState;
};

function failureText(kind: string, baseUrl: string): string {
  if (kind === "unreachable") {
    return `Couldn't reach AdminBot at ${baseUrl}.`;
  }
  if (kind === "forbidden") {
    return "Your session no longer allows this — sign in again and retry.";
  }
  return "Couldn't load the conference board. Try again in a moment.";
}

export async function loadAdminBotConferences(host: AdminBotConferencesHost): Promise<void> {
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  // Null is a legitimate token here: the board reads publicly.
  const token = loadStoredMemberSession()?.sessionToken ?? null;
  host.adminBotConferences = { ...host.adminBotConferences, loading: true, error: null };
  const result = await fetchConferenceOverview(token, baseUrl);
  if (!result.ok) {
    host.adminBotConferences = {
      ...host.adminBotConferences,
      loading: false,
      error: failureText(result.kind, baseUrl),
    };
    return;
  }
  host.adminBotConferences = {
    ...host.adminBotConferences,
    conferences: result.value.conferences,
    mine: Object.fromEntries(result.value.mine.map((trip) => [trip.conference_key, trip])),
    loading: false,
    loadedAt: Date.now(),
    error: null,
  };
}

/** Hold one field of one conference's form. Nothing is sent until Save. */
export function editAdminBotConferenceTrip(
  host: AdminBotConferencesHost,
  conferenceKey: string,
  patch: Partial<ConferenceTripDraft>,
  base: ConferenceTripDraft,
): void {
  const current = host.adminBotConferences.drafts[conferenceKey] ?? base;
  host.adminBotConferences = {
    ...host.adminBotConferences,
    drafts: { ...host.adminBotConferences.drafts, [conferenceKey]: { ...current, ...patch } },
    // A new edit clears the last save's confirmation: leaving "recorded" on screen while somebody
    // types something else says the new answer is stored when it is not.
    notice: null,
  };
}

export async function saveAdminBotConferenceTrip(
  host: AdminBotConferencesHost,
  conferenceKey: string,
  draft: ConferenceTripDraft,
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotConferences = {
      ...host.adminBotConferences,
      error: "Sign in to record whether you are going.",
    };
    return;
  }
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  host.adminBotConferences = {
    ...host.adminBotConferences,
    savingKey: conferenceKey,
    error: null,
    notice: null,
  };
  const result = await saveConferenceTrip(
    conferenceKey,
    {
      intent: draft.intent,
      funding: draft.funding,
      needs_lodging: draft.needs_lodging,
      needs_visa_letter: draft.needs_visa_letter,
      // Empty strings are "not answered", and the service treats a blank as absent -- sending
      // them anyway would store "" where the column means "no date given".
      ...(draft.arrival_on ? { arrival_on: draft.arrival_on } : {}),
      ...(draft.departure_on ? { departure_on: draft.departure_on } : {}),
      ...(draft.paper_id ? { paper_id: draft.paper_id } : {}),
      ...(draft.notes.trim() ? { notes: draft.notes } : {}),
    },
    stored.sessionToken,
    baseUrl,
  );
  if (!result.ok) {
    host.adminBotConferences = {
      ...host.adminBotConferences,
      savingKey: null,
      error: failureText(result.kind, baseUrl),
    };
    return;
  }
  const drafts = { ...host.adminBotConferences.drafts };
  // Dropped rather than kept in step with the response: the stored row is now the answer, and two
  // copies of it is how a form starts disagreeing with what the server holds.
  delete drafts[conferenceKey];
  host.adminBotConferences = {
    ...host.adminBotConferences,
    mine: { ...host.adminBotConferences.mine, [conferenceKey]: result.value },
    drafts,
    savingKey: null,
    notice: "Saved. The lab books against what is here.",
  };
  // The admin roster on the card is computed by the service, so a fresh read is the only way to
  // see one's own answer reflected in the headcounts.
  await loadAdminBotConferences(host);
}

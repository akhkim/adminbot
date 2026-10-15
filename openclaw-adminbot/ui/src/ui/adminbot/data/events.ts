// What the Events tab reads and writes (extensions/adminbot/src/api/routes/events.ts).
//
// Like data/lab-travel.ts, and for the same reason, nothing here goes through the offline GET
// cache: the overview names who is going where and the viewer's own sign-in city, and neither
// should outlive the session in browser storage. Going / Not going is the Travel tab's own RSVP
// route, so the two tabs can never disagree about an answer.
//
// Every function answers rather than throws.
import type {
  AdminBotEventCard,
  AdminBotEventsOverview,
  AdminBotMeetupPreferences,
  AdminBotSayHiResult,
} from "../../../../../extensions/adminbot/src/contracts/events.js";
import { loadStoredMemberSession } from "../auth/session.ts";
import { saveTravelRsvp, withdrawTravelRsvp, type TravelResult } from "./lab-travel.ts";

export type {
  AdminBotEventCard as EventCard,
  AdminBotEventPerson as EventPerson,
  AdminBotEventsOverview as EventsOverview,
  AdminBotMeetupPreferences as MeetupPreferences,
  AdminBotSayHiResult as SayHiResult,
} from "../../../../../extensions/adminbot/src/contracts/events.js";

async function call<T>(
  baseUrl: string,
  path: string,
  init: { method?: "GET" | "PUT" | "POST"; body?: unknown } = {},
): Promise<TravelResult<T>> {
  const session = loadStoredMemberSession();
  if (!session) {
    return { ok: false, status: 401, error: "Sign in to see Events." };
  }
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/u, "")}${path}`, {
      method: init.method ?? "GET",
      credentials: "omit",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${session.sessionToken}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = (data.error as { message?: string } | undefined)?.message;
      return {
        ok: false,
        status: response.status,
        error:
          response.status === 404 && !message
            ? "This AdminBot service does not have the Events tab yet."
            : (message ?? `The service answered ${response.status}.`),
      };
    }
    return { ok: true, value: data as T };
  } catch {
    return {
      ok: false,
      status: 0,
      error: "Could not reach AdminBot. Check your connection and try again.",
    };
  }
}

export function fetchEventsOverview(baseUrl: string) {
  return call<AdminBotEventsOverview>(baseUrl, "/events");
}

export async function saveMeetupPreferences(
  baseUrl: string,
  patch: Partial<{ events: boolean; city: boolean; snoozed_until: string | null }>,
) {
  const result = await call<{ preferences: AdminBotMeetupPreferences }>(
    baseUrl,
    "/events/preferences",
    { method: "PUT", body: patch },
  );
  return result.ok ? { ok: true as const, value: result.value.preferences } : result;
}

/**
 * The one-tap toggle. Going keeps whatever the member already told Travel (funding, Airbnb, visa
 * letter, nights, notes) so a tap here never wipes a detailed answer; Not going withdraws it.
 */
export function setEventGoing(baseUrl: string, card: AdminBotEventCard, going: boolean) {
  if (!going) {
    return withdrawTravelRsvp(baseUrl, card.key);
  }
  const mine = card.my_rsvp;
  return saveTravelRsvp(baseUrl, card.key, {
    intent: "going",
    funding: mine?.funding ?? "none",
    needs_lodging: mine?.needs_lodging ?? false,
    needs_visa_letter: mine?.needs_visa_letter ?? false,
    ...(mine?.arrival_on ? { arrival_on: mine.arrival_on } : {}),
    ...(mine?.departure_on ? { departure_on: mine.departure_on } : {}),
    ...(mine?.notes ? { notes: mine.notes } : {}),
  });
}

/** An event card (`event_key`) or one Nearby now face (`member_id`). */
export type SayHiTarget = { event_key: string } | { member_id: string };

/** Say hi: AdminBot opens a Slack group DM now. A second tap answers already_said_hi. */
export function sayHiTo(baseUrl: string, target: SayHiTarget) {
  return call<AdminBotSayHiResult>(baseUrl, "/events/say-hi", { method: "POST", body: target });
}

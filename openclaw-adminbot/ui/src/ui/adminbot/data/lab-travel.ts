// What the Travel tab reads and writes (extensions/adminbot/src/api/server.travel.ts).
//
// Deliberately not through `authedJson` in auth/session.ts. That helper caches every successful
// GET in IndexedDB so pages keep working offline, which is the wrong thing for this tab: what it
// reads is where other people are, and a copy of that left in browser storage would outlive the
// moment they switch sharing off. Every call here goes to the service or fails.
//
// Every function answers rather than throws, like data/lab-sharing.ts.
import type {
  AdminBotConferenceFundingNeed,
  AdminBotConferenceTripIntent,
  AdminBotConferenceTripRecord,
} from "../../../../../extensions/adminbot/src/contracts/conference-trips.js";
import type {
  AdminBotTravelMatch,
  AdminBotTravelOverview,
  AdminBotTravelPlace,
  AdminBotTravelSharing,
} from "../../../../../extensions/adminbot/src/contracts/lab-travel.js";
import { loadStoredMemberSession } from "../auth/session.ts";

export type {
  AdminBotTravelAttendee as TravelAttendee,
  AdminBotTravelConference as TravelConference,
  AdminBotTravelMatch as TravelMatch,
  AdminBotTravelMatchGroup as TravelMatchGroup,
  AdminBotTravelOverview as TravelOverview,
  AdminBotTravelPlan as TravelPlan,
  AdminBotTravelSharing as TravelSharing,
} from "../../../../../extensions/adminbot/src/contracts/lab-travel.js";
import { memberAuthHeaders } from "../api/device-clock.ts";

export type TravelRsvp = AdminBotConferenceTripRecord;
export type TravelRsvpIntent = AdminBotConferenceTripIntent;
export type TravelFunding = AdminBotConferenceFundingNeed;

export type TravelLookup = {
  place: AdminBotTravelPlace;
  resolved: boolean;
  from: string;
  to: string;
  people: AdminBotTravelMatch[];
};

export type TravelResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

async function call<T>(
  baseUrl: string,
  path: string,
  init: { method?: "GET" | "PUT" | "POST" | "DELETE"; body?: unknown } = {},
): Promise<TravelResult<T>> {
  const session = loadStoredMemberSession();
  if (!session) {
    return { ok: false, status: 401, error: "Sign in to use Travel." };
  }
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/u, "")}${path}`, {
      method: init.method ?? "GET",
      credentials: "omit",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...memberAuthHeaders(session.sessionToken),
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
            ? "This AdminBot service does not have the Travel tab yet."
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

export function fetchTravelOverview(baseUrl: string) {
  return call<AdminBotTravelOverview>(baseUrl, "/travel");
}

export async function fetchTravelSharing(baseUrl: string) {
  const result = await call<{ sharing: AdminBotTravelSharing }>(baseUrl, "/travel/sharing");
  return result.ok ? { ok: true as const, value: result.value.sharing } : result;
}

export async function setTravelSharing(baseUrl: string, enabled: boolean) {
  const result = await call<{ sharing: AdminBotTravelSharing }>(baseUrl, "/travel/sharing", {
    method: "PUT",
    body: { enabled },
  });
  return result.ok ? { ok: true as const, value: result.value.sharing } : result;
}

/** A measured browser fix, or a typed city when the browser cannot give one. */
export async function reportTravelLocation(
  baseUrl: string,
  fix: { lat: number; lon: number; accuracy_m?: number } | { place: string },
) {
  const result = await call<{ sharing: AdminBotTravelSharing }>(baseUrl, "/travel/location", {
    method: "POST",
    body: fix,
  });
  return result.ok ? { ok: true as const, value: result.value.sharing } : result;
}

export function lookupTravellers(
  baseUrl: string,
  query: { place: string; from?: string; to?: string },
) {
  const params = new URLSearchParams({ place: query.place.trim() });
  if (query.from) {
    params.set("from", query.from);
  }
  if (query.to) {
    params.set("to", query.to);
  }
  return call<TravelLookup>(baseUrl, `/travel/whos-in?${params.toString()}`);
}

export type TravelRsvpInput = {
  intent: TravelRsvpIntent;
  funding: TravelFunding;
  needs_lodging: boolean;
  needs_visa_letter: boolean;
  arrival_on?: string;
  departure_on?: string;
  notes?: string;
};

export async function saveTravelRsvp(
  baseUrl: string,
  conferenceKey: string,
  input: TravelRsvpInput,
) {
  const result = await call<{ trip: TravelRsvp }>(
    baseUrl,
    `/travel/conferences/${encodeURIComponent(conferenceKey)}/rsvp`,
    { method: "PUT", body: input },
  );
  return result.ok ? { ok: true as const, value: result.value.trip } : result;
}

export function withdrawTravelRsvp(baseUrl: string, conferenceKey: string) {
  return call<{ withdrawn: boolean }>(
    baseUrl,
    `/travel/conferences/${encodeURIComponent(conferenceKey)}/rsvp`,
    { method: "DELETE" },
  );
}

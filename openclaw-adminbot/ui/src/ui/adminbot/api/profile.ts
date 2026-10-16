// AdminBot client: The signed-in member's own record: onboarding acks, profile photo, location prompts.
//
// Mirrors the service's api/routes/profile.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import {
  authedJson,
  type AuthResult,
  calendarFailure,
  mapErrorResponse,
  type MemberOnboarding,
  type ProfilePhotoAssessment,
  type ProfilePhotoPolishVariant,
} from "../auth/session.ts";

export type ProfilePhotoPolishResult = {
  variant: ProfilePhotoPolishVariant;
  variants: ProfilePhotoPolishVariant[];
  assessment?: ProfilePhotoAssessment;
};

// Records that the member has read one onboarding step (POST /onboarding/ack) and returns the
// rebuilt checklist, so the welcome screen re-renders from the server's view rather than guessing
// what the acknowledgement did to `current_step`.
export async function acknowledgeOnboardingStep(
  stepId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MemberOnboarding>> {
  const result = await authedJson(baseUrl, "/onboarding/ack", "POST", sessionToken, {
    step_id: stepId,
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const onboarding = (result.body as { onboarding?: MemberOnboarding } | null)?.onboarding;
  if (!onboarding) {
    return { ok: false, kind: "auth-failed" };
  }
  return { ok: true, value: onboarding };
}

export async function polishOwnProfilePhoto(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<ProfilePhotoPolishResult>> {
  const result = await authedJson(baseUrl, "/profile-photo/polish", "POST", sessionToken, {});
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as ProfilePhotoPolishResult };
}

export async function applyOwnPolishedProfilePhoto(
  variantId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ variant_id: string; action_id: string }>> {
  const result = await authedJson(baseUrl, "/profile-photo/apply", "POST", sessionToken, {
    variant_id: variantId,
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as { variant_id: string; action_id: string } };
}

// ---------------------------------------------------------------------------
// "You seem to have moved"
//
// The inferred half of a member's location never writes to their profile — see the service. These
// two calls are the whole path by which an inference can become a fact: the member is shown what
// was observed, and their answer goes through the ordinary self-edit.
// ---------------------------------------------------------------------------

export type LocationDrift = {
  member_id: string;
  observed_country: string;
  observed_label?: string;
  profile_location?: string;
  profile_country?: string;
  since: string;
  observation_count: number;
};

/**
 * "Where are you based right now?" -- whether to ask, and the one-tap guess. Mirrors
 * AdminBotLocationCheckin in extensions/adminbot/src/contracts/actions.ts.
 */
export type LocationCheckin = {
  due: boolean;
  reason:
    | "no_guess"
    | "timezone_mismatch"
    | "signals_agree"
    | "answered"
    | "snoozed"
    | "declined"
    | "hidden";
  suggestion?: { city: string; source: "login" | "slack_tz" | "stored" };
  last_answered_at?: string;
  last_answered_city?: string;
  snoozed_until?: string;
  note?: string;
};

export type LocationPromptState = { drift: LocationDrift | null; checkin: LocationCheckin | null };

function toCheckin(raw: unknown): LocationCheckin | null {
  const record = raw as Partial<LocationCheckin> | null | undefined;
  if (!record || typeof record.due !== "boolean" || typeof record.reason !== "string") {
    return null;
  }
  const city = typeof record.suggestion?.city === "string" ? record.suggestion.city.trim() : "";
  return {
    due: record.due,
    reason: record.reason,
    ...(city && record.suggestion
      ? { suggestion: { city, source: record.suggestion.source } }
      : {}),
    ...(typeof record.last_answered_at === "string"
      ? { last_answered_at: record.last_answered_at }
      : {}),
    ...(typeof record.last_answered_city === "string"
      ? { last_answered_city: record.last_answered_city }
      : {}),
    ...(typeof record.snoozed_until === "string" ? { snoozed_until: record.snoozed_until } : {}),
    ...(typeof record.note === "string" ? { note: record.note } : {}),
  };
}

export async function fetchLocationPrompt(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LocationPromptState>> {
  const result = await authedJson(baseUrl, "/profile/location-prompt", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  // An older service sends only `drift`; no check-in then, rather than a guessed one.
  const body = result.body as { drift?: LocationDrift | null; checkin?: unknown } | null;
  return { ok: true, value: { drift: body?.drift ?? null, checkin: toCheckin(body?.checkin) } };
}

export type LocationCheckinResponse =
  | { action: "answer"; city: string; via: "picker" | "text" | "device" }
  | { action: "snooze" }
  | { action: "decline" };

/** Answer, "Ask me later" or "Prefer not to say". The service logs each, and returns the new state. */
export async function respondToLocationCheckin(
  response: LocationCheckinResponse,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LocationCheckin | null>> {
  const result = await authedJson(
    baseUrl,
    "/profile/location-prompt",
    "POST",
    sessionToken,
    response,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { checkin?: unknown } | null;
  return { ok: true, value: toCheckin(body?.checkin) };
}

/** A gazetteer city: what the picker lists, and what a device position snaps to in the browser. */
export type LocationPlace = {
  key: string;
  label: string;
  country: string;
  lat: number;
  lon: number;
};

export async function fetchLocationPlaces(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LocationPlace[]>> {
  const result = await authedJson(baseUrl, "/profile/location-places", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { places?: unknown } | null;
  const places = Array.isArray(body?.places) ? body.places : [];
  return {
    ok: true,
    value: places.flatMap((raw) => {
      const place = raw as {
        key?: unknown;
        label?: unknown;
        country?: unknown;
        lat?: unknown;
        lon?: unknown;
      } | null;
      return place &&
        typeof place.label === "string" &&
        typeof place.lat === "number" &&
        typeof place.lon === "number"
        ? [
            {
              key: typeof place.key === "string" ? place.key : place.label,
              label: place.label,
              country: typeof place.country === "string" ? place.country : "",
              lat: place.lat,
              lon: place.lon,
            },
          ]
        : [];
    }),
  };
}

/** An empty answer is a dismissal: it settles the question without touching the profile. */
export async function answerLocationPrompt(
  answer: { current_city?: string; timezone?: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<true>> {
  const result = await authedJson(
    baseUrl,
    "/profile/location-prompt",
    "POST",
    sessionToken,
    answer,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: true };
}

/** Everyone whose recent sign-ins disagree with their profile. Admin-only; the service enforces it. */
export async function fetchLocationDrifts(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LocationDrift[]>> {
  const result = await authedJson(baseUrl, "/lab/location-drifts", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { drifts?: LocationDrift[] } | null;
  return { ok: true, value: body?.drifts ?? [] };
}

export async function checkDriveAccess(
  url: string,
  sessionToken: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<AuthResult<{ status: "accessible" | "inaccessible" | "unverified"; message: string }>> {
  const result = await authedJson(
    baseUrl,
    "/drive/check-edit-access",
    "POST",
    sessionToken,
    { url },
    signal,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return {
    ok: true,
    value: result.body as { status: "accessible" | "inaccessible" | "unverified"; message: string },
  };
}

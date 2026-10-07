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

export async function fetchLocationPrompt(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LocationDrift | null>> {
  const result = await authedJson(baseUrl, "/profile/location-prompt", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { drift?: LocationDrift | null } | null;
  return { ok: true, value: body?.drift ?? null };
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

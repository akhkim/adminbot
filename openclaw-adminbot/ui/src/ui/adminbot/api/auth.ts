// AdminBot client: Sign-in, sign-up, password, email, impersonation, registration review, and device pairing.
//
// Mirrors the service's api/routes/auth.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import {
  authedJson,
  type AuthResult,
  type LabMember,
  mapErrorResponse,
  type MemberGateway,
  type MemberImpersonator,
  readJson,
} from "../auth/session.ts";

export type MemberSession = {
  session_token: string;
  expires_at: string;
  member: LabMember;
  gateway?: MemberGateway;
  impersonated_by?: MemberImpersonator;
};

// Optional profile a signup applicant submits when not already on the roster.
// Mirrors the Lab Members self-editable field set (MemberProfileUpdate above)
// so a signup captures the same data a member could later edit for themselves.
export type SignupProfile = {
  name: string;
  slack_user_id?: string;
  role?: string;
  affiliation?: string;
  research_branch?: string;
  research_topics?: string[];
  projects?: string[];
  hours_per_week?: number;
  location?: string;
  timezone?: string;
  personal_website?: string;
  notes?: string;
};

// Single POST helper: returns the raw response+body, or a sentinel when the
// AdminBot origin is unreachable, so each caller maps status codes itself.
async function postJson(
  baseUrl: string,
  path: string,
  payload: unknown,
): Promise<{ response: Response; body: unknown } | { unreachable: true }> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      // Bearer-only contract: never send cookies across the AdminBot origin.
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { unreachable: true };
  }
  return { response, body: await readJson(response) };
}

// Approves the member's own pending gateway device pairing (POST /auth/pair-device). Called when a
// connect attempt returns PAIRING_REQUIRED with a requestId: the member's login session authorizes
// their browser's device, and the service caps the granted scopes at their privilege. On success
// the caller reconnects so the now-paired device picks up its server-bound scopes.
export async function pairDevice(
  requestId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ scopes: string[] }>> {
  const result = await authedJson(baseUrl, "/auth/pair-device", "POST", sessionToken, {
    requestId,
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
  const scopes = Array.isArray((result.body as { scopes?: unknown })?.scopes)
    ? (result.body as { scopes: string[] }).scopes
    : [];
  return { ok: true, value: { scopes } };
}

// Mints a gateway token bound to this browser's device key (POST /auth/device-token), scoped to
// the member's privilege. This is what lets the browser connect without ever holding the shared
// gateway secret: the member's login session is the only credential they need.
export async function issueDeviceToken(
  device: { deviceId: string; publicKey: string; platform?: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ token: string; scopes: string[] }>> {
  const result = await authedJson(baseUrl, "/auth/device-token", "POST", sessionToken, {
    deviceId: device.deviceId,
    publicKey: device.publicKey,
    ...(device.platform ? { platform: device.platform } : {}),
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
  const body = result.body as { token?: unknown; scopes?: unknown };
  if (typeof body?.token !== "string" || !body.token) {
    return { ok: false, kind: "auth-failed" };
  }
  return {
    ok: true,
    value: {
      token: body.token,
      scopes: Array.isArray(body.scopes) ? (body.scopes as string[]) : [],
    },
  };
}

/**
 * Starts a password reset (POST /auth/password-reset). The service answers identically whether or
 * not the address has an account, so this resolves ok for any well-formed email — the UI must not
 * present the outcome as confirmation that an account exists.
 */
export async function requestPasswordReset(
  email: string,
  baseUrl: string,
): Promise<AuthResult<{ requested: true }>> {
  const result = await postJson(baseUrl, "/auth/password-reset", { email });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: { requested: true } };
}

/**
 * Redeems a reset token and sets the new password (POST /auth/password-reset/confirm). A 400 here
 * is overloaded — an expired/used link or a too-short password — so it maps to weak-password only
 * when the caller knows the length was fine; the service message carries the distinction.
 */
export async function confirmPasswordReset(
  token: string,
  newPassword: string,
  baseUrl: string,
): Promise<AuthResult<{ reset: true }>> {
  const result = await postJson(baseUrl, "/auth/password-reset/confirm", {
    token,
    new_password: newPassword,
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: { reset: true } };
}

// Change the member's login email (POST /auth/email). 401 wrong password folds to
// auth-failed; 409 collision to email-unavailable; 429 to rate-limited.
export async function changeMemberEmail(
  newEmail: string,
  currentPassword: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ email: string }>> {
  const result = await authedJson(baseUrl, "/auth/email", "POST", sessionToken, {
    new_email: newEmail,
    current_password: currentPassword,
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 409) {
      return { ok: false, kind: "email-unavailable" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as { email: string } };
}

// Change the member's login password (POST /auth/password). 401 wrong current password folds to
// auth-failed; 400 weak new password to weak-password; 429 to rate-limited.
export async function changeMemberPassword(
  currentPassword: string,
  newPassword: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ changed: true }>> {
  const result = await authedJson(baseUrl, "/auth/password", "POST", sessionToken, {
    current_password: currentPassword,
    new_password: newPassword,
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: true }) };
  }
  return { ok: true, value: result.body as { changed: true } };
}

export async function loginMember(
  email: string,
  password: string,
  baseUrl: string,
): Promise<AuthResult<MemberSession>> {
  const result = await postJson(baseUrl, "/auth/login", { email, password });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return {
      ok: false,
      ...mapErrorResponse(result.response, result.body, { weakOn400: false, pendingOn403: true }),
    };
  }
  return { ok: true, value: result.body as MemberSession };
}

// Claim binds an existing (unclaimed) roster member to an email+password. The
// account then awaits admin approval, so success carries no session.
export async function claimMember(
  memberId: string,
  email: string,
  password: string,
  baseUrl: string,
): Promise<AuthResult<void>> {
  const result = await postJson(baseUrl, "/auth/claim", { member_id: memberId, email, password });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: true }) };
  }
  return { ok: true, value: undefined };
}

// Signup registers a member not already on the roster. Like claim, it returns
// no session — the account awaits admin approval.
export async function signupMember(
  profile: SignupProfile,
  email: string,
  password: string,
  baseUrl: string,
): Promise<AuthResult<void>> {
  const result = await postJson(baseUrl, "/auth/signup", { profile, email, password });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: true }) };
  }
  return { ok: true, value: undefined };
}

/**
 * Open a session that sees the lab as `memberId`. Admin-only; the service enforces that.
 *
 * The returned token is a *different* session, not a mutation of the caller's -- the admin's own
 * stays valid, which is what makes the way back a matter of putting it down rather than signing in
 * again. See saveStoredMemberSession for where it is parked meanwhile.
 */
export async function startImpersonation(
  memberId: string,
  token: string,
  baseUrl: string,
): Promise<AuthResult<MemberSession>> {
  const result = await authedJson(baseUrl, "/auth/impersonate", "POST", token, {
    member_id: memberId,
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as MemberSession };
}

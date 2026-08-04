// Control UI module implements per-member AdminBot email+password auth.
//
// Talks to the standalone AdminBot service (default `http://<host>:8765`).
// The AdminBot session token is revocable/expiring and MAY live in
// localStorage; the gateway token it returns is a secret that must only flow
// through the existing sessionStorage-scoped token plumbing via applySettings.
import { getSafeLocalStorage } from "../local-storage.ts";
import type { UiSettings } from "./storage.ts";
import { normalizeOptionalString } from "./string-coerce.ts";

const SESSION_STORAGE_KEY = "openclaw.adminbot.session.v1";
const ONBOARDING_SEEN_STORAGE_KEY = "openclaw.adminbot.onboarding-seen.v1";
const DEFAULT_ADMINBOT_PORT = "8765";
// TLS-served AdminBot port (tailscale serve fronting :8765). Https pages cannot
// call plain-http :8765 (mixed content), so they default here instead.
const DEFAULT_ADMINBOT_TLS_PORT = "8443";

export type MemberOnboardingStepStatus = "complete" | "current" | "remaining";

export type MemberOnboardingLink = {
  label: string;
  url: string;
};

export type MemberOnboardingStep = {
  id: string;
  label: string;
  status: MemberOnboardingStepStatus;
  category: string;
  detail?: string;
  bullets?: string[];
  links?: MemberOnboardingLink[];
  required: boolean;
};

// Onboarding checklist generated once when a member's account is first approved (see the
// AdminBot service's `onboarding.ts`) and returned as part of the member record thereafter.
export type MemberOnboarding = {
  current_step?: MemberOnboardingStep;
  completed: MemberOnboardingStep[];
  remaining: MemberOnboardingStep[];
  steps: MemberOnboardingStep[];
};

// Lab member record returned by the AdminBot service. Extra fields beyond these
// are preserved but not consumed by the UI.
export type LabMember = {
  id?: string;
  name?: string | null;
  email?: string | null;
  slack_user_id?: string | null;
  privilege_level?: string | null;
  status?: string | null;
  role?: string | null;
  research_branch?: string | null;
  research_topics?: string[] | null;
  projects?: string[] | null;
  hours_per_week?: number | null;
  capacity_percent?: number | null;
  location?: string | null;
  affiliation?: string | null;
  timezone?: string | null;
  personal_website?: string | null;
  notes?: string | null;
  onboarding?: MemberOnboarding | null;
  [key: string]: unknown;
};

// Whitelisted self-editable profile fields. privilege_level/status/email are
// governance-owned and must never be sent from a member's own profile form.
export type MemberProfileUpdate = {
  name?: string;
  slack_user_id?: string;
  role?: string;
  research_topics?: string[];
  projects?: string[];
  hours_per_week?: number;
  capacity_percent?: number;
  location?: string;
  affiliation?: string;
  timezone?: string;
  personal_website?: string;
  notes?: string;
};

// Full governance-capable payload for an admin editing ANY member (including
// privilege_level/status/email). Only sent when the caller is a genuine admin
// member Bearer session — the server independently re-verifies this and
// rejects governance fields from any other principal (service token, non-admin
// member self-edit), so this type being permissive here is not itself a trust
// boundary.
export type AdminLabMemberUpdate = {
  name?: string;
  email?: string;
  slack_user_id?: string;
  privilege_level?: string;
  status?: string;
  role?: string;
  research_topics?: string[];
  projects?: string[];
  hours_per_week?: number;
  capacity_percent?: number;
  location?: string;
  affiliation?: string;
  timezone?: string;
  personal_website?: string;
  notes?: string;
};

// Paper relevant to the signed-in member (GET /papers/relevant). Only the fields
// the profile view renders are typed; the rest of the record is preserved.
export type RelevantPaper = {
  id: string;
  title: string;
  current_step?: string | null;
  artifacts?: { conference?: string; topic?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
};

export type MemberGateway = {
  url: string;
  // The OpenClaw gateway token for the WS connection. Never persist to
  // localStorage — it flows only into sessionStorage-scoped token plumbing.
  token: string;
};

export type MemberSession = {
  session_token: string;
  expires_at: string;
  member: LabMember;
  gateway: MemberGateway;
};

// Session view returned by GET /auth/session (no session_token echoed back).
export type MemberSessionInfo = {
  expires_at: string;
  member: LabMember;
  gateway: MemberGateway;
};

// Unclaimed roster entry surfaced in the claim picker (GET /auth/roster).
export type RosterMember = { id: string; name: string };

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
  capacity_percent?: number;
  location?: string;
  timezone?: string;
  personal_website?: string;
  notes?: string;
};

// Admin review entry for a pending account request (GET /auth/registrations).
// `member_id`/`member_name` are set for `claim`; `profile` carries the proposed
// member fields for `signup`. The stored password hash is never exposed here.
export type MemberRegistration = {
  id: string;
  kind: "claim" | "signup";
  email: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  member_id?: string;
  member_name?: string;
  profile?: Record<string, unknown>;
};

// Closed set of failure modes so callers render distinct guidance. `retryAfterSeconds`
// is only meaningful for `rate-limited`; `pending-approval` only for login.
export type AuthErrorKind =
  | "auth-failed"
  | "weak-password"
  | "rate-limited"
  | "unreachable"
  | "pending-approval"
  // Email change collided with an address already in use (POST /auth/email 409).
  | "email-unavailable"
  // Session authenticated but lacks admin/core_member privilege (403). Distinct from
  // auth-failed so governance surfaces can say "not allowed" instead of "sign in again".
  | "forbidden";

export type AuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: AuthErrorKind; retryAfterSeconds?: number };

export function resolveAdminBotBaseUrl(settings?: Pick<UiSettings, "adminBotUrl"> | null): string {
  const override = normalizeOptionalString(settings?.adminBotUrl);
  if (override) {
    return override.replace(/\/+$/, "");
  }
  const hostname = typeof location !== "undefined" ? location.hostname : "127.0.0.1";
  if (typeof location !== "undefined" && location.protocol === "https:") {
    return `https://${hostname}:${DEFAULT_ADMINBOT_TLS_PORT}`;
  }
  return `http://${hostname}:${DEFAULT_ADMINBOT_PORT}`;
}

function parseRetryAfterSeconds(body: unknown, response: Response): number | undefined {
  const fromBody = (body as { retry_after_seconds?: unknown } | null)?.retry_after_seconds;
  if (typeof fromBody === "number" && Number.isFinite(fromBody)) {
    return fromBody;
  }
  const header = response.headers.get("retry-after");
  const parsed = header ? Number(header) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// Maps AdminBot HTTP status codes onto the closed AuthErrorKind set. `weakOn400`
// distinguishes claim/signup (400 = weak password) from login (no 400 contract);
// `pendingOn403` folds login's pending-approval code out of the generic 403.
function mapErrorResponse(
  response: Response,
  body: unknown,
  opts: { weakOn400: boolean; pendingOn403?: boolean },
): { kind: AuthErrorKind; retryAfterSeconds?: number } {
  if (response.status === 429) {
    return { kind: "rate-limited", retryAfterSeconds: parseRetryAfterSeconds(body, response) };
  }
  if (opts.weakOn400 && response.status === 400) {
    return { kind: "weak-password" };
  }
  if (
    opts.pendingOn403 &&
    response.status === 403 &&
    (body as { code?: unknown } | null)?.code === "pending_approval"
  ) {
    return { kind: "pending-approval" };
  }
  return { kind: "auth-failed" };
}

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

// Bearer-authenticated POST/PUT for member-session routes. Same unreachable
// sentinel + credentials:"omit" contract as postJson.
async function authedJson(
  baseUrl: string,
  path: string,
  method: "POST" | "PUT",
  token: string,
  payload: unknown,
): Promise<{ response: Response; body: unknown } | { unreachable: true }> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return { unreachable: true };
  }
  return { response, body: await readJson(response) };
}

// Self-service profile edit (PUT /lab/members/:id) with the member session. Only
// whitelisted profile fields are sent; email/privilege_level/status stay out.
export async function updateOwnProfile(
  memberId: string,
  fields: MemberProfileUpdate,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LabMember>> {
  const result = await authedJson(
    baseUrl,
    `/lab/members/${encodeURIComponent(memberId)}`,
    "PUT",
    sessionToken,
    fields,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as LabMember };
}

// Admin write for ANY member (self or otherwise), including governance fields.
// Uses the signed-in admin's own member Bearer session — the server routes a
// real admin member session to the full write path, unlike the shared service
// principal (which every gateway-tool call authenticates as and which is
// deliberately restricted to the same whitelist as a plain self-edit).
export async function upsertLabMemberAsAdmin(
  memberId: string,
  fields: AdminLabMemberUpdate,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LabMember>> {
  const result = await authedJson(
    baseUrl,
    `/lab/members/${encodeURIComponent(memberId)}`,
    "PUT",
    sessionToken,
    fields,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    // The service only grants the full governance write to an admin/core_member member
    // session (extensions/adminbot/src/mock-service.ts) — a session that has lost that
    // privilege gets 403, mapped to `forbidden` rather than the generic auth-failed.
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as LabMember };
}

// Approvals go over the member session rather than the gateway tool: the service records the
// approver from the authenticated principal, and the shared service principal every agent tool
// call uses cannot name a person (extensions/adminbot/src/mock-service.ts).
export async function approveActionAsMember(
  actionId: string,
  payloadHash: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<AdminBotProposalView>> {
  return await privilegedActionCall<AdminBotProposalView>(
    baseUrl,
    `/approvals/${encodeURIComponent(actionId)}/approve`,
    sessionToken,
    { payload_hash: payloadHash },
  );
}

export async function executeActionAsMember(
  actionId: string,
  idempotencyKey: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<AdminBotExecutionView>> {
  return await privilegedActionCall<AdminBotExecutionView>(
    baseUrl,
    `/actions/${encodeURIComponent(actionId)}/execute`,
    sessionToken,
    { idempotency_key: idempotencyKey, dry_run: false },
  );
}

export type AdminBotProposalView = {
  id: string;
  status: "pending" | "approved" | "executed" | "rejected";
  approval_requirement: { min_approvals: number; approver_roles: string[] };
  approvals: Array<{ approver_role: string; approver_id?: string }>;
};

export type AdminBotExecutionView = {
  action_id: string;
  status: "simulated" | "executed";
  dry_run: boolean;
};

async function privilegedActionCall<T>(
  baseUrl: string,
  path: string,
  sessionToken: string,
  body: unknown,
): Promise<AuthResult<T>> {
  const result = await authedJson(baseUrl, path, "POST", sessionToken, body);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as T };
}

export type MemberNudgeChannel = "slack" | "email";

export type MemberNudgeRequest = {
  channel: MemberNudgeChannel;
  recipient_member_ids: string[];
  message: string;
  // Required when channel is "email"; ignored for "slack".
  subject?: string;
};

export type MemberNudgeSkip = { member_id: string; reason: string };

export type MemberNudgeResult = {
  created: Array<{ id: string; status: string }>;
  skipped: MemberNudgeSkip[];
};

// Admin-only bulk nudge/announcement send (POST /nudges/send): fans out into one
// member_nudge.send proposal per recipient, same admin-Bearer-session write path as
// upsertLabMemberAsAdmin — never routed through the shared service principal, which
// the server would reject (403) precisely because this fans real messages out to members.
export async function sendMemberNudge(
  request: MemberNudgeRequest,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MemberNudgeResult>> {
  const result = await authedJson(baseUrl, "/nudges/send", "POST", sessionToken, request);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as MemberNudgeResult };
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

// Papers relevant to the signed-in member (GET /papers/relevant) with the session.
export async function fetchRelevantPapers(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<RelevantPaper[]>> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/papers/relevant`, {
      method: "GET",
      credentials: "omit",
      headers: { Accept: "application/json", Authorization: `Bearer ${sessionToken}` },
    });
  } catch {
    return { ok: false, kind: "unreachable" };
  }
  const body = await readJson(response);
  if (!response.ok) {
    return { ok: false, ...mapErrorResponse(response, body, { weakOn400: false }) };
  }
  const papers = (body as { papers?: RelevantPaper[] } | null)?.papers ?? [];
  return { ok: true, value: papers };
}

// Pending account requests awaiting an admin decision (GET /auth/registrations).
// The service only answers this for an admin/core_member member session, so 403
// maps to `forbidden` rather than the generic auth-failed.
export async function fetchPendingRegistrations(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MemberRegistration[]>> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/auth/registrations?status=pending`, {
      method: "GET",
      credentials: "omit",
      headers: { Accept: "application/json", Authorization: `Bearer ${sessionToken}` },
    });
  } catch {
    return { ok: false, kind: "unreachable" };
  }
  const body = await readJson(response);
  if (!response.ok) {
    if (response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(response, body, { weakOn400: false }) };
  }
  const registrations = (body as { registrations?: MemberRegistration[] } | null)?.registrations;
  return { ok: true, value: registrations ?? [] };
}

async function decideRegistration(
  registrationId: string,
  decision: "approve" | "reject",
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<void>> {
  const result = await authedJson(
    baseUrl,
    `/auth/registrations/${encodeURIComponent(registrationId)}/${decision}`,
    "POST",
    sessionToken,
    {},
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: undefined };
}

export function approveRegistration(
  registrationId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<void>> {
  return decideRegistration(registrationId, "approve", sessionToken, baseUrl);
}

export function rejectRegistration(
  registrationId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<void>> {
  return decideRegistration(registrationId, "reject", sessionToken, baseUrl);
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

// Public roster of unclaimed members backing the claim picker (no auth).
export async function fetchRoster(baseUrl: string): Promise<AuthResult<RosterMember[]>> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/auth/roster`, {
      method: "GET",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
  } catch {
    return { ok: false, kind: "unreachable" };
  }
  const body = await readJson(response);
  if (!response.ok) {
    return { ok: false, ...mapErrorResponse(response, body, { weakOn400: false }) };
  }
  const members = (body as { members?: RosterMember[] } | null)?.members ?? [];
  return { ok: true, value: members };
}

export async function fetchMemberSession(
  token: string,
  baseUrl: string,
): Promise<AuthResult<MemberSessionInfo>> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/auth/session`, {
      method: "GET",
      credentials: "omit",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, kind: "unreachable" };
  }
  const body = await readJson(response);
  if (!response.ok) {
    return { ok: false, ...mapErrorResponse(response, body, { weakOn400: false }) };
  }
  return { ok: true, value: body as MemberSessionInfo };
}

export async function logoutMember(token: string, baseUrl: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      credentials: "omit",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
  } catch {
    // Best-effort: local session is cleared regardless of server reachability.
  }
}

// Only non-secret fields are persisted; the gateway token is intentionally
// excluded and re-fetched from GET /auth/session on resume.
export type StoredMemberSession = { sessionToken: string; expiresAt: string };

export function loadStoredMemberSession(): StoredMemberSession | null {
  const storage = getSafeLocalStorage();
  try {
    const raw = storage?.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredMemberSession>;
    const sessionToken = normalizeOptionalString(parsed.sessionToken);
    if (!sessionToken) {
      return null;
    }
    return { sessionToken, expiresAt: normalizeOptionalString(parsed.expiresAt) ?? "" };
  } catch {
    return null;
  }
}

export function saveStoredMemberSession(next: StoredMemberSession): void {
  const storage = getSafeLocalStorage();
  try {
    storage?.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ sessionToken: next.sessionToken, expiresAt: next.expiresAt }),
    );
  } catch {
    // best-effort — quota/security failures must not block the in-memory session.
  }
}

export function clearStoredMemberSession(): void {
  const storage = getSafeLocalStorage();
  try {
    storage?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // best-effort
  }
}

// Tracks which members have already dismissed the post-login onboarding welcome screen, so it
// only auto-shows once per member per browser rather than on every login/reload.
function loadSeenOnboardingMemberIds(): Set<string> {
  const storage = getSafeLocalStorage();
  try {
    const raw = storage?.getItem(ONBOARDING_SEEN_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function hasSeenOnboardingWelcome(memberId: string): boolean {
  return loadSeenOnboardingMemberIds().has(memberId);
}

export function markOnboardingWelcomeSeen(memberId: string): void {
  const storage = getSafeLocalStorage();
  try {
    const seen = loadSeenOnboardingMemberIds();
    seen.add(memberId);
    storage?.setItem(ONBOARDING_SEEN_STORAGE_KEY, JSON.stringify([...seen]));
  } catch {
    // best-effort — quota/security failures just mean the welcome screen may reappear.
  }
}

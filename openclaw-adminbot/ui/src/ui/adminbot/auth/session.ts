// Control UI module implements per-member AdminBot email+password auth.
//
// Talks to the standalone AdminBot service (default `http://<host>:8765`).
// The AdminBot session token is revocable/expiring and MAY live in
// localStorage; the gateway token it returns is a secret that must only flow
// through the existing sessionStorage-scoped token plumbing via applySettings.
import { getSafeLocalStorage } from "../../../local-storage.ts";
import type { UiSettings } from "../../storage.ts";
import { normalizeOptionalString } from "../../string-coerce.ts";
import type { AvailabilityRow, TimeOffRow } from "../data/availability.js";

const SESSION_STORAGE_KEY = "openclaw.adminbot.session.v1";
// v2: the onboarding checklist moved from a post-login popup (dismiss = "seen it") to a standing
// dashboard warning (dismiss = "read and acknowledged it"). Bumped so a v1 dismissal -- which only
// ever meant "closed the popup once" -- doesn't suppress the new, more consequential warning.
const ONBOARDING_ACKNOWLEDGED_STORAGE_KEY = "openclaw.adminbot.onboarding-acknowledged.v2";
const DEFAULT_ADMINBOT_PORT = "8765";
// TLS-served AdminBot port (tailscale serve fronting :8765). Https pages cannot
// call plain-http :8765 (mixed content), so they default here instead.
const DEFAULT_ADMINBOT_TLS_PORT = "8443";

export type MemberOnboardingStepStatus = "complete" | "current" | "remaining";

export type MemberOnboardingLink = {
  label: string;
  url: string;
};

export type MemberOnboardingBullet = {
  text: string;
  points?: string[];
};

export type MemberOnboardingStep = {
  id: string;
  label: string;
  status: MemberOnboardingStepStatus;
  category: string;
  detail?: string;
  bullets?: MemberOnboardingBullet[];
  links?: MemberOnboardingLink[];
  required: boolean;
  acknowledged_at?: string;
};

// Onboarding checklist generated once when a member's account is first approved (see the
// AdminBot service's `onboarding.ts`) and returned as part of the member record thereafter.
export type MemberOnboarding = {
  current_step?: MemberOnboardingStep;
  completed: MemberOnboardingStep[];
  remaining: MemberOnboardingStep[];
  steps: MemberOnboardingStep[];
};

export type ProfilePhotoAssessment = {
  compliant: boolean;
  issues: string[];
  summary: string;
  checked_at: string;
  photo_url?: string;
  source: "ai" | "heuristic";
};

export type ProfilePhotoPolishVariant = {
  id: string;
  image_data_url: string;
  created_at: string;
  note?: string;
};

export type ProfilePhotoReviewState = {
  assessment?: ProfilePhotoAssessment;
  last_guideline_dm_at?: string;
  variants?: ProfilePhotoPolishVariant[];
  selected_variant_id?: string;
};

// Lab member record returned by the AdminBot service. Extra fields beyond these
// are preserved but not consumed by the UI.
export type LabMember = {
  id?: string;
  name?: string | null;
  // Governance-owned directory address, required to be @cs.toronto.edu for core members.
  email?: string | null;
  // Self-editable and any domain -- whatever address the member actually uses for Google
  // Calendar, which very often is not their cs.toronto.edu address.
  calendar_email?: string | null;
  slack_user_id?: string | null;
  privilege_level?: string | null;
  status?: string | null;
  role?: string | null;
  research_branch?: string | null;
  research_topics?: string[] | null;
  projects?: string[] | null;
  hours_per_week?: number | null;
  // Owned by the member and edited in the AdminBot console; the Control UI only renders it.
  availability?: AvailabilityRow[] | null;
  time_off?: TimeOffRow[] | null;
  availability_notes?: string | null;
  location?: string | null;
  // Where the member currently is, distinct from resident `location`. Informational only.
  current_city?: string | null;
  affiliation?: string | null;
  timezone?: string | null;
  personal_website?: string | null;
  openreview_id?: string | null;
  cv_url?: string | null;
  intake_form_url?: string | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  github_url?: string | null;
  scholar_url?: string | null;
  avatar_url?: string | null;
  profile_photo_review?: ProfilePhotoReviewState | null;
  notes?: string | null;
  onboarding?: MemberOnboarding | null;
  [key: string]: unknown;
};

// Whitelisted self-editable profile fields. privilege_level/status/email are
// governance-owned and must never be sent from a member's own profile form.
export type MemberProfileUpdate = {
  name?: string;
  calendar_email?: string;
  slack_user_id?: string;
  role?: string;
  research_topics?: string[];
  projects?: string[];
  hours_per_week?: number;
  // The schedule is not a profile field: it is the row lists MemberScheduleUpdate carries, and the
  // service validates it as such. A free-text `availability` string used to live here, and the Lab
  // Members form sent it empty on every save, so the service answered 400 "member availability must
  // be a list" and the whole edit was lost.
  location?: string;
  current_city?: string;
  affiliation?: string;
  timezone?: string;
  personal_website?: string;
  openreview_id?: string;
  // The link only. cv_snapshot is not writable here: the service owns it, and a member who could
  // set it could hide or invent their own career changes.
  cv_url?: string;
  intake_form_url?: string;
  linkedin_url?: string;
  twitter_url?: string;
  github_url?: string;
  scholar_url?: string;
  avatar_url?: string;
  notes?: string;
  // Promoted out of the notes line convention; see migrateMemberNotesToFields in the service.
  joined_month?: string;
  whatsapp?: string;
};

export type ProfilePhotoPolishResult = {
  variant: ProfilePhotoPolishVariant;
  variants: ProfilePhotoPolishVariant[];
  assessment?: ProfilePhotoAssessment;
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
  collaborator_subgroup?: string;
  status?: string;
  role?: string;
  research_topics?: string[];
  projects?: string[];
  hours_per_week?: number;
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
  // Optional: the service omits it unless an operator configured one, because it cannot know how
  // this browser reaches the gateway. See resolveAdvertisedGatewayUrl.
  url?: string;
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
  // Session authenticated but lacks admin privilege (403). Distinct from
  // auth-failed so governance surfaces can say "not allowed" instead of "sign in again".
  | "forbidden"
  // A generation step failed downstream (502) -- no OpenRouter key, or a PDF with no readable
  // abstract. The route is authenticated, so its message is safe to show verbatim, and it is
  // the only text that tells the author what to fix.
  | "draft-failed"
  // The service does not have this route (404). Almost always a version skew rather than anything
  // to do with credentials: a long-lived dev service outliving the console that calls it. It used
  // to fall through to auth-failed, which sent people to check their login for a problem that was
  // really a process needing a restart.
  | "not-found";

export type AuthResult<T> =
  | { ok: true; value: T }
  // `message` carries the service's own explanation, and is only ever populated for a 400 --
  // a validation refusal names the field it rejected ("LinkedIn link must be a profile URL"),
  // which no generic client-side string can. Auth and rate-limit failures deliberately keep
  // their fixed copy, so nothing from an unauthenticated path reaches the screen verbatim.
  | { ok: false; kind: AuthErrorKind; retryAfterSeconds?: number; message?: string };

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
): { kind: AuthErrorKind; retryAfterSeconds?: number; message?: string } {
  if (response.status === 429) {
    return { kind: "rate-limited", retryAfterSeconds: parseRetryAfterSeconds(body, response) };
  }
  if (opts.weakOn400 && response.status === 400) {
    return { kind: "weak-password" };
  }
  // A 400 is the service refusing a value it can name. Carry that sentence up; every other status
  // keeps its fixed client-side copy (see AuthResult).
  if (response.status === 400) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    return typeof message === "string" && message.trim()
      ? { kind: "auth-failed", message: message.trim() }
      : { kind: "auth-failed" };
  }
  if (
    opts.pendingOn403 &&
    response.status === 403 &&
    (body as { code?: unknown } | null)?.code === "pending_approval"
  ) {
    return { kind: "pending-approval" };
  }
  // Before this, 404 fell through to auth-failed and reported a missing route as a credentials
  // problem. Kept above the catch-all so the distinction cannot be lost again.
  if (response.status === 404) {
    return { kind: "not-found" };
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
  method: "GET" | "POST" | "PUT",
  token: string,
  payload?: unknown,
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
      // GET carries no body; every other member-session call sends JSON.
      ...(method === "GET" ? {} : { body: JSON.stringify(payload) }),
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

// A single commitment row on a member's schedule. Mirrors AdminBotAvailabilityRow in
// extensions/adminbot/src/contracts/actions.ts, and AvailabilityRow in ../data/availability.ts —
// copied rather than imported for the same reason the privilege levels are: the auth layer does
// not reach across into either the extensions boundary or the view layer.
export type MemberAvailabilityRow = {
  start: string;
  end: string;
  project?: string;
  hours_per_week: number;
  note?: string;
  link?: string;
};

export type MemberTimeOffRow = {
  start: string;
  end: string;
  // Optional here only because the lists sent back are composed from stored rows, whose parsed
  // shape treats `kind` as absent-able. The service rejects any row whose kind is not one of
  // adminBotTimeOffKinds, so a row without one never lands.
  kind?: string;
  availability: "none" | "partial";
  note?: string;
  label?: string;
  link?: string;
};

export type MemberMilestoneRow = {
  date: string;
  label: string;
  link?: string;
};

/**
 * The three schedule lists, any subset of which may be sent.
 *
 * An omitted list is left alone; a list sent as `[]` clears that part of the schedule outright
 * (the service deletes an empty array rather than storing one, so it reads as "nothing recorded"
 * rather than as an empty chart).
 */
export type MemberTripRow = {
  start: string;
  end: string;
  city: string;
  timezone?: string;
  note?: string;
  link?: string;
};

export type MemberScheduleUpdate = {
  availability?: MemberAvailabilityRow[];
  time_off?: MemberTimeOffRow[];
  milestones?: MemberMilestoneRow[];
  trips?: MemberTripRow[];
  dismissed_deadlines?: string[];
  // The overall note that explains the rows: a sentence or two for the admins, sent on its own
  // (every other key omitted) so saving it can never rewrite a list. "" clears it -- the service
  // deletes an emptied note rather than storing a blank one.
  availability_notes?: string;
};

/**
 * Self-service schedule edit (PUT /lab/members/:id) with the member session.
 *
 * Deliberately separate from `updateOwnProfile`: a schedule is whole lists of validated rows
 * (SELF_PROFILE_EDITABLE_FIELDS and validateAvailability in
 * extensions/adminbot/src/kernel/service.ts), while a profile update is scalar fields. They were
 * once the same field — `MemberProfileUpdate.availability` as free text — and the profile forms
 * kept sending that string over the list the service expects, failing every save with 400 "member
 * availability must be a list".
 *
 * All three lists are self-editable, so this needs no approval gate — but the service still
 * re-validates everything (date ranges, 0–168 hours, https-only links, 200-row caps) and stamps
 * `availability_updated_at`. The UI never writes another member's schedule; the server enforces it.
 */
export async function updateOwnSchedule(
  memberId: string,
  patch: MemberScheduleUpdate,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LabMember>> {
  const result = await authedJson(
    baseUrl,
    `/lab/members/${encodeURIComponent(memberId)}`,
    "PUT",
    sessionToken,
    patch,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as LabMember };
}

/**
 * Writes lab-wide settings over the signed-in admin's own member session (PUT /settings).
 *
 * Not through the adminbot_update_settings gateway tool: every gateway-tool call authenticates as
 * the shared service principal, and the service's requireMemberPrivileged denies that principal
 * for settings outright -- governance has to be driven by a real member session, or any signed-in
 * member could change lab policy by asking the agent to. Same reasoning as
 * upsertLabMemberAsAdmin below.
 */
export async function updateSettingsAsAdmin(
  settings: Record<string, unknown>,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/settings", "PUT", sessionToken, settings);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    // A 400 carries the service's own explanation of what it refused.
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
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
    // The service only grants the full governance write to an admin member
    // session (extensions/adminbot/src/api/server.ts) — a session that has lost that
    // privilege gets 403, mapped to `forbidden` rather than the generic auth-failed.
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as LabMember };
}

/**
 * Write this member's own line about their week on one paper.
 *
 * The member id is never sent: the service takes it from the session, because the log is only
 * worth reading if every line is first-hand. `weekStart` is omitted in the ordinary case -- the
 * service files it under the week containing now -- and passed only to correct an earlier week.
 */
export async function savePaperWeeklyUpdate(
  paperId: string,
  body: string,
  sessionToken: string,
  baseUrl: string,
  weekStart?: string,
): Promise<AuthResult<{ update: PaperWeeklyUpdate }>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}/weekly-updates`,
    "POST",
    sessionToken,
    { body, ...(weekStart ? { week_start: weekStart } : {}) },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as { update: PaperWeeklyUpdate } };
}

/**
 * Send one member's verdict on one surface.
 *
 * Fire-and-forget from the caller's point of view: the widget has already stored the vote locally
 * and dismissed itself, so a failed write must not put a dialog in front of somebody who has
 * finished. The result is returned anyway, because a caller that wants to log it should be able
 * to -- what it must not do is block the page on it.
 */
export async function submitFeedback(
  input: { featureId: string; rating: number; comment?: string; githubFile?: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/feedback", "POST", sessionToken, {
    feature_id: input.featureId,
    rating: input.rating,
    ...(input.comment ? { comment: input.comment } : {}),
    ...(input.githubFile ? { github_file: input.githubFile } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

/**
 * Fold one roster row into another.
 *
 * Member session only, like every other governance write: the service refuses this to the shared
 * service principal outright, because a merge retires a person's record and moves their login.
 * The response carries what the merge could not decide -- fields both records answered
 * differently, where the survivor's answer stands -- so the caller can show it rather than let it
 * pass silently.
 */
export async function mergeLabMembersAsAdmin(
  survivorId: string,
  duplicateId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<
  AuthResult<{
    member: LabMember;
    conflicts: Array<{ field: string; kept: unknown; discarded: unknown }>;
    moved: Record<string, number>;
  }>
> {
  const result = await authedJson(baseUrl, "/lab/members/merge", "POST", sessionToken, {
    survivor_id: survivorId,
    duplicate_id: duplicateId,
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
  return {
    ok: true,
    value: result.body as {
      member: LabMember;
      conflicts: Array<{ field: string; kept: unknown; discarded: unknown }>;
      moved: Record<string, number>;
    },
  };
}

// Approvals go over the member session rather than the gateway tool: the service records the
// approver from the authenticated principal, and the shared service principal every agent tool
// call uses cannot name a person (extensions/adminbot/src/api/server.ts).
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

// LinkedIn (and every other checklist step) is roster state, not something observed: no LinkedIn
// API can report whether a given person follows or works at an organization, so completion is
// only ever what the member or an admin recorded here.
export async function setOnboardingStep(
  memberId: string,
  stepId: string,
  complete: boolean,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LabMember>> {
  const result = await authedJson(
    baseUrl,
    `/lab/members/${encodeURIComponent(memberId)}/onboarding/${encodeURIComponent(stepId)}`,
    "POST",
    sessionToken,
    { complete },
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
  return { ok: true, value: result.body as LabMember };
}

export async function nudgeOnboardingStep(
  stepId: string,
  channel: MemberNudgeChannel,
  sessionToken: string,
  baseUrl: string,
  message?: string,
): Promise<AuthResult<MemberNudgeResult>> {
  const result = await authedJson(
    baseUrl,
    `/onboarding/${encodeURIComponent(stepId)}/nudge`,
    "POST",
    sessionToken,
    { channel, ...(message ? { message } : {}) },
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
  return { ok: true, value: result.body as MemberNudgeResult };
}

export type OnboardingGuideRequest = {
  templateId: string;
  name: string;
  email: string;
  values: Record<string, string>;
  preview: boolean;
  /** Left out entirely when the tab has no opinion, so the service applies its own default. */
  submitDcsForm?: boolean;
  /**
   * The copy as the operator edited it in the preview. Sent only when it differs from what the
   * preview returned, so an untouched preview still sends the stored template.
   */
  subjectOverride?: string;
  bodyOverride?: string;
  /** Channels the send should invite them to, by name or id; empty means none. */
  projectChannels?: readonly string[];
};

export type OnboardingGuideResult = {
  template_id: string;
  subject: string;
  body: string;
  sent: boolean;
  drive_folder_link?: string;
  slack_connect_link?: string;
  project_channel_invites?: { channel: string; url: string }[];
};

/**
 * Previews or sends an onboarding guide as the signed-in admin.
 *
 * The 422 carries the exact list of values the service is still waiting on, which is the whole
 * point of the endpoint refusing rather than sending a half-filled email; it is surfaced verbatim
 * so the form can name the fields instead of guessing.
 */
export async function sendOnboardingGuide(
  request: OnboardingGuideRequest,
  sessionToken: string,
  baseUrl: string,
): Promise<
  | AuthResult<OnboardingGuideResult>
  | { ok: false; kind: "missing"; missing: string[] }
  | { ok: false; kind: "rejected"; message: string }
> {
  const result = await authedJson(baseUrl, "/onboarding/guide", "POST", sessionToken, {
    template_id: request.templateId,
    name: request.name,
    email: request.email,
    values: request.values,
    preview: request.preview,
    ...(request.submitDcsForm === undefined ? {} : { submit_dcs_form: request.submitDcsForm }),
    ...(request.subjectOverride ? { subject_override: request.subjectOverride } : {}),
    ...(request.bodyOverride ? { body_override: request.bodyOverride } : {}),
    ...(request.projectChannels?.length ? { slack_project_channels: request.projectChannels } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    const error = (result.body as { error?: { missing?: string[]; message?: string } } | undefined)
      ?.error;
    if (result.response.status === 422 && error?.missing?.length) {
      return { ok: false, kind: "missing", missing: error.missing };
    }
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    // Everything else this route refuses -- an unconfigured mail account (503), Drive or Slack
    // provisioning that is not wired up (501), an unknown template (404), a rejected name or
    // address (400) -- arrives with a message that says exactly which one it was. Passing it
    // through matters more here than on most routes: only 400 is about what the admin typed, so
    // the generic "check the details" advice is wrong for every other case, and an operator who
    // follows it re-types a correct form until they give up.
    const message = normalizeOptionalString(error?.message);
    if (message) {
      return { ok: false, kind: "rejected", message };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as OnboardingGuideResult };
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

export type ApprovalExecutionResult = { status: string; [key: string]: unknown };

// Dismiss a pending action with the signed-in member's own Bearer session
// (POST /proposals/:id/remove). Approve and execute live in approveActionAsMember /
// executeActionAsMember above: the server records the approver from the authenticated
// principal, so the caller cannot name itself and the two-distinct-approver requirement
// on high-risk actions actually binds.
//
// This deliberately does NOT go through the gateway `tools.invoke` path. That path always
// authenticates as the shared service principal regardless of who is chatting, so routing
// approvals through it would let any member drive a privileged action by asking the
// AdminBot agent to do it in chat. The server answers these routes with
// requireMemberPrivileged, which rejects the service principal outright (403) and demands a
// real admin session — so the capability exists only where a genuine privileged
// member session is present: this UI path.
export async function removePendingAction(
  actionId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<ApprovalExecutionResult>> {
  return await approvalCall(
    `/proposals/${encodeURIComponent(actionId)}/remove`,
    { actor: "control-ui" },
    sessionToken,
    baseUrl,
  );
}

async function approvalCall(
  path: string,
  payload: unknown,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<ApprovalExecutionResult>> {
  const result = await authedJson(baseUrl, path, "POST", sessionToken, payload);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: (result.body ?? {}) as ApprovalExecutionResult };
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

// Reads an AdminBot resource over the member's own session. The dashboard uses this rather than
// the gateway tool path because `tools.invoke` requires operator.write, which a plain member's
// paired device deliberately does not hold -- so for them the tool path returns nothing at all.
// The Calendar tab's two reads. Both are admin-member only server-side; neither writes. Creating an
// event or inviting anyone is a `calendar.*` proposal through createCalendarProposal below, which
// still has to be approved and executed like every other external effect.
export type CalendarEvent = {
  id: string;
  summary: string;
  start: string;
  end?: string;
  location?: string;
  description?: string;
  calendar_id?: string;
  html_link?: string;
  attendees?: string[];
  all_day?: boolean;
};

export type CalendarEventDraft = {
  summary: string;
  start: string;
  end: string;
  timezone?: string;
  location?: string;
  description?: string;
  attendees?: string[];
};

export type LabCalendar = { id: string; timezone: string; embed_url: string };

export async function fetchCalendarEvents(
  params: { calendarId?: string; from?: string; to?: string; query?: string; max?: number },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ events: CalendarEvent[]; calendar: LabCalendar | null }>> {
  const search = new URLSearchParams();
  if (params.calendarId) search.set("calendar_id", params.calendarId);
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.query) search.set("query", params.query);
  if (params.max) search.set("max", String(params.max));
  const query = search.toString();
  const result = await authedJson(
    baseUrl,
    query ? `/calendar/events?${query}` : "/calendar/events",
    "GET",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    // 502 means the CLI is missing, unauthenticated, or its keyring is locked — the service says
    // which, and that sentence is far more use than "could not load".
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { events?: CalendarEvent[]; calendar?: LabCalendar } | null;
  return { ok: true, value: { events: body?.events ?? [], calendar: body?.calendar ?? null } };
}

export async function draftCalendarEvent(
  request: {
    prompt: string;
    timezone?: string;
    /** Present when the instruction is an edit to this event rather than a new one. */
    editing?: {
      summary: string;
      start: string;
      end?: string;
      location?: string;
      description?: string;
    };
  },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<CalendarEventDraft>> {
  const result = await authedJson(baseUrl, "/calendar/event-draft", "POST", sessionToken, {
    prompt: request.prompt,
    ...(request.timezone ? { timezone: request.timezone } : {}),
    ...(request.editing ? { editing: request.editing } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    // A 400 here names what was wrong with the draft ("the draft ends before it starts"), which is
    // the sentence that tells the operator how to rewrite their instruction.
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { draft?: CalendarEventDraft } | null;
  if (!body?.draft) {
    return { ok: false, kind: "auth-failed" };
  }
  return { ok: true, value: body.draft };
}

/**
 * The Calendar tab's three writes. Each one goes straight through: the service files the typed
 * action, records the signed-in admin as its approver, and executes it in the same request.
 *
 * The tab is admin-only, so the person clicking is the person who would have approved it anyway.
 * The ledger still gets the proposal, the named approver and the execution — one click, same audit.
 */
export type CalendarActionResult = { action_id: string; status: string; executed_at?: string };

/**
 * One LinkedIn announcement draft, generated from a paper PDF.
 *
 * Nothing about this round trip is stored -- not on the server, not here. The draft exists in
 * the dialog until the author copies it, which is the whole point: the authoritative version is
 * the one they post, and a saved copy would only ever be the stale one.
 */
export type LinkedInDraftAuthor = {
  paperName: string;
  displayName: string;
  matched: boolean;
  match: "none" | "exact" | "initial";
  member_id?: string;
  linkedin_url?: string;
  linkedin_urn?: string;
};

export type LinkedInDraft = {
  paper: { title: string; authors: string[]; abstract: string; url?: string };
  text: string;
  model: string;
  issues: string[];
  authors: LinkedInDraftAuthor[];
};

export async function draftLinkedInPost(
  request: { pdfBase64?: string; paperId?: string; url?: string; venue?: string; note?: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LinkedInDraft>> {
  const result = await authedJson(baseUrl, "/papers/linkedin-draft", "POST", sessionToken, {
    // Either is enough. An attached file wins; otherwise the service reads the Drive copy the
    // paper already names, which the card has been chasing the author for anyway.
    ...(request.pdfBase64 ? { pdf_base64: request.pdfBase64 } : {}),
    ...(request.paperId ? { paper_id: request.paperId } : {}),
    ...(request.url ? { url: request.url } : {}),
    ...(request.venue ? { venue: request.venue } : {}),
    ...(request.note ? { note: request.note } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    // A 502 here carries the connector's own message -- a missing OPENROUTER_API_KEY, or a PDF
    // with no extractable abstract. Both are things the person clicking can act on.
    const body = result.body as { error?: { message?: string } } | null;
    return { ok: false, kind: "draft-failed", message: body?.error?.message ?? "draft failed" };
  }
  return { ok: true, value: result.body as LinkedInDraft };
}

export async function createCalendarEvent(
  event: {
    summary: string;
    start: string;
    end: string;
    timezone?: string;
    location?: string;
    description?: string;
    attendees?: string[];
  },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<CalendarActionResult>> {
  return await calendarWrite("/calendar/events", event, sessionToken, baseUrl);
}

export async function updateCalendarEvent(
  eventId: string,
  event: {
    summary: string;
    start: string;
    end: string;
    timezone?: string;
    location?: string;
    description?: string;
  },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<CalendarActionResult>> {
  return await calendarWrite(
    `/calendar/events/${encodeURIComponent(eventId)}`,
    event,
    sessionToken,
    baseUrl,
  );
}

export async function inviteToCalendarEvent(
  eventId: string,
  request: { attendees: string[]; summary?: string; rationale?: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<CalendarActionResult>> {
  return await calendarWrite(
    `/calendar/events/${encodeURIComponent(eventId)}/invite`,
    request,
    sessionToken,
    baseUrl,
  );
}

/**
 * The calendar routes' failures, with the service's own sentence kept.
 *
 * `mapErrorResponse` only carries a message for a 400, because every other status has fixed
 * client-side copy elsewhere. That is exactly wrong here: the interesting calendar failures are
 * execution failures — 501 "no live connector handles…", 502 "gog: token expired" — and the
 * message is the entire diagnosis. Without it the operator gets "Could not save that event" and
 * has nothing to act on.
 */
function calendarFailure(
  response: Response,
  body: unknown,
): { kind: AuthErrorKind; retryAfterSeconds?: number; message?: string } {
  const mapped = mapErrorResponse(response, body, { weakOn400: false });
  if (mapped.message) {
    return mapped;
  }
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message.trim()
    ? { ...mapped, message: message.trim() }
    : mapped;
}

async function calendarWrite(
  path: string,
  body: Record<string, unknown>,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<CalendarActionResult>> {
  const result = await authedJson(baseUrl, path, "POST", sessionToken, body);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: (result.body ?? {}) as CalendarActionResult };
}

export async function fetchMemberResource(
  path: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, path, "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

/** Lists the conferences an admin has made searchable, with how fresh each index is. */
export async function fetchVenueSources(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/venue-papers/sources", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

/**
 * Ranks one conference's accepted papers against what the member says they work on.
 *
 * Carries the service's own sentence up for every failure, not just 400: "that conference has not
 * been indexed yet" (409) and "the embedding model is not reachable" (502) are both things the
 * reader can act on, and the generic copy would throw them away.
 */
export async function searchVenuePapers(
  params: { venueId: string; interests: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/venue-papers/search", "POST", sessionToken, {
    venue_id: params.venueId,
    interests: params.interests,
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    const message = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return { ok: false, kind: "auth-failed", message: message.trim() };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

/** Rebuilds every configured conference index (POST /venue-papers/index). Admin only. */
export async function rebuildVenueIndexes(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/venue-papers/index", "POST", sessionToken, {});
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    const message = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return { ok: false, kind: "auth-failed", message: message.trim() };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

/**
 * Runs the CV digest job (POST /cv/publish-digest): scan every linked CV, then rewrite the CV
 * Updates doc from the whole change ledger.
 *
 * Privileged server-side like the scan it wraps. 503 comes back when the service has no document
 * configured, which is a deployment gap rather than a permission problem, so it is mapped through
 * the same error path and shown with the service's own message.
 */
export async function publishCvDigest(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/cv/publish-digest", "POST", sessionToken, {});
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    // 502 (Google refused the write) and 503 (no document configured) both carry a sentence the
    // operator needs -- a missing env var, a locked gog keyring -- and mapErrorResponse only
    // preserves messages on 400. Lifted here so the button can say what actually went wrong.
    const message = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return { ok: false, kind: "auth-failed", message: message.trim() };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

// Creates or edits a paper over the member's own session (PUT /papers/:id). Papers are written on
// the member Bearer rather than the gateway tool path because the service decides there what a
// plain member may touch -- their own submissions, without the governance fields -- and because a
// member's paired device holds read-only gateway scopes, so `tools.invoke` is not open to them.
export async function saveOwnPaper(
  paperId: string,
  body: Record<string, unknown>,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}`,
    "PUT",
    sessionToken,
    body,
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
  return { ok: true, value: result.body };
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
// The service only answers this for an admin member session, so 403
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

// Tracks which members have explicitly acknowledged the onboarding checklist (the dashboard's
// standing warning card), so it keeps showing on every login/reload until they click "I have
// read this" -- unlike step completion, which is per-step and does not dismiss the card.
function loadAcknowledgedOnboardingMemberIds(): Set<string> {
  const storage = getSafeLocalStorage();
  try {
    const raw = storage?.getItem(ONBOARDING_ACKNOWLEDGED_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function hasAcknowledgedOnboardingChecklist(memberId: string): boolean {
  return loadAcknowledgedOnboardingMemberIds().has(memberId);
}

export function markOnboardingChecklistAcknowledged(memberId: string): void {
  const storage = getSafeLocalStorage();
  try {
    const acknowledged = loadAcknowledgedOnboardingMemberIds();
    acknowledged.add(memberId);
    storage?.setItem(ONBOARDING_ACKNOWLEDGED_STORAGE_KEY, JSON.stringify([...acknowledged]));
  } catch {
    // best-effort — quota/security failures just mean the warning card may reappear.
  }
}

// ---------------------------------------------------------------------------
// Meeting recordings
//
// One GET for the list and two admin writes. The service decides what a member is allowed to see
// (their own attendance and a headcount, never the roster), so there is nothing to redact here --
// this is only the wire.
// ---------------------------------------------------------------------------

export type MeetingAttendee = {
  member_id?: string;
  display_name: string;
  email?: string;
  joined_at?: string;
  minutes?: number;
  source: "participant_report" | "transcript" | "manual";
  present: boolean;
};

export type MeetingActionItem = {
  text: string;
  owner_member_id?: string;
  owner_name?: string;
};

export type MeetingRecord = {
  id: string;
  topic: string;
  started_at: string;
  duration_minutes?: number;
  recording: { share_url?: string; passcode?: string; drive_url?: string };
  transcript?: { processed_at: string; speaker_names: string[]; duration_seconds?: number };
  summary?: {
    overview: string;
    decisions: string[];
    action_items: MeetingActionItem[];
    generated_at: string;
    model: string;
  };
  attendees?: MeetingAttendee[];
  /** Present only on the member view; the admin view carries the roster itself. */
  attendee_count?: number;
  source: "zoom_email" | "manual";
  notes?: string;
};

export async function fetchMeetings(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MeetingRecord[]>> {
  const result = await authedJson(baseUrl, "/meetings", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { meetings?: MeetingRecord[] } | null;
  return { ok: true, value: body?.meetings ?? [] };
}

export async function saveMeetingAttendance(
  meetingId: string,
  attendees: MeetingAttendee[],
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MeetingRecord>> {
  const result = await authedJson(
    baseUrl,
    `/meetings/${encodeURIComponent(meetingId)}/attendance`,
    "PUT",
    sessionToken,
    { attendees },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as MeetingRecord };
}

export async function createMeeting(
  meeting: {
    id: string;
    topic: string;
    started_at: string;
    recording: { share_url?: string; passcode?: string; drive_url?: string };
  },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MeetingRecord>> {
  const result = await authedJson(baseUrl, "/meetings", "POST", sessionToken, meeting);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as MeetingRecord };
}

// ---------------------------------------------------------------------------
// Attendance nudges, and the notifications they leave behind
//
// Two audiences, two calls each. An admin previews who has missed the last two group meetings and
// then sends; a member reads what the lab has told them and marks it read. The member's half is
// strictly own-scope -- the service takes the member id from the session, so there is no parameter
// here that could ask for somebody else's.
// ---------------------------------------------------------------------------

export type MeetingAbsence = {
  member_id: string;
  name: string;
  missed_meeting_ids: string[];
  missed_topics: string[];
  reason: "invite" | "full_member";
};

export type MeetingAttendanceNudgePreview = {
  streak: number;
  meeting_label: string;
  meetings: Array<{ id: string; topic: string; started_at: string }>;
  absent: MeetingAbsence[];
  /** False when the calendar could not be read, so the audience is the roster's full members alone. */
  invite_resolved: boolean;
  audience_size: number;
};

export type MeetingAttendanceNudgeResult = {
  notified: string[];
  already_told: string[];
  slack_skipped: Array<{ member_id: string; reason: string }>;
  invite_resolved: boolean;
};

export async function fetchMeetingAttendanceNudges(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MeetingAttendanceNudgePreview>> {
  const result = await authedJson(baseUrl, "/meetings/attendance-nudges", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as MeetingAttendanceNudgePreview };
}

export async function sendMeetingAttendanceNudges(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MeetingAttendanceNudgeResult>> {
  const result = await authedJson(baseUrl, "/meetings/attendance-nudges", "POST", sessionToken, {});
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as MeetingAttendanceNudgeResult };
}

export type MemberNotification = {
  id: string;
  member_id: string;
  kind: "meeting_attendance";
  title: string;
  body: string;
  /** A Control UI tab id. Validated against the Tab union where it is used, never trusted as one here. */
  tab?: string;
  created_at: string;
  read_at?: string;
};

export async function fetchNotifications(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MemberNotification[]>> {
  const result = await authedJson(baseUrl, "/notifications", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { notifications?: MemberNotification[] } | null;
  return { ok: true, value: body?.notifications ?? [] };
}

/** No ids marks every unread one read, which is what "dismiss all" on the popup stack means. */
export async function markNotificationsRead(
  sessionToken: string,
  baseUrl: string,
  notificationIds?: readonly string[],
): Promise<AuthResult<{ read: number }>> {
  const result = await authedJson(
    baseUrl,
    "/notifications/read",
    "POST",
    sessionToken,
    notificationIds?.length ? { notification_ids: [...notificationIds] } : {},
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as { read: number } };
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

// ---------------------------------------------------------------------------
// Logistics requests
//
// The wire for the request templates: submit one, read the ones you are allowed to read, open a
// single one in full, and -- for an admin -- say what the lab has done about it.
//
// Who may read what is the service's decision, not this file's. The same GET returns one member's
// own requests and an admin's whole queue, so there is nothing to filter here and no bug in this
// module can show a member somebody else's letter deadlines.
// ---------------------------------------------------------------------------

export type LogisticsRequestKind = "document_signature" | "recommendation_letters" | "book_meeting";

export type LogisticsRequestStatus =
  | "submitted"
  | "in_progress"
  | "completed"
  | "declined"
  | "withdrawn";

/**
 * A file on a request.
 *
 * `data_base64` is present only on the read that opens one request -- the list carries names and
 * sizes -- and is gone for good once the request is settled and the service drops its files.
 */
export type LogisticsAttachment = {
  name: string;
  size: number;
  content_type?: string;
  data_base64?: string;
};

export type LogisticsSchool = {
  school: string;
  application_deadline?: string;
  application_deadline_time?: string;
  letter_deadline?: string;
  letter_deadline_time?: string;
  deadline_timezone?: string;
  application_status?: string;
  letter_status?: string;
  program?: string;
  program_link?: string;
  notes?: string;
};

export type LogisticsFact = { project: string; contribution: string };

export type LogisticsMeeting = {
  purpose: string;
  preferred_time?: string;
  timezone?: string;
  length_minutes?: number;
  submitted_at?: string;
};

export type LogisticsRequestInput = {
  kind: LogisticsRequestKind;
  documents?: LogisticsAttachment[];
  description?: string;
  attachments?: LogisticsAttachment[];
  schools?: LogisticsSchool[];
  facts?: LogisticsFact[];
  cv_overleaf_url?: string;
  drive_folder_url?: string;
  meetings?: LogisticsMeeting[];
};

export type LogisticsRequest = LogisticsRequestInput & {
  id: string;
  member_id: string;
  member_name: string;
  status: LogisticsRequestStatus;
  submitted_at: string;
  updated_at: string;
  /** RFC3339 instant of the soonest thing the request is working towards. Derived by the service. */
  deadline_at?: string;
  /** The signed copy the lab sent back, and where it went. Bytes are dropped with the rest. */
  signed_documents?: LogisticsAttachment[];
  signed_sent_at?: string;
  signed_sent_to?: string;
  /** When the stored file bytes were dropped, so "never had one" reads differently from "gone". */
  files_cleared_at?: string;
  resolution_note?: string;
  decided_by?: string;
  decided_at?: string;
};

export async function fetchLogisticsRequests(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LogisticsRequest[]>> {
  const result = await authedJson(baseUrl, "/logistics/requests", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { requests?: LogisticsRequest[] } | null;
  return { ok: true, value: body?.requests ?? [] };
}

/** One request with its file bytes -- the only read that carries them. */
export async function fetchLogisticsRequest(
  requestId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LogisticsRequest>> {
  const result = await authedJson(
    baseUrl,
    `/logistics/requests/${encodeURIComponent(requestId)}`,
    "GET",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as LogisticsRequest };
}

export async function submitLogisticsRequest(
  input: LogisticsRequestInput,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LogisticsRequest>> {
  const result = await authedJson(baseUrl, "/logistics/requests", "POST", sessionToken, input);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as LogisticsRequest };
}

/** Replaces the content of a request nobody has picked up yet. The service refuses the rest. */
export async function updateLogisticsRequest(
  requestId: string,
  input: LogisticsRequestInput,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LogisticsRequest>> {
  const result = await authedJson(
    baseUrl,
    `/logistics/requests/${encodeURIComponent(requestId)}`,
    "PUT",
    sessionToken,
    input,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as LogisticsRequest };
}

export async function withdrawLogisticsRequest(
  requestId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LogisticsRequest>> {
  const result = await authedJson(
    baseUrl,
    `/logistics/requests/${encodeURIComponent(requestId)}/withdraw`,
    "POST",
    sessionToken,
    {},
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as LogisticsRequest };
}

/** Admin-only; the service enforces it and refuses "withdrawn" here whoever asks. */
export async function setLogisticsRequestStatus(
  requestId: string,
  status: LogisticsRequestStatus,
  note: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LogisticsRequest>> {
  const result = await authedJson(
    baseUrl,
    `/logistics/requests/${encodeURIComponent(requestId)}/status`,
    "PUT",
    sessionToken,
    { status, ...(note.trim() ? { resolution_note: note.trim() } : {}) },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as LogisticsRequest };
}

/**
 * Returns the signed document to the member who asked for it.
 *
 * One call closes the request out: the service mails the file, marks the request completed and
 * drops every stored copy. Admin-only, and the recipient is not ours to choose -- the service reads
 * it off the roster.
 */
export async function sendSignedLogisticsDocuments(
  requestId: string,
  documents: LogisticsAttachment[],
  note: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LogisticsRequest>> {
  const result = await authedJson(
    baseUrl,
    `/logistics/requests/${encodeURIComponent(requestId)}/signed`,
    "POST",
    sessionToken,
    { documents, ...(note.trim() ? { resolution_note: note.trim() } : {}) },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as LogisticsRequest };
}

// ---------------------------------------------------------------------------
// Profile overview
//
// How far along each member's own record is: the mandatory profile fields they have filled in, and
// whether they have used the Time Availability page to say when they are working. Admin-only; the
// service enforces it, because this is everybody's completeness at once rather than your own.
// ---------------------------------------------------------------------------

export type MemberTimelineCounts = {
  availability: number;
  time_off: number;
  milestones: number;
  trips: number;
  total: number;
};

export type MemberProfileOverviewRow = {
  id: string;
  name: string;
  status?: string;
  privilege_level: string;
  missing_fields: string[];
  filled_field_count: number;
  timeline: MemberTimelineCounts;
  last_reminded_at?: string;
  /**
   * Of `filled_field_count`, how many the member typed themselves rather than an admin or the
   * spreadsheet importer. This is the adoption number: a row can be 12/12 complete and 0/12 adopted.
   */
  self_filled_field_count: number;
  /** Their papers, and how many carry a weekly update they wrote themselves. */
  projects: { total: number; self_updated: number };
  /** Last successful sign-in. Absent means never. */
  last_login_at?: string;
  /** When any hand last wrote to the record. */
  updated_at?: string;
  /** When this member last changed anything themselves. Absent means they never have. */
  last_self_edit_at?: string;
};

/** The lab-wide roll-up, so the page leads with one number instead of asking an admin to add up 77 rows. */
export type MemberAdoptionSummary = {
  members: number;
  /** 0..1, over every mandatory field of every member -- not an average of per-member percentages. */
  profile_rate: number;
  project_rate: number;
  signed_in_ever: number;
};

export type MemberProfileOverview = {
  members: MemberProfileOverviewRow[];
  adoption: MemberAdoptionSummary;
  /**
   * How many fields count toward "complete".
   *
   * Taken from the service rather than counted here: it does not check `name` (a member cannot be
   * created without one), so a client counting the field list itself would show everybody one
   * short forever.
   */
  mandatoryFieldCount: number;
};

export async function fetchMemberProfileOverview(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MemberProfileOverview>> {
  const result = await authedJson(baseUrl, "/members/profile-overview", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as {
    members?: MemberProfileOverviewRow[];
    mandatory_field_count?: number;
    adoption?: MemberAdoptionSummary;
  } | null;
  return {
    ok: true,
    value: {
      members: body?.members ?? [],
      mandatoryFieldCount: body?.mandatory_field_count ?? 0,
      // Zeroed rather than optional: the page renders a percentage either way, and an older service
      // that does not send this should read as "nothing adopted yet" rather than blank the card.
      adoption: body?.adoption ?? {
        members: body?.members?.length ?? 0,
        profile_rate: 0,
        project_rate: 0,
        signed_in_ever: 0,
      },
    },
  };
}

// --- Paper evidence slots ---
//
// The tall table behind My Projects & Papers: one row per artifact per paper. The registry that
// says what each slot is called and what shape it accepts is imported straight from the service's
// contracts module (see views/paper-slots.ts), so this file only moves records, never rules.

export type PaperSlotOverviewRow = {
  paper_id: string;
  title: string;
  venue?: string;
  deadline?: string;
  current_step: string;
  provided_count: number;
  required_count: number;
  dormant: boolean;
  closed: boolean;
  missing_slots: string[];
  missing_acceptance_details?: string[];
  /** Who is travelling, counted by the service. Absent from a service older than this field. */
  attendance?: { yes: number; no: number; unknown: number; going?: string[] };
  cycle_closed?: boolean;
  escalating: boolean;
  first_author_member_id?: string;
  last_nudged_at?: string;
};

/** Every paper's outstanding evidence, computed by the service on read. */
export async function fetchPaperSlotOverview(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<PaperSlotOverviewRow[]>> {
  const result = await authedJson(baseUrl, "/papers/slot-overview", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { papers?: PaperSlotOverviewRow[] } | null;
  return { ok: true, value: body?.papers ?? [] };
}

export type PaperSlotRow = {
  paper_id: string;
  slot: string;
  status: "missing" | "provided" | "invalid" | "waived";
  url?: string;
  /** Absent, not blank, when the reader is not entitled to a credential slot. */
  value_text?: string;
  /** The free-text half of an enum slot. */
  value_note?: string;
  provided_at?: string;
  invalid_reason?: string;
  waived_reason?: string;
};

/**
 * One rung of the venue ladder, as the card draws it.
 *
 * There is no save path for these on purpose: the only thing that closes a rung is the mail
 * arriving in the bot mailbox. Mirrors AdminBotPaperflowStageView in the service.
 */
export type PaperflowStageRow = {
  stage: string;
  label: string;
  node: string;
  state: "closed" | "waiting" | "upcoming";
  closed_at?: string;
  closed_by_subject?: string;
  closed_by?: "email_bcc" | "admin";
};

export type PaperSocialDraft = {
  id: string;
  paper_id: string;
  platform: "x" | "linkedin";
  body: string;
  model?: string;
  generated_at: string;
  status: "draft" | "circulated" | "approved" | "superseded";
};

export type PaperSocialConsent = {
  draft_id: string;
  member_id: string;
  decision: "pending" | "ok" | "changes_requested";
  comment?: string;
  asked_at: string;
  decided_at?: string;
};

export type PaperAttendee = {
  paper_id: string;
  attendee_key: string;
  member_id?: string;
  name: string;
  attending: "yes" | "no" | "unknown";
  confirmed_at?: string;
};

export type PaperReimbursement = {
  paper_id: string;
  member_id: string;
  status: "not_applicable" | "pending" | "submitted" | "reimbursed";
  submitted_at?: string;
  completed_at?: string;
};

/** Everything one card needs: the checklist plus the lists that hang off the paper. */
/** One author's account of their own week on one paper. */
export type PaperWeeklyUpdate = {
  paper_id: string;
  member_id: string;
  week_start: string;
  body: string;
  created_at: string;
  updated_at: string;
};

export type PaperCycle = {
  slots: PaperSlotRow[];
  drafts: PaperSocialDraft[];
  consents: PaperSocialConsent[];
  attendees: PaperAttendee[];
  reimbursements: PaperReimbursement[];
  /** The venue ladder. Read-only: closed by a bcc, never by a control on this card. */
  stages: PaperflowStageRow[];
  /** The weekly log, newest week first. Written by each author about themselves. */
  weeklyUpdates: PaperWeeklyUpdate[];
  cycleClosed: boolean;
  missingAcceptanceDetails: string[];
};

/** One paper's slots and venue ladder, blanks included -- the card renders the whole cycle. */
export async function fetchPaperSlots(
  paperId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<PaperCycle>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}/slots`,
    "GET",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as {
    slots?: PaperSlotRow[];
    drafts?: PaperSocialDraft[];
    consents?: PaperSocialConsent[];
    attendees?: PaperAttendee[];
    reimbursements?: PaperReimbursement[];
    paperflow_stages?: PaperflowStageRow[];
    weekly_updates?: PaperWeeklyUpdate[];
    cycle_closed?: boolean;
    missing_acceptance_details?: string[];
  } | null;
  return {
    ok: true,
    value: {
      slots: body?.slots ?? [],
      drafts: body?.drafts ?? [],
      consents: body?.consents ?? [],
      attendees: body?.attendees ?? [],
      reimbursements: body?.reimbursements ?? [],
      stages: body?.paperflow_stages ?? [],
      weeklyUpdates: body?.weekly_updates ?? [],
      cycleClosed: Boolean(body?.cycle_closed),
      missingAcceptanceDetails: body?.missing_acceptance_details ?? [],
    },
  };
}

/** Save a social draft. Supersedes whatever it replaces, server-side. */
export async function savePaperSocialDraft(
  paperId: string,
  input: { platform: string; body: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<PaperSocialDraft>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}/social-drafts`,
    "POST",
    sessionToken,
    input,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const body = result.body as { draft?: PaperSocialDraft } | null;
  return body?.draft
    ? { ok: true, value: body.draft }
    : { ok: false, kind: "auth-failed", message: "the service returned no draft" };
}

/** Ask the paper's lab-member authors to sign off on a draft. */
export async function circulatePaperSocialDraft(
  draftId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(
    baseUrl,
    `/papers/social-drafts/${encodeURIComponent(draftId)}/circulate`,
    "POST",
    sessionToken,
    {},
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

/** The signed-in member's own answer on a draft. The service takes the id from the session. */
export async function recordPaperSocialConsent(
  draftId: string,
  input: { decision: string; comment?: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(
    baseUrl,
    `/papers/social-drafts/${encodeURIComponent(draftId)}/consent`,
    "POST",
    sessionToken,
    input,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

export async function savePaperAttendee(
  paperId: string,
  input: { name: string; member_id?: string; attending: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}/attendees`,
    "PUT",
    sessionToken,
    input,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

export async function savePaperReimbursementStatus(
  paperId: string,
  memberId: string,
  status: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}/reimbursements/${encodeURIComponent(memberId)}`,
    "PUT",
    sessionToken,
    { status },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

/**
 * Write one slot.
 *
 * The service derives `status` from the value, so this sends the value and nothing else -- there
 * is deliberately no way for the browser to declare an artifact provided.
 */
export async function savePaperSlot(
  paperId: string,
  slot: string,
  input: { url?: string; value_text?: string; value_note?: string; done?: boolean },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<PaperSlotRow>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}/slots/${encodeURIComponent(slot)}`,
    "PUT",
    sessionToken,
    input,
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
  const body = result.body as { slot?: PaperSlotRow } | null;
  return body?.slot
    ? { ok: true, value: body.slot }
    : { ok: false, kind: "auth-failed", message: "the service returned no slot" };
}

export type PaperNudgeBatch = {
  member_id: string;
  member_name: string;
  /** False when there is no Slack id on file. The preview says so before anything is sent. */
  deliverable: boolean;
  item_count: number;
  paper_titles: string[];
  /** The composed message, exactly as it would arrive. */
  message: string;
};

/**
 * What would go out if the button were pressed right now.
 *
 * The same computation the send runs, returned instead of delivered -- so the preview is the send,
 * looked at rather than performed.
 */
export async function fetchPaperNudgeBatches(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<PaperNudgeBatch[]>> {
  const result = await authedJson(baseUrl, "/papers/nudge-batches", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { batches?: PaperNudgeBatch[] } | null;
  return { ok: true, value: body?.batches ?? [] };
}

/**
 * Sends the batches. Recipients and text are server-computed, never ours.
 *
 * `recipientIds` narrows the send to the people an admin ticked in the preview; the service still
 * recomputes the batches, so the list only ever subtracts.
 */
export async function runPaperSlotReminder(
  sessionToken: string,
  baseUrl: string,
  recipientIds?: string[],
): Promise<AuthResult<{ created: number; skipped: number }>> {
  const result = await authedJson(baseUrl, "/papers/slot-reminder/run", "POST", sessionToken, {
    ...(recipientIds?.length ? { recipient_member_ids: recipientIds } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { created?: unknown[]; skipped?: unknown[] } | null;
  return {
    ok: true,
    value: { created: body?.created?.length ?? 0, skipped: body?.skipped?.length ?? 0 },
  };
}

/** Runs the daily mandatory-fields reminder now. Recipients are server-computed, never ours. */
export async function runMandatoryFieldsReminder(
  sessionToken: string,
  baseUrl: string,
  /**
   * Narrows the sweep to one gap and one set of people -- what the Profile Overview filter is
   * showing. Omitted, the service chases both gaps across everyone owed a reminder, which is what
   * the daily cron does.
   */
  scope?: { include: "profile" | "timeline" | "both"; memberIds: string[] },
): Promise<AuthResult<{ created: number; skipped: number }>> {
  const result = await authedJson(
    baseUrl,
    "/members/mandatory-fields-reminder/run",
    "POST",
    sessionToken,
    {
      ...(scope ? { include: scope.include } : {}),
      ...(scope?.memberIds.length ? { recipient_member_ids: scope.memberIds } : {}),
    },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { created?: unknown[]; skipped?: unknown[] } | null;
  return {
    ok: true,
    value: { created: body?.created?.length ?? 0, skipped: body?.skipped?.length ?? 0 },
  };
}

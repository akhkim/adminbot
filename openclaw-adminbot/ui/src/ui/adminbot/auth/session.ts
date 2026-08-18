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
export type MemberScheduleUpdate = {
  availability?: MemberAvailabilityRow[];
  time_off?: MemberTimeOffRow[];
  milestones?: MemberMilestoneRow[];
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
};

export type OnboardingGuideResult = {
  template_id: string;
  subject: string;
  body: string;
  sent: boolean;
  drive_folder_link?: string;
  slack_connect_link?: string;
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

// Runs the admin CV scan (POST /cv/scan) over the member's own session. Privileged server-side,
// so a non-admin session gets `forbidden` back rather than an empty result -- the panel is
// already admin-gated, and this keeps the two from disagreeing if that ever drifts.
export async function scanMemberCvs(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/cv/scan", "POST", sessionToken, {});
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

/** Reads recorded CV changes since a date (GET /cv/digest). */
export async function fetchCvDigest(
  since: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(
    baseUrl,
    `/cv/digest?since=${encodeURIComponent(since)}`,
    "GET",
    sessionToken,
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

/** Drafts one member's newsletter introduction (POST /cv/blurb/:id). */
export async function draftMemberCvBlurb(
  memberId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(
    baseUrl,
    `/cv/blurb/${encodeURIComponent(memberId)}`,
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
    // 409 means the member has simply never been scanned; the message says so and is worth
    // surfacing verbatim rather than flattening into a generic failure.
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: true }) };
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

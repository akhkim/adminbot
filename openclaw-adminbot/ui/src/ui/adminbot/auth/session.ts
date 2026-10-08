// Control UI module implements per-member AdminBot email+password auth.
//
// Talks to the standalone AdminBot service (default `http://<host>:8765`).
// The AdminBot session token is revocable/expiring and MAY live in
// localStorage; the gateway token it returns is a secret that must only flow
// through the existing sessionStorage-scoped token plumbing via applySettings.
import { getSafeLocalStorage } from "../../../local-storage.ts";
import type { UiSettings } from "../../storage.ts";
import { normalizeOptionalString } from "../../string-coerce.ts";
import { parseApiJson, readApiJson } from "../data/api-json.ts";
import type { AvailabilityRow, TimeOffRow } from "../data/availability.js";
import { configureDraftSync } from "../offline/draft-sync.ts";
import {
  forgetRead,
  forgetReadsInFlight,
  forgetSessionReads,
  rememberRead,
  rememberedRead,
  sharedRead,
} from "./read-cache.ts";
import { type AdminBotOfflineScope, pendingAdminBotOutboxCount } from "../offline/outbox.ts";
import {
  confirmOwnRead,
  forgetOfflineReads,
  keepOwnRead,
  type OwnReadContext,
  ownReadContext,
  resolveOfflineScope,
  storedOwnRead,
} from "./offline-reads.ts";
import { isOfflineReadPath, readOfflineRead, storeOfflineRead } from "../offline/read-store.ts";

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

// A member's onboarding checklist, with its text attached from the service's catalog (see the
// AdminBot service's `onboarding.ts`). `steps` is the whole of it: what is done, left or current is
// a filter over each step's `status`.
export type MemberOnboarding = {
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

export type AssignedBadge = {
  member_id: string;
  badge_id: string;
  family_key: string;
  awarded_at: string;
  awarded_by: string;
  source: "admin" | "nomination" | "self_report";
  count?: number;
  follower_count?: number;
  nomination_id?: string;
  evidence?: string;
  category: string;
  name: string;
  description: string;
  criteria_url?: string;
  tier?: string;
  sort_order: number;
};

export type BadgeNominationStatus = "pending" | "approved" | "rejected";

/** What a member fills in to propose a badge the catalogue does not have. */
export type BadgeSuggestionInput = {
  category: string;
  name: string;
  description: string;
  criteria_url?: string;
  tier?: string;
  rationale: string;
};

export type BadgeSuggestionStatus = "pending" | "approved" | "rejected";

export type BadgeSuggestionView = BadgeSuggestionInput & {
  id: string;
  /** Absent once the suggester has been purged from the roster. */
  suggested_by?: string;
  suggested_by_name?: string;
  status: BadgeSuggestionStatus;
  created_at: string;
  decided_at?: string;
  decided_by?: string;
  /** The badge it became, on an approval. */
  created_badge_id?: string;
};

export type BadgeNominationView = {
  id: string;
  badge_id: string;
  family_key: string;
  /** Who the badge would go to, which is not always who asked for it. */
  member_id: string;
  /** Who put it forward, absent when the member put it forward themselves. */
  nominated_by?: string;
  evidence?: string;
  status: BadgeNominationStatus;
  created_at: string;
  decided_at?: string;
  decided_by?: string;
  badge_category: string;
  badge_name: string;
  badge_description: string;
  badge_tier?: string;
  badge_criteria_url?: string;
  member_name?: string;
  nominator_name?: string;
};

/**
 * What a Member Type change on the Lab Members tab did, step by step. Mirrors the service's
 * `MemberTypeChangeResult` (extensions/adminbot/src/api/server.member-type-change.ts).
 */
export type MemberTypeChangeSummary = {
  from?: string;
  to?: string;
  privilege_level: { from: string; to: string };
  collaborator_subgroup: { from?: string; to?: string };
  steps: Array<{
    step: "sheet" | "slack" | "group_meeting" | "lab_calendar" | "alumni_mail" | "meeting";
    target?: string;
    /** `queued`: filed in Pending Actions because nobody approved it on the spot. */
    status: "done" | "queued" | "skipped" | "failed";
    detail?: string;
    proposal_id?: string;
  }>;
};

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
  intake_form_unavailable?: boolean;
  arr_reviewer_qualified?: boolean | null;
  arr_review_capacity?: number | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  twitter_followers?: number;
  linkedin_followers?: number;
  github_url?: string | null;
  scholar_url?: string | null;
  avatar_url?: string | null;
  profile_photo_review?: ProfilePhotoReviewState | null;
  notes?: string | null;
  onboarding?: MemberOnboarding | null;
  assigned_badges?: AssignedBadge[] | null;
  [key: string]: unknown;
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
};

// The admin behind a "view as" session. Present on GET /auth/session only while one is open, so
// the banner is driven by its presence rather than by the client remembering what it did.
export type MemberImpersonator = { id: string; name: string };

// Session view returned by GET /auth/session (no session_token echoed back).
export type MemberSessionInfo = {
  expires_at: string;
  member: LabMember;
  gateway?: MemberGateway;
  impersonated_by?: MemberImpersonator;
};

// Unclaimed roster entry surfaced in the claim picker (GET /auth/roster).
export type RosterMember = { id: string; name: string };

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
  | "not-found"
  | "invalid-response";

export type AuthResult<T> =
  | { ok: true; value: T; cached?: boolean }
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

// Maps AdminBot HTTP status codes onto the closed AuthErrorKind set. `weakOn400`
// distinguishes claim/signup (400 = weak password) from login (no 400 contract);
// `pendingOn403` folds login's pending-approval code out of the generic 403.
export function mapErrorResponse(
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

let lastAuthedCall:
  | { baseUrl: string; token: string | null; offlineScope?: AdminBotOfflineScope }
  | undefined;

export async function pendingQueuedAdminBotWriteCount(
  token: string,
  baseUrl: string,
): Promise<number> {
  const scope = await resolveOfflineScope(baseUrl, token);
  return scope ? pendingAdminBotOutboxCount(scope) : 0;
}

export async function flushQueuedAdminBotWrites(): Promise<{ flushed: number; remaining: number }> {
  const auth = lastAuthedCall;
  if (!auth?.offlineScope) {
    return { flushed: 0, remaining: 0 };
  }
  // Old generic outbox entries may represent approvals or non-idempotent submissions.
  // Retain them for recovery, but never execute them on reconnect. Only revisioned
  // member drafts have an automatic synchronization contract.
  return { flushed: 0, remaining: await pendingAdminBotOutboxCount(auth.offlineScope) };
}

// Bearer-authenticated POST/PUT for member-session routes. Same unreachable
// sentinel + credentials:"omit" contract as postJson.
export async function authedJson(
  baseUrl: string,
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  // Null for the handful of routes that are open to visitors (ANONYMOUS_ROUTES in the service).
  // The header is then omitted rather than sent empty: `Bearer ` with nothing after it is a
  // malformed credential, and the service would be right to treat it as one.
  token: string | null,
  payload?: unknown,
  signal?: AbortSignal,
): Promise<AuthedJsonResult> {
  if (method !== "GET") {
    // A read that started before this write may answer with the state from before it; the reload
    // the write triggers must send its own request rather than join that one.
    forgetReadsInFlight();
    return await authedJsonOnce(baseUrl, path, method, token, payload, signal);
  }
  // An abortable read belongs to its caller alone; sharing it would let one caller cancel another.
  if (signal) {
    return await authedJsonOnce(baseUrl, path, method, token, payload, signal);
  }
  return await sharedRead(token, `${baseUrl}${path}`, () =>
    authedJsonOnce(baseUrl, path, method, token, payload),
  );
}

type AuthedJsonResult =
  | { response: Response; body: unknown; fromCache?: boolean; revalidated?: boolean }
  | { unreachable: true };

async function authedJsonOnce(
  baseUrl: string,
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  token: string | null,
  payload?: unknown,
  signal?: AbortSignal,
): Promise<AuthedJsonResult> {
  const url = `${baseUrl}${path}`;
  // The member's own reads are also kept on disk (offline/read-store.ts); everything else is
  // memory-only. Decided before the request goes out so a wipe mid-flight drops the write.
  // The generation is captured synchronously here; the hash behind the scope is awaited only
  // when the request has to wait for the disk copy, so other reads go out at once.
  const ownPromise =
    method === "GET" ? ownReadContext(baseUrl, path, token, isViewingAs(token)) : undefined;
  let own: OwnReadContext | undefined;
  // The body this session last received for this URL, if the service tagged it. Sent back as
  // If-None-Match so an unchanged read costs an empty 304 instead of the whole payload again.
  // After a page refresh memory is empty; an own read then revalidates against its disk copy.
  let previous = method === "GET" ? rememberedRead(token, url) : undefined;
  let previousFromDisk: { text: string; etag: string | null } | undefined;
  if (method === "GET" && !previous && isOfflineReadPath(path)) {
    own = await ownPromise;
    previousFromDisk = own ? await storedOwnRead(own) : undefined;
    if (previousFromDisk?.etag) {
      previous = { etag: previousFromDisk.etag, text: previousFromDisk.text, url };
    }
  }
  const offlineScopePromise = resolveOfflineScope(baseUrl, token);
  const call = { baseUrl, token };
  lastAuthedCall = call;
  const offlineCopy = async () => {
    own ??= await ownPromise;
    const stored = previousFromDisk ?? (own ? await storedOwnRead(own) : undefined);
    return stored
      ? {
          response: { ok: true, status: 200 } as Response,
          body: parseApiJson(stored.text, url),
          fromCache: true as const,
        }
      : undefined;
  };
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "omit",
      ...(signal ? { signal } : {}),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(previous ? { "If-None-Match": previous.etag } : {}),
      },
      // GET and DELETE carry no body; every other member-session call sends JSON. A DELETE with
      // a JSON body is legal but pointless here, and some proxies drop it.
      ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(payload) }),
    });
  } catch {
    return (method === "GET" ? await offlineCopy() : undefined) ?? { unreachable: true };
  }
  own ??= await ownPromise;
  const offlineScope = await offlineScopePromise;
  if (lastAuthedCall === call && offlineScope) lastAuthedCall = { ...call, offlineScope };
  if (token && response.status === 401) {
    // The session is gone (expired or revoked); so is anything kept for it. A late 401 for a
    // token already replaced must not take the current session's copies with it.
    const current = loadStoredMemberSession()?.sessionToken;
    forgetOfflineReads(current && current !== token ? current : null);
  }
  if (previous && response.status === 304) {
    if (previousFromDisk) {
      rememberRead(token, url, previous);
      if (own) confirmOwnRead(own, previousFromDisk);
    }
    // Re-parsed from the kept text rather than handed back as the object a caller already holds,
    // so a view that patched its copy in place cannot leak that edit into the next read.
    return {
      response: { ok: true, status: 200, headers: response.headers, url: previous.url } as Response,
      body: parseApiJson(previous.text, previous.url),
      revalidated: true,
    };
  }
  let text = "";
  try {
    text = await response.text();
  } catch {
    // An unreadable body parses as null below, as readApiJson always reported it.
  }
  const body = parseApiJson(text, response.url);
  if (method === "GET") {
    const etag = response.status === 200 ? response.headers?.get?.("etag") : null;
    if (etag) {
      rememberRead(token, url, { etag, text, url: response.url });
    } else {
      forgetRead(token, url);
    }
    if (own && response.ok) {
      keepOwnRead(own, text, etag ?? null);
    }
  }
  const serviceMessage = (body as { error?: { message?: unknown } } | null)?.error?.message;
  if (
    method === "GET" &&
    [502, 503, 504].includes(response.status) &&
    typeof serviceMessage !== "string"
  ) {
    const cached = await offlineCopy();
    if (cached) {
      return cached;
    }
  }
  return { response, body };
}

// A View-as session belongs to the member being viewed; nothing of theirs is kept on the
// admin's device.
function isViewingAs(token: string | null): boolean {
  const stored = loadStoredMemberSession();
  return Boolean(token && stored?.impersonator && stored.sessionToken === token);
}

/**
 * A request to add somebody to the roster, as GET /lab/members/requests returns it. Mirrors
 * `AdminBotMemberRequest` (extensions/adminbot/src/contracts/member-requests.ts) plus the two
 * fields the route adds for the reader.
 */
export type MemberRequestView = {
  id: string;
  status: "pending" | "approved" | "rejected";
  requested_by: string;
  requested_by_name?: string;
  profile: {
    name: string;
    email: string;
    member_type?: string;
    affiliation?: string;
    research_topics?: string;
    personal_website?: string;
  };
  meetings?: string[];
  note?: string;
  created_at: string;
  updated_at?: string;
  decided_at?: string;
  decided_by?: string;
  decision_note?: string;
  member_id?: string;
  /** The access level approving would grant, worked out from the requested Member Type. */
  access_level?: string;
};

export type MemberRequestInput = MemberRequestView["profile"] & { note?: string };

/**
 * One call to /lab/members/requests. Every refusal the service makes here names the problem --
 * "already on the roster", "already waiting for review", "this request was already approved" --
 * so its sentence is passed through whatever the status, as queueMemberOnboardingGuide does.
 */
async function memberRequestCall<T>(
  baseUrl: string,
  path: string,
  method: "GET" | "POST" | "DELETE",
  sessionToken: string,
  body?: unknown,
): Promise<AuthResult<T>> {
  const result = await authedJson(
    baseUrl,
    `/lab/members/requests${path}`,
    method,
    sessionToken,
    body,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    const refusal = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    const message = typeof refusal === "string" && refusal.trim() ? refusal.trim() : undefined;
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden", ...(message ? { message } : {}) };
    }
    return {
      ok: false,
      ...mapErrorResponse(result.response, result.body, { weakOn400: false }),
      ...(message ? { message } : {}),
    };
  }
  return { ok: true, value: result.body as T };
}

export async function fetchMemberRequests(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MemberRequestView[]>> {
  const result = await memberRequestCall<{ requests?: MemberRequestView[] }>(
    baseUrl,
    "",
    "GET",
    sessionToken,
  );
  return result.ok
    ? { ok: true, value: Array.isArray(result.value.requests) ? result.value.requests : [] }
    : result;
}

export async function submitMemberRequest(
  input: MemberRequestInput,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ request: MemberRequestView }>> {
  return await memberRequestCall(baseUrl, "", "POST", sessionToken, input);
}

export async function editMemberRequest(
  request: MemberRequestView,
  input: MemberRequestInput,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ request: MemberRequestView }>> {
  return await memberRequestCall(
    baseUrl,
    `/${encodeURIComponent(request.id)}/edit`,
    "POST",
    sessionToken,
    { ...input, expected_updated_at: request.updated_at ?? request.created_at },
  );
}

export async function approveMemberRequest(
  requestId: string,
  sessionToken: string,
  baseUrl: string,
  expectedUpdatedAt?: string,
): Promise<AuthResult<{ request: MemberRequestView; member: LabMember }>> {
  return await memberRequestCall(
    baseUrl,
    `/${encodeURIComponent(requestId)}/approve`,
    "POST",
    sessionToken,
    { expected_updated_at: expectedUpdatedAt },
  );
}

export async function rejectMemberRequest(
  requestId: string,
  note: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ request: MemberRequestView }>> {
  return await memberRequestCall(
    baseUrl,
    `/${encodeURIComponent(requestId)}/reject`,
    "POST",
    sessionToken,
    note ? { note } : {},
  );
}

export async function withdrawMemberRequest(
  requestId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ withdrawn: true }>> {
  return await memberRequestCall(
    baseUrl,
    `/${encodeURIComponent(requestId)}`,
    "DELETE",
    sessionToken,
  );
}

export type MemberNudgeChannel = "slack" | "email";

export type MemberNudgeSkip = { member_id: string; reason: string };

export type MemberNudgeResult = {
  created: Array<{ id: string; status: string }>;
  skipped: MemberNudgeSkip[];
};

/**
 * The calendar routes' failures, with the service's own sentence kept.
 *
 * `mapErrorResponse` only carries a message for a 400, because every other status has fixed
 * client-side copy elsewhere. That is exactly wrong here: the interesting calendar failures are
 * execution failures — 501 "no live connector handles…", 502 "gog: token expired" — and the
 * message is the entire diagnosis. Without it the operator gets "Could not save that event" and
 * has nothing to act on.
 */
export function calendarFailure(
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
  return { ok: true, value: result.body, ...(result.fromCache ? { cached: true } : {}) };
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
  const body = await readApiJson(response);
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
  const body = await readApiJson(response);
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

async function decideBadgeNomination(
  nominationId: string,
  decision: "approve" | "reject",
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<BadgeNominationView>> {
  const result = await authedJson(
    baseUrl,
    `/badges/nominations/${encodeURIComponent(nominationId)}/${decision}`,
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
  const nomination = (result.body as { nomination?: BadgeNominationView } | null)?.nomination;
  return nomination ? { ok: true, value: nomination } : { ok: false, kind: "auth-failed" };
}

export function approveBadgeNomination(
  nominationId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<BadgeNominationView>> {
  return decideBadgeNomination(nominationId, "approve", sessionToken, baseUrl);
}

export function rejectBadgeNomination(
  nominationId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<BadgeNominationView>> {
  return decideBadgeNomination(nominationId, "reject", sessionToken, baseUrl);
}

async function decideBadgeSuggestion(
  suggestionId: string,
  decision: "approve" | "reject",
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<BadgeSuggestionView>> {
  const result = await authedJson(
    baseUrl,
    `/badges/suggestions/${encodeURIComponent(suggestionId)}/${decision}`,
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
  const suggestion = (result.body as { suggestion?: BadgeSuggestionView } | null)?.suggestion;
  return suggestion ? { ok: true, value: suggestion } : { ok: false, kind: "auth-failed" };
}

export function approveBadgeSuggestion(
  suggestionId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<BadgeSuggestionView>> {
  return decideBadgeSuggestion(suggestionId, "approve", sessionToken, baseUrl);
}

export function rejectBadgeSuggestion(
  suggestionId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<BadgeSuggestionView>> {
  return decideBadgeSuggestion(suggestionId, "reject", sessionToken, baseUrl);
}

// Public roster of unclaimed members backing the claim picker (no auth).
export async function fetchRoster(
  baseUrl: string,
  query = "",
): Promise<AuthResult<RosterMember[]>> {
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl}/auth/roster${query ? `?q=${encodeURIComponent(query)}` : ""}`,
      {
        method: "GET",
        credentials: "omit",
        headers: { Accept: "application/json" },
      },
    );
  } catch {
    return { ok: false, kind: "unreachable" };
  }
  const body = await readApiJson(response);
  if (!response.ok) {
    return { ok: false, ...mapErrorResponse(response, body, { weakOn400: false }) };
  }
  const members = (body as { members?: RosterMember[] } | null)?.members ?? [];
  return { ok: true, value: members };
}

export async function cacheOfflineMemberSession(
  token: string,
  baseUrl: string,
  session: MemberSessionInfo,
): Promise<void> {
  // A View-as session is another member's identity on the admin's device: never kept.
  const scope = isViewingAs(token) ? undefined : await resolveOfflineScope(baseUrl, token);
  if (!scope) {
    return;
  }
  // Never persist gateway credentials with the offline identity snapshot. Written now rather than
  // batched: sign-in calls this just before the session switch that wipes every other session's
  // reads, and the snapshot has to be on disk, under the new session, before that runs.
  const snapshot = JSON.stringify({
    expires_at: session.expires_at,
    member: {
      id: session.member.id,
      privilege_level: session.member.privilege_level,
      onboarding: session.member.onboarding,
    },
    gateway: { token: "" },
  });
  await storeOfflineRead(scope, "/offline-identity", snapshot, null, { immediate: true }).catch(
    () => "denied",
  );
}

export async function fetchMemberSession(
  token: string,
  baseUrl: string,
): Promise<AuthResult<MemberSessionInfo>> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/auth/session`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
      credentials: "omit",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
  } catch {
    const scope = await resolveOfflineScope(baseUrl, token);
    const stored = scope
      ? await readOfflineRead(scope, "/offline-identity").catch(() => undefined)
      : undefined;
    const cached = stored
      ? (parseApiJson(stored.text, `${baseUrl}/auth/session`) as MemberSessionInfo | null)
      : undefined;
    if (cached?.member?.id && Date.parse(cached.expires_at) > Date.now()) {
      return { ok: true, value: cached, cached: true };
    }
    return { ok: false, kind: "unreachable" };
  }
  const body = await readApiJson(response);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      // The service rejected this session: its offline snapshot and every kept read go with it.
      forgetOfflineReads();
    }
    // Only an explicit authentication rejection invalidates a stored login. Proxy outages,
    // rate limits and rolling-deploy 404s must not turn a refresh into a forced sign-in.
    if (response.status !== 401 && response.status !== 403) {
      return { ok: false, kind: "unreachable" };
    }
    return { ok: false, kind: "auth-failed" };
  }
  await cacheOfflineMemberSession(token, baseUrl, body as MemberSessionInfo);
  return { ok: true, value: body as MemberSessionInfo };
}

/**
 * Close a "view as" session. Best-effort, like logoutMember: the local swap back has to happen
 * whether or not the service is reachable, or an admin whose network blipped is stuck as somebody
 * else with no way out.
 */
export async function stopImpersonation(token: string, baseUrl: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/auth/impersonate/stop`, {
      method: "POST",
      credentials: "omit",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
  } catch {
    // Best-effort; the session expires on its own within the half hour regardless.
  }
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
  } finally {
    if (
      lastAuthedCall?.token === token &&
      lastAuthedCall.baseUrl.replace(/\/+$/u, "") === baseUrl.replace(/\/+$/u, "")
    ) {
      lastAuthedCall = undefined;
    }
  }
}

// Only non-secret fields are persisted; the gateway token is intentionally
// excluded and re-fetched from GET /auth/session on resume.
//
// `impersonator` is the admin's own session, parked here while they view the lab as somebody else.
// It has to survive a reload: an admin who refreshes the page mid-view would otherwise be left
// holding only the impersonated token, with their own account reachable again only by signing in.
export type StoredMemberSession = {
  sessionToken: string;
  expiresAt: string;
  impersonator?: { sessionToken: string; expiresAt: string };
};

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
    const parkedToken = normalizeOptionalString(parsed.impersonator?.sessionToken);
    return {
      sessionToken,
      expiresAt: normalizeOptionalString(parsed.expiresAt) ?? "",
      ...(parkedToken
        ? {
            impersonator: {
              sessionToken: parkedToken,
              expiresAt: normalizeOptionalString(parsed.impersonator?.expiresAt) ?? "",
            },
          }
        : {}),
    };
  } catch {
    return null;
  }
}

export function saveStoredMemberSession(next: StoredMemberSession): void {
  const previous = loadStoredMemberSession();
  if (previous?.sessionToken !== next.sessionToken) {
    // Sign-in, View-as and its end all arrive here with a new token; the kept reads belong to the
    // old one and would never be asked for again.
    forgetSessionReads();
  }
  if (previous?.sessionToken !== next.sessionToken || (next.impersonator && !previous?.impersonator)) {
    // The same for the copies on disk. A new session keeps only its own sign-in snapshot (written
    // just before this by applyMemberSession); a View-as keeps nothing, not even that, because
    // it is another member's data on the admin's device. Unsent drafts are untouched: they live
    // in draft-sync's own store, scoped by member rather than token, so a re-sign-in by the same
    // member still finds them and a different member never sees them. The legacy outbox is
    // untouched too: its rows are principal-scoped and never replayed, so no unsent work is lost.
    forgetOfflineReads(next.impersonator ? null : next.sessionToken);
  }
  const storage = getSafeLocalStorage();
  try {
    storage?.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        sessionToken: next.sessionToken,
        expiresAt: next.expiresAt,
        ...(next.impersonator ? { impersonator: next.impersonator } : {}),
      }),
    );
  } catch {
    // best-effort — quota/security failures must not block the in-memory session.
  }
}

export function clearStoredMemberSession(): void {
  configureDraftSync("signed-out", null);
  forgetSessionReads();
  forgetOfflineReads();
  lastAuthedCall = undefined;
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

// --- Held-email review ---

export type AdminBotEmailReviewItem = {
  message_id: string;
  thread_id: string;
  sender: string;
  subject?: string;
  category: string;
  reason?: string;
  received_at?: string;
  updated_at: string;
};

export type AdminBotEmailReviewPaperflowCandidate = {
  paper_id: string;
  title: string;
  stage: string;
  stage_label: string;
  venue?: string;
};

export type AdminBotEmailReviewData = {
  reviews: AdminBotEmailReviewItem[];
  paperflow_candidates: AdminBotEmailReviewPaperflowCandidate[];
  recent_resolutions: AdminBotResolvedEmailReviewItem[];
};

export type AdminBotEmailReviewResolution =
  | { kind: "paperflow_evidence"; paper_id: string; stage: string }
  | { kind: "dismissed" };

export type AdminBotResolvedEmailReviewItem = AdminBotEmailReviewItem & {
  resolution: AdminBotEmailReviewResolution["kind"];
  resolved_at: string;
  resolved_by: string;
  resolved_by_name?: string;
  paper_id?: string;
  paper_title?: string;
  stage?: string;
  stage_label?: string;
};

/** One row of the recent-edits feed. Mirrors AdminBotRecentUpdate in contracts/activity-log.ts. */
export type RecentUpdateRow = {
  id: string;
  at: string;
  subject: "profile" | "paper" | "paper_slot";
  source: "member" | "admin" | "import";
  actor_member_id: string;
  actor_name?: string;
  subject_member_id?: string;
  subject_member_name?: string;
  paper_id?: string;
  paper_title?: string;
  field_key?: string;
  slot_id: string;
};

export function readRecentUpdates(
  result: Awaited<ReturnType<typeof authedJson>>,
): AuthResult<RecentUpdateRow[]> {
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { updates?: RecentUpdateRow[] } | null;
  return { ok: true, value: body?.updates ?? [] };
}

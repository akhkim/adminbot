import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type {
  AdminBotAccountRegistration,
  AdminBotAuditEvent,
  AdminBotAuthSession,
  AdminBotLabMember,
  AdminBotLabMemberInput,
  AdminBotRegistrationKind,
  AdminBotRegistrationStatus,
} from "../../contracts/actions.js";
import { adminBotMemberRoles } from "../../contracts/actions.js";
import type { AdminBotServiceStore } from "../../kernel/service.js";
import { isNewObservation, latestBySource, observationFor } from "../members/location-history.js";
import { belongsOnSurface } from "../members/surface-membership.js";
import type { CalendarInviteRunner } from "../onboarding/calendar-invite.js";

// scrypt cost parameters. Serialized alongside every hash so a future cost bump can be
// detected per-credential without a migration; verify re-derives with the stored params.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/**
 * The temporary password every seeded portal account starts with.
 *
 * One constant because it appears in three places that have to agree: the seeding scripts write
 * it, the onboarding mail tells the reader to type it, and the full-member batch uses it to tell
 * "never signed in" from "has chosen their own password". A copy that drifted in any one of those
 * would lock somebody out of their own onboarding.
 */
export const ADMINBOT_SEEDED_PORTAL_PASSWORD = "jinesis";

const MIN_PASSWORD_LENGTH = 10;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TOKEN_BYTES = 32;

// Reset links are mailed, so they live long enough to survive a slow inbox but not long enough to
// sit in one as a standing credential.
const PASSWORD_RESET_TTL_MINUTES = 60;
const PASSWORD_RESET_TOKEN_BYTES = 32;

// Sliding-window brute-force guard: at most this many failures per key inside the window.
const RATE_LIMIT_MAX_FAILURES = 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const APPROVAL_EMAIL_MAX_ATTEMPTS = 3;

// A "view as" session is for answering a question, not for working in, so it expires on its own
// well before a normal session would. Short enough that a forgotten tab stops being an open door,
// long enough to walk through a member's whole view without it dying mid-click.
const IMPERSONATION_TTL_MS = 30 * 60 * 1000;

// How many members one backfill call grants. Small because each grant mails a real person: an
// admin should be able to run one batch, look at what arrived, and decide whether to continue.
const DEFAULT_CALENDAR_BACKFILL_LIMIT = 25;

export type AdminBotAuthSessionPayload = {
  session_token: string;
  expires_at: string;
  member: AdminBotLabMember;
  gateway?: { url: string };
};

// GET /auth/session view: same as the login payload minus the raw token, which is never echoed
// back once the cookie/bearer is established.
export type AdminBotAuthSessionView = {
  expires_at: string;
  member: AdminBotLabMember;
  /** Present only while an admin is viewing the lab as this member. */
  impersonated_by?: { id: string; name: string };
  gateway?: { url: string };
};

export type AdminBotMemberPrincipal = {
  kind: "member";
  member: AdminBotLabMember;
  session: AdminBotAuthSession;
  /**
   * The admin behind a "view as" session, resolved fresh on every request. Absent on a normal one.
   *
   * `member` stays the member being viewed -- reads must see what they see -- so this is the field
   * anything recording *who did it* has to consult. `principalActor` in the server is the single
   * place that decides, so route handlers do not each have to remember.
   */
  impersonator?: AdminBotLabMember;
};

// `pending_approval` lets the login route render its distinct 403 body while every other
// failure flows through the generic error shape.
export type AdminBotAuthErrorCode = "pending_approval";

export type AdminBotAuthResponse<T> =
  | { ok: true; status: number; payload: T; sessionToken?: string }
  | {
      ok: false;
      status: number;
      error: { message: string };
      retry_after_seconds?: number;
      code?: AdminBotAuthErrorCode;
    };

export type AdminBotRosterEntry = { id: string; name: string };

export type AdminBotRegistrationView = {
  id: string;
  kind: AdminBotRegistrationKind;
  email: string;
  status: AdminBotRegistrationStatus;
  created_at: string;
  member_id?: string;
  member_name?: string;
  profile?: Record<string, unknown>;
};

export type AdminBotAuthServiceOptions = {
  store: AdminBotServiceStore;
  createMember: (input: AdminBotLabMemberInput) => AdminBotLabMember;
  // Best-effort side effect fired (not awaited) when a registration is approved, granting the
  // new member's account email view access to the lab calendar. A rejection is audited but never
  // fails or delays the approval response — see approveRegistration.
  inviteToLabCalendar?: CalendarInviteRunner;
  // Best-effort side effect fired (not awaited) when a registration is approved, telling the new
  // member their account is live. Same contract as inviteToLabCalendar: audited either way, never
  // fails or delays the approval response.
  sendAccountApprovedEmail?: (params: { email: string; name?: string }) => Promise<void>;
  // Best-effort side effect fired (not awaited) when a member asks to reset their password. Same
  // contract as sendAccountApprovedEmail: audited either way, and a failure must never change the
  // response (which is identical for known and unknown addresses by design).
  sendPasswordResetEmail?: (params: {
    email: string;
    name?: string;
    token: string;
    expiresInMinutes: number;
  }) => Promise<void>;
  // Best-effort side effect fired (not awaited) when a registration is approved, filing the DCS
  // Slack-access request form on the new member's behalf. Same contract as the two above.
  // Best-effort, fired but not awaited on a successful login (see login()): resolving it can take
  // a moment and must never slow down or fail the sign-in it happened alongside.
  geolocateIp?: (
    ip: string,
  ) => Promise<
    { country?: string; continent?: string; city?: string; timezone?: string } | undefined
  >;
  gatewayUrl?: string;
  sessionTtlMs?: number;
  now?: () => Date;
};

type LoginCredentials = {
  email: string;
  password: string;
  remoteIp?: string;
};

type ClaimRequest = LoginCredentials & { member_id: string };

type SignupRequest = LoginCredentials & { profile: Record<string, unknown> };

// Only these profile fields may be set through self-service signup; everything governance-owned
// (privilege_level, status, access) is assigned at approval, never taken from the applicant.
// Mirrors SELF_PROFILE_EDITABLE_FIELDS (service-core.ts) so signups capture the
// same profile fields a member can later edit from the Lab Members table.
// Governance fields (privilege_level/status/email/access_overrides) are never
// accepted here — signup always lands as a plain "member" (signupMemberInput).
const SIGNUP_PROFILE_FIELDS = [
  "name",
  "slack_user_id",
  "role",
  "affiliation",
  "research_branch",
  "research_topics",
  "projects",
  "hours_per_week",
  "location",
  "timezone",
  "personal_website",
  "notes",
] as const;

// Case and spacing differences are the same answer, not a different one: "PhD student" typed by
// an older client is the vocabulary's "PhD Student".
function normalizeMemberRole(value: string): string | undefined {
  const needle = value.trim().toLowerCase();
  return adminBotMemberRoles.find((entry) => entry.toLowerCase() === needle);
}

const SIGNUP_STRING_ARRAY_FIELDS = new Set<string>(["research_topics", "projects"]);
const SIGNUP_NUMBER_FIELDS = new Set<string>(["hours_per_week"]);

export class AdminBotAuthService {
  private readonly store: AdminBotServiceStore;
  private readonly createMember: (input: AdminBotLabMemberInput) => AdminBotLabMember;
  private readonly inviteToLabCalendar?: CalendarInviteRunner;
  private readonly sendAccountApprovedEmail?: (params: {
    email: string;
    name?: string;
  }) => Promise<void>;
  private readonly sendPasswordResetEmail?: (params: {
    email: string;
    name?: string;
    token: string;
    expiresInMinutes: number;
  }) => Promise<void>;
  private readonly geolocateIp?: (
    ip: string,
  ) => Promise<
    { country?: string; continent?: string; city?: string; timezone?: string } | undefined
  >;
  private readonly gatewayUrl?: string;
  private readonly sessionTtlMs: number;
  private readonly now: () => Date;
  // Fixed dummy hash so verify against an unknown email costs the same scrypt work as a real
  // one; otherwise response timing would leak whether an email is on the roster.
  private readonly dummyPasswordScrypt: string;
  private readonly failuresByKey = new Map<string, number[]>();

  constructor(options: AdminBotAuthServiceOptions) {
    this.store = options.store;
    this.createMember = options.createMember;
    this.inviteToLabCalendar = options.inviteToLabCalendar;
    this.sendAccountApprovedEmail = options.sendAccountApprovedEmail;
    this.sendPasswordResetEmail = options.sendPasswordResetEmail;
    this.geolocateIp = options.geolocateIp;
    this.gatewayUrl = options.gatewayUrl?.trim() || undefined;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.dummyPasswordScrypt = hashPassword(randomBytes(16).toString("hex"));
  }

  // Register interest in an existing roster profile. Never issues a session; success only queues a
  // pending registration that an admin must approve. Every uniqueness failure returns the same
  // generic 403 so a caller cannot probe which member/email exists or is already taken.
  claim(request: ClaimRequest): AdminBotAuthResponse<{ status: "pending" }> {
    const email = request.email.trim().toLowerCase();
    const memberId = request.member_id.trim();
    const keys = rateLimitKeys(email, request.remoteIp);
    const limited = this.checkRateLimit(keys, email, request.remoteIp);
    if (limited) {
      return limited;
    }
    if (request.password.length < MIN_PASSWORD_LENGTH) {
      return authError(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const memberTaken =
      !this.store.getLabMember(memberId) ||
      this.store.getCredentialByMemberId(memberId) ||
      this.store.getPendingRegistrationByMemberId(memberId);
    const emailTaken =
      this.store.getCredentialByEmail(email) || this.store.getPendingRegistrationByEmail(email);
    if (memberTaken || emailTaken) {
      this.recordFailure(keys);
      return authError(403, "unable to claim this profile");
    }
    const registration = this.newRegistration("claim", email, request.password, {
      member_id: memberId,
    });
    this.store.saveAccountRegistration(registration);
    this.audit("auth.registration_submitted", memberId, { kind: "claim", email });
    return { ok: true, status: 200, payload: { status: "pending" } };
  }

  // Self-service application from someone not yet on the roster. Approval later mints the member.
  signup(request: SignupRequest): AdminBotAuthResponse<{ status: "pending" }> {
    const email = request.email.trim().toLowerCase();
    const keys = rateLimitKeys(email, request.remoteIp);
    const limited = this.checkRateLimit(keys, email, request.remoteIp);
    if (limited) {
      return limited;
    }
    if (request.password.length < MIN_PASSWORD_LENGTH) {
      return authError(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const profile = sanitizeSignupProfile(request.profile);
    if (!profile) {
      return authError(400, "invalid profile");
    }
    if (this.store.getCredentialByEmail(email) || this.store.getPendingRegistrationByEmail(email)) {
      this.recordFailure(keys);
      return authError(403, "unable to register");
    }
    const registration = this.newRegistration("signup", email, request.password, {
      profile_json: JSON.stringify(profile),
    });
    this.store.saveAccountRegistration(registration);
    this.audit("auth.registration_submitted", undefined, { kind: "signup", email });
    return { ok: true, status: 200, payload: { status: "pending" } };
  }

  login(request: LoginCredentials): AdminBotAuthResponse<AdminBotAuthSessionPayload> {
    const email = request.email.trim().toLowerCase();
    const keys = rateLimitKeys(email, request.remoteIp);
    const limited = this.checkRateLimit(keys, email, request.remoteIp);
    if (limited) {
      return limited;
    }
    const credential = this.store.getCredentialByEmail(email);
    if (!credential) {
      // A pending registration with the right password is a real account awaiting approval; tell
      // the caller so, but only after verifying the password against its hash.
      const pending = this.store.getPendingRegistrationByEmail(email);
      if (pending && verifyPassword(pending.password_scrypt, request.password)) {
        this.audit("auth.login_failed", email, { reason: "pending_approval" });
        return {
          ok: false,
          status: 403,
          error: { message: "account pending approval" },
          code: "pending_approval",
        };
      }
      // No credential and no matching pending account: consume equivalent scrypt time (unless a
      // pending row already absorbed it above) so unknown emails stay indistinguishable.
      if (!pending) {
        verifyPassword(this.dummyPasswordScrypt, request.password);
      }
      this.recordFailure(keys);
      this.audit("auth.login_failed", email, { reason: "unknown_email" });
      return authError(401, "invalid email or password");
    }
    if (!verifyPassword(credential.password_scrypt, request.password)) {
      this.recordFailure(keys);
      this.audit("auth.login_failed", email, { reason: "bad_password" });
      return authError(401, "invalid email or password");
    }
    const member = this.store.getLabMember(credential.member_id);
    if (!member) {
      this.recordFailure(keys);
      this.audit("auth.login_failed", email, { reason: "member_missing" });
      return authError(401, "invalid email or password");
    }
    const { payload } = this.startSession(member);
    this.audit("auth.login_succeeded", member.id, { email });
    this.recordLoginTime(member.id);
    if (this.geolocateIp && request.remoteIp) {
      // Not awaited: geolocation is a courtesy stamp on the member record, not part of the
      // sign-in itself, and must never make login wait on a third-party API.
      void this.recordLoginLocation(member.id, request.remoteIp);
    }
    return { ok: true, status: 200, payload, sessionToken: payload.session_token };
  }

  /**
   * Stamps when somebody signed in.
   *
   * Its own writer, on the login itself. This used to happen only inside `recordLoginLocation`,
   * which meant `last_login_at` -- a field whose name promises exactly one thing -- was written
   * only when an IPinfo token happened to be configured *and* the lookup returned something. With
   * no token nobody in the lab ever got one, so Profile Completeness flagged every daily user as
   * "never signed in", the adoption line read 0/N, and the page whose entire thesis is "complete on
   * paper, adopted by nobody" could not tell the two apart.
   *
   * Synchronous and unconditional, unlike the geolocation below: this is one local write with
   * nothing to wait on, and a stamp that is sometimes skipped is worse than no stamp at all --
   * absent means "never signed in" to five different readers.
   *
   * Re-reads rather than reusing the `member` from login() for the same reason the location writer
   * does: logins race, and this must touch one field and never clobber a concurrent profile edit.
   */
  private recordLoginTime(memberId: string): void {
    const current = this.store.getLabMember(memberId);
    if (!current) {
      return;
    }
    const now = this.now().toISOString();
    this.store.saveLabMember({ ...current, last_login_at: now, updated_at: now });
    // The field above is overwritten by the next sign-in and by any bulk write that touches the
    // member; this row is not. It is the difference between "is this person alive" and "how often
    // do they actually come back", and only the second one can be read after an importer has run.
    //
    // Same choke point on purpose: a login that stamps the field but not the log, or the reverse,
    // is two sources of truth that disagree with nobody able to say which drifted.
    this.store.appendLoginEvent({ id: randomUUID(), member_id: memberId, at: now });
  }

  // Fire-and-forget, same contract as the calendar invite and the approval email: the login has
  // already succeeded, so a slow or unreachable geolocation provider must never delay or fail it.
  //
  // Only the three inferred last_login_* fields are written. `location` and `slack_location` are
  // self-reported and are deliberately never touched here -- an inferred country must not silently
  // overwrite what a member told us about themselves.
  private async recordLoginLocation(memberId: string, remoteIp: string): Promise<void> {
    try {
      const location = await this.geolocateIp?.(remoteIp);
      if (!location || (!location.country && !location.continent && !location.city)) {
        return;
      }
      // Re-read rather than reuse the `member` from login(): logins can race, and this must
      // only ever touch the three last_login_* fields, never clobber a concurrent profile edit.
      const current = this.store.getLabMember(memberId);
      if (!current) {
        return;
      }
      this.store.saveLabMember({
        ...current,
        // `last_login_at` is not written here any more. It is a fact about signing in, not about
        // geolocation succeeding, and recordLoginTime owns it -- one writer for one fact.
        ...(location.country ? { last_login_country: location.country } : {}),
        ...(location.continent ? { last_login_continent: location.continent } : {}),
        // Written alongside the country and read only with `last_login_at`, which is what keeps a
        // stale city out of a scheduling decision. Still never touches `location`/`current_city`.
        ...(location.city ? { last_login_city: location.city } : {}),
        ...(location.timezone ? { last_login_timezone: location.timezone } : {}),
        updated_at: this.now().toISOString(),
      });
      this.audit("auth.login_location_updated", memberId, { ...location });
      // The stamp above is where they are *now* and overwrites itself; this is the timeline, which
      // is what makes "when did they move" answerable and what the drift prompt reads. Appended
      // only when the country changed, so a member signing in twice a day adds no rows.
      if (location.country) {
        const entry = observationFor({
          memberId,
          source: "login_ip",
          raw: location.country,
          observedAt: this.now().toISOString(),
        });
        const latest = latestBySource(this.store.listMemberLocations(memberId, 20)).get("login_ip");
        if (entry && isNewObservation(latest, entry)) {
          this.store.appendMemberLocation(entry);
        }
      }
    } catch {
      // Best-effort, per the option's own contract — nothing left to do with a failure here.
    }
  }

  resolveSession(rawToken: string): AdminBotMemberPrincipal | undefined {
    const tokenHash = hashToken(rawToken);
    const session = this.store.getSession(tokenHash);
    if (!session || session.revoked_at) {
      return undefined;
    }
    const nowIso = this.now().toISOString();
    if (session.expires_at <= nowIso) {
      return undefined;
    }
    const member = this.store.getLabMember(session.member_id);
    if (!member) {
      return undefined;
    }
    this.store.touchSession(tokenHash, nowIso);
    // Opportunistic cleanup of expired rows on the read path so sessions do not accumulate.
    this.store.pruneSessionsBefore(nowIso);
    if (!session.impersonated_by) {
      return { kind: "member", member, session };
    }
    // A "view as" session is only as good as the admin behind it. Resolving them on every request
    // rather than trusting the row means demoting or deleting an admin ends their impersonated
    // sessions at once, instead of leaving a token that outlives their own access.
    const impersonator = this.store.getLabMember(session.impersonated_by);
    if (!impersonator || impersonator.privilege_level !== "admin") {
      this.store.revokeSession(tokenHash, nowIso);
      return undefined;
    }
    return { kind: "member", member, session, impersonator };
  }

  /**
   * Open a session that sees the lab as `memberId` sees it.
   *
   * A real session row for the target member, not a flag on the admin's own: every route, access
   * check and privilege gate then reads the member being viewed without knowing impersonation
   * exists, which is the only way the view is actually theirs rather than an approximation of it.
   * An admin impersonating a trial member loses admin routes for the duration -- that is the
   * feature working, not a bug.
   *
   * The admin's own session is untouched and still valid, so returning is a matter of dropping
   * this token rather than signing in again.
   *
   * Four refusals, each closing a way this becomes an escalation rather than a debugging tool:
   *
   *   - Only a member principal who is an admin *right now*. In particular not the service
   *     principal: that token is shared by every agent tool call, and letting it mint a session as
   *     any member would turn one shared secret into the whole roster.
   *   - No impersonating yourself, which would only produce a confusing second session.
   *   - No nesting. Impersonating onward from an impersonated session would make the chain of who
   *     is really acting depend on rows that have already expired by the time anyone reads them.
   *   - Nothing for a member who does not exist.
   *
   * Impersonating another admin is allowed: it grants nothing the caller does not already hold,
   * and refusing it would block the case this is most often needed for.
   */
  startImpersonation(params: {
    admin: AdminBotMemberPrincipal;
    memberId: string;
  }): AdminBotAuthResponse<AdminBotAuthSessionPayload> {
    const { admin, memberId } = params;
    if (admin.member.privilege_level !== "admin") {
      return authError(403, "admin privileges required");
    }
    if (admin.session.impersonated_by) {
      return authError(403, "cannot impersonate from an impersonated session");
    }
    if (admin.member.id === memberId) {
      return authError(400, "cannot impersonate yourself");
    }
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return authError(404, "member not found");
    }
    const { payload } = this.startSession(member, {
      by: admin.member.id,
      ttlMs: IMPERSONATION_TTL_MS,
    });
    // Audited on the admin, like every other governance action, and carrying the subject -- so
    // "who was looking at my account, and when" is answerable from the trail alone.
    this.audit("auth.impersonation_started", admin.member.id, {
      member_id: member.id,
      member_name: member.name,
      expires_at: payload.expires_at,
    });
    // Deliberately no `sessionToken` on the response, which is what would make the route set the
    // session cookie. The token goes back in the body for the caller to hold as a bearer, leaving
    // the admin's own cookie exactly as it was -- so the way back does not depend on the very
    // session that is about to be revoked.
    return { ok: true, status: 200, payload };
  }

  /**
   * End a "view as" session.
   *
   * Distinct from `logout` so the audit trail says which of the two happened, and so a stray call
   * on a normal session cannot sign a member out of their own account by accident.
   */
  endImpersonation(rawToken: string): AdminBotAuthResponse<{ ended: true }> {
    const tokenHash = hashToken(rawToken);
    const session = this.store.getSession(tokenHash);
    if (!session?.impersonated_by) {
      return authError(400, "not an impersonated session");
    }
    if (!session.revoked_at) {
      this.store.revokeSession(tokenHash, this.now().toISOString());
      this.audit("auth.impersonation_ended", session.impersonated_by, {
        member_id: session.member_id,
      });
    }
    return { ok: true, status: 200, payload: { ended: true } };
  }

  logout(rawToken: string): AdminBotAuthResponse<{ logged_out: true }> {
    const tokenHash = hashToken(rawToken);
    const session = this.store.getSession(tokenHash);
    if (session && !session.revoked_at) {
      this.store.revokeSession(tokenHash, this.now().toISOString());
      this.audit("auth.logged_out", session.member_id, {});
    }
    return { ok: true, status: 200, payload: { logged_out: true } };
  }

  changePassword(
    memberId: string,
    currentPassword: string,
    newPassword: string,
  ): AdminBotAuthResponse<{ changed: true }> {
    const credential = this.store.getCredentialByMemberId(memberId);
    if (!credential || !verifyPassword(credential.password_scrypt, currentPassword)) {
      return authError(401, "invalid email or password");
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return authError(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const nowIso = this.now().toISOString();
    this.store.saveCredential({
      ...credential,
      password_scrypt: hashPassword(newPassword),
      updated_at: nowIso,
    });
    // A password change is a containment action as well as a credential update. Keeping an older
    // session alive lets whoever stole it ignore the new password entirely.
    this.store.revokeSessionsForMember(memberId, nowIso);
    this.audit("auth.password_changed", memberId, {});
    return { ok: true, status: 200, payload: { changed: true } };
  }

  /**
   * Starts a "forgot my password" flow. The response is deliberately identical whether or not the
   * address has an account: this route is unauthenticated, so a distinguishable answer would turn
   * it into a membership oracle for the whole roster. Rate-limited on the same keys as login so it
   * cannot be used to spray mail at an address either.
   */
  requestPasswordReset(request: {
    email: string;
    remoteIp?: string;
  }): AdminBotAuthResponse<{ requested: true }> {
    const email = request.email.trim().toLowerCase();
    const keys = rateLimitKeys(email, request.remoteIp);
    const limited = this.checkRateLimit(keys, email, request.remoteIp);
    if (limited) {
      return limited;
    }
    this.recordFailure(keys);
    const credential = this.store.getCredentialByEmail(email);
    if (credential) {
      const nowMs = this.now().getTime();
      const token = randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString("base64url");
      this.store.savePasswordReset({
        token_hash: hashToken(token),
        member_id: credential.member_id,
        created_at: new Date(nowMs).toISOString(),
        expires_at: new Date(nowMs + PASSWORD_RESET_TTL_MINUTES * 60_000).toISOString(),
        used_at: null,
      });
      this.audit("auth.password_reset_requested", credential.member_id, { email });
      this.notifyPasswordReset(credential.email, credential.member_id, token);
    } else {
      // Audited so a burst against unknown addresses is still visible, keyed by the attempted
      // address because there is no member to attribute it to.
      this.audit("auth.password_reset_requested", email, { email, unknown: true });
    }
    return { ok: true, status: 200, payload: { requested: true } };
  }

  /**
   * Redeems a reset token and sets the new password. Every outstanding token for the member is
   * burned on success, and so is every live session: a password reset is exactly the moment where
   * "somebody else may be signed in as me" has to stop being true.
   */
  resetPassword(request: {
    token: string;
    newPassword: string;
  }): AdminBotAuthResponse<{ reset: true }> {
    const token = request.token.trim();
    if (!token) {
      return authError(400, "reset link is invalid or has expired");
    }
    const reset = this.store.getPasswordResetByTokenHash(hashToken(token));
    const nowIso = this.now().toISOString();
    // One message for missing/used/expired alike: which of the three it is tells an attacker
    // whether a guessed token ever existed.
    if (!reset || reset.used_at || reset.expires_at <= nowIso) {
      return authError(400, "reset link is invalid or has expired");
    }
    if (request.newPassword.length < MIN_PASSWORD_LENGTH) {
      return authError(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const credential = this.store.getCredentialByMemberId(reset.member_id);
    if (!credential) {
      return authError(400, "reset link is invalid or has expired");
    }
    this.store.saveCredential({
      ...credential,
      password_scrypt: hashPassword(request.newPassword),
      updated_at: nowIso,
    });
    this.store.markPasswordResetsUsedForMember(reset.member_id, nowIso);
    this.store.revokeSessionsForMember(reset.member_id, nowIso);
    this.audit("auth.password_reset_completed", reset.member_id, {});
    return { ok: true, status: 200, payload: { reset: true } };
  }

  // Best-effort, same contract as the account-approved mail: the token row is already written, so a
  // failed send is audited for follow-up rather than rolled back into an error the caller sees
  // (which would also leak whether the address exists).
  /**
   * Where the reset link is sent.
   *
   * The correspondence address when the member has one, and the login address otherwise. These are
   * routinely different people-facing facts: `email` is the departmental identity the account is
   * keyed by, and `correspondence_email` is the address the member actually reads -- which for
   * anyone who has not been issued a cs.toronto.edu account yet is the only one that reaches them.
   * A reset sent to a mailbox nobody opens is a member who cannot get back in.
   *
   * The login address stays the identifier: this changes the destination, never what you type to
   * request the reset or to sign in.
   *
   * Known and accepted consequence: `correspondence_email` is self-editable and writable for any
   * member by the shared service principal (see PUT /lab/members/:id in api/server.ts), where
   * `email` is not. So the service token can redirect a reset and take an account over, admins
   * included -- a boundary that held only while resets went to the login address. The lab's call
   * is that the token is guarded like an admin password, and that a member with no departmental
   * mailbox being locked out permanently is the worse failure.
   */
  private passwordResetRecipient(loginEmail: string, memberId: string): string {
    const member = this.store.getLabMember(memberId);
    const correspondence =
      typeof member?.correspondence_email === "string" ? member.correspondence_email.trim() : "";
    return correspondence || loginEmail;
  }

  private notifyPasswordReset(loginEmail: string, memberId: string, token: string): void {
    if (!this.sendPasswordResetEmail) {
      return;
    }
    const member = this.store.getLabMember(memberId);
    const name = typeof member?.name === "string" ? member.name : undefined;
    const email = this.passwordResetRecipient(loginEmail, memberId);
    void this.sendPasswordResetEmail({
      email,
      ...(name ? { name } : {}),
      token,
      expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
    })
      .then(() => {
        this.audit("auth.password_reset_email_sent", memberId, { email });
      })
      .catch((error: unknown) => {
        this.audit("auth.password_reset_email_failed", memberId, {
          email,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  // Self-service change of the member's login email. Reverifies the current password (rate-limited
  // like login), then updates both the credential row (the login identifier) and the member record
  // so they never drift. Existing sessions are keyed by token hash, not email, so they stay valid.
  changeEmail(
    memberId: string,
    newEmail: string,
    currentPassword: string,
    remoteIp?: string,
  ): AdminBotAuthResponse<{ email: string }> {
    const credential = this.store.getCredentialByMemberId(memberId);
    // No credential means this principal cannot own a login email; caller gates non-members too.
    if (!credential) {
      return authError(401, "invalid password");
    }
    const keys = rateLimitKeys(credential.email, remoteIp);
    const limited = this.checkRateLimit(keys, credential.email, remoteIp);
    if (limited) {
      return limited;
    }
    if (!verifyPassword(credential.password_scrypt, currentPassword)) {
      this.recordFailure(keys);
      return authError(401, "invalid password");
    }
    const email = newEmail.trim().toLowerCase();
    if (!isValidEmail(email)) {
      return authError(400, "invalid email");
    }
    // No domain rule here on purpose: a cs.toronto.edu address is preferred, not required, and
    // `validateMemberEmail` on the roster side was loosened to match. Format is the whole check.
    const member = this.store.getLabMember(memberId);
    // Generic 409 for any other credential or pending registration holding the email so a caller
    // cannot probe which addresses exist. Re-using the member's own current email is a no-op.
    const existing = this.store.getCredentialByEmail(email);
    const takenByOther = existing && existing.member_id !== memberId;
    if (takenByOther || this.store.getPendingRegistrationByEmail(email)) {
      return authError(409, "email unavailable");
    }
    const nowIso = this.now().toISOString();
    this.store.updateCredentialEmail(memberId, email, nowIso);
    if (member) {
      // Keep the member record's email in sync with the login identifier.
      this.store.saveLabMember({ ...member, email, updated_at: nowIso });
    }
    this.audit("auth.email_changed", memberId, { email });
    return { ok: true, status: 200, payload: { email } };
  }

  // Approve a pending request: `claim` binds a credential to the named roster member; `signup`
  // first mints a plain member from the stored profile, then binds the credential to it.
  approveRegistration(
    id: string,
    decidedBy: string,
  ): AdminBotAuthResponse<{ status: "approved"; member_id: string }> {
    const registration = this.store.getAccountRegistration(id);
    if (!registration || registration.status !== "pending") {
      return authError(404, "registration not found");
    }
    const nowIso = this.now().toISOString();
    const memberId =
      registration.kind === "claim"
        ? registration.member_id
        : this.createMember(signupMemberInput(registration)).id;
    if (!memberId) {
      return authError(409, "registration is missing a member");
    }
    this.store.saveCredential({
      member_id: memberId,
      email: registration.email,
      password_scrypt: registration.password_scrypt,
      claimed_at: nowIso,
      updated_at: nowIso,
    });
    this.store.updateAccountRegistrationDecision(id, "approved", decidedBy, nowIso);
    this.audit("auth.registration_approved", decidedBy, {
      registration_id: id,
      kind: registration.kind,
      member_id: memberId,
    });
    this.inviteNewMemberToLabCalendar(registration.email, memberId, decidedBy);
    this.notifyAccountApproved(registration.email, memberId, decidedBy);
    return { ok: true, status: 200, payload: { status: "approved", member_id: memberId } };
  }

  // Fire-and-forget, same reasoning as the calendar invite: the approval is already recorded, so a
  // failed mail is audited for follow-up rather than rolled back. Short transient failures are
  // retried because this message is the member's only guaranteed delivery of the dashboard URL.
  private notifyAccountApproved(email: string, memberId: string, decidedBy: string): void {
    if (!this.sendAccountApprovedEmail) {
      return;
    }
    const name = this.store.getLabMember(memberId)?.name;
    void this.sendAccountApprovedWithRetry({ email, ...(name ? { name } : {}) })
      .then((attempts) => {
        this.audit("auth.approval_email_sent", decidedBy, {
          member_id: memberId,
          email,
          attempts,
        });
      })
      .catch((error: unknown) => {
        this.audit("auth.approval_email_failed", decidedBy, {
          member_id: memberId,
          email,
          attempts: APPROVAL_EMAIL_MAX_ATTEMPTS,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async sendAccountApprovedWithRetry(params: {
    email: string;
    name?: string;
  }): Promise<number> {
    if (!this.sendAccountApprovedEmail) {
      return 0;
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= APPROVAL_EMAIL_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.sendAccountApprovedEmail(params);
        return attempt;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /**
   * Grant lab calendar access to everybody who should already have had it.
   *
   * The repair half of the invite. The approval-time invite is fire-and-forget by design, so a
   * deployment with `ADMINBOT_LAB_EMAIL` unset -- which is what this lab ran for four months --
   * approves members, fails every invite, and has no way to catch up afterwards. Fixing the
   * variable does nothing for the people already approved; this is what reaches them.
   *
   * Who: `belongsOnSurface(member, "lab_calendar")`, the same predicate that decides who stays on
   * the standing invite. Reusing it rather than writing a second rule means "who is on the lab
   * calendar" keeps one answer.
   *
   * Who not: anybody with an `auth.calendar_invite_sent` already in the trail. The ACL write is
   * idempotent, but the invite emails Google sends are not, and re-mailing a hundred people who
   * were correctly onboarded is its own incident.
   *
   * `dryRun` is the default and `limit` is small on purpose. Each grant mails a real person, so
   * this is a walk an admin takes in batches while watching what lands, not a button that mails
   * the roster.
   */
  async backfillLabCalendarInvites(params: {
    actorId: string;
    dryRun?: boolean;
    limit?: number;
  }): Promise<
    AdminBotAuthResponse<{
      granted: Array<{ id: string; name: string; email: string }>;
      failed: Array<{ id: string; name: string; email: string; error: string }>;
      already_invited: number;
      no_address: Array<{ id: string; name: string }>;
      remaining: number;
      dry_run: boolean;
    }>
  > {
    if (!this.inviteToLabCalendar) {
      return authError(503, "no calendar invite runner is configured");
    }
    const dryRun = params.dryRun !== false;
    const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_CALENDAR_BACKFILL_LIMIT, 200));
    const invited = new Set<string>();
    for (const event of this.store.listAuditEvents()) {
      if (event.type !== "auth.calendar_invite_sent") {
        continue;
      }
      const memberId = event.details?.member_id;
      if (typeof memberId === "string") {
        invited.add(memberId);
      }
    }
    const noAddress: Array<{ id: string; name: string }> = [];
    const candidates: Array<{ id: string; name: string; email: string }> = [];
    for (const member of this.store.listLabMembers()) {
      if (!belongsOnSurface(member, "lab_calendar") || invited.has(member.id)) {
        continue;
      }
      // The Google account first: an ACL is granted to a Google identity, and the professional
      // address on file is often a departmental alias that is not one.
      const email = (
        member.calendar_email ??
        member.email ??
        member.correspondence_email ??
        ""
      ).trim();
      if (!email) {
        noAddress.push({ id: member.id, name: member.name });
        continue;
      }
      candidates.push({ id: member.id, name: member.name, email });
    }
    const batch = candidates.slice(0, limit);
    const granted: Array<{ id: string; name: string; email: string }> = [];
    const failed: Array<{ id: string; name: string; email: string; error: string }> = [];
    if (!dryRun) {
      for (const candidate of batch) {
        try {
          // Awaited, unlike the approval-time invite: this call *is* the request, so a failure
          // belongs in its response rather than in a log the caller never sees. Sequential for the
          // same reason -- a hundred parallel ACL writes is how a quota gets spent.
          // Silently, unlike the onboarding invite. This grants access somebody should already
          // have had, so Google's share notification would announce a months-old oversight to a
          // roster that includes people who left the lab a year ago. The access lands the same
          // way; only the mail is suppressed. See CalendarInviteOptions.
          await this.inviteToLabCalendar(candidate.email, { sendNotifications: false });
          this.audit("auth.calendar_invite_sent", params.actorId, {
            member_id: candidate.id,
            email: candidate.email,
            backfill: true,
          });
          granted.push(candidate);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.audit("auth.calendar_invite_failed", params.actorId, {
            member_id: candidate.id,
            email: candidate.email,
            error: message,
            backfill: true,
          });
          failed.push({ ...candidate, error: message });
          // A missing variable or a dead credential fails identically for everybody, so there is
          // nothing to learn from the other 154 attempts and a real cost to making them.
          if (failed.length === 1 && granted.length === 0) {
            break;
          }
        }
      }
    }
    return {
      ok: true,
      status: 200,
      payload: {
        granted: dryRun ? batch : granted,
        failed,
        already_invited: invited.size,
        no_address: noAddress,
        remaining: Math.max(0, candidates.length - batch.length),
        dry_run: dryRun,
      },
    };
  }

  // Fire-and-forget: never blocks or fails approval on an external Google Calendar call. Success
  // and failure are both audited so a failed invite can be retried/investigated later.
  private inviteNewMemberToLabCalendar(email: string, memberId: string, decidedBy: string): void {
    if (!this.inviteToLabCalendar) {
      return;
    }
    void this.inviteToLabCalendar(email)
      .then(() => {
        this.audit("auth.calendar_invite_sent", decidedBy, { member_id: memberId, email });
      })
      .catch((error: unknown) => {
        this.audit("auth.calendar_invite_failed", decidedBy, {
          member_id: memberId,
          email,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  // Fire-and-forget, same contract as the calendar invite and approval email: the approval is
  // already recorded, so a failed form submission is audited for a human to file by hand rather
  // than rolled back. The roster only ever records one free-text `name`, so it is split on the
  // last run of whitespace (see splitDisplayName) to fill the form's separate First/Last Name
  // questions -- the same shape the actual form asks a person to fill in by hand. A name with no
  // family name in it is not filed at all: the splitter returns nothing and the attempt is
  // recorded as failed, because the alternative was a DCS account requested for "Eric Eric".

  rejectRegistration(id: string, decidedBy: string): AdminBotAuthResponse<{ status: "rejected" }> {
    const registration = this.store.getAccountRegistration(id);
    if (!registration || registration.status !== "pending") {
      return authError(404, "registration not found");
    }
    this.store.updateAccountRegistrationDecision(
      id,
      "rejected",
      decidedBy,
      this.now().toISOString(),
    );
    this.audit("auth.registration_rejected", decidedBy, {
      registration_id: id,
      kind: registration.kind,
    });
    return { ok: true, status: 200, payload: { status: "rejected" } };
  }

  // Public picker: roster members that are still unclaimed and have no pending claim. Exposes only
  // id + name so an anonymous caller cannot harvest emails or other member fields.
  listRoster(): AdminBotRosterEntry[] {
    const pendingClaimMemberIds = new Set(
      this.store
        .listAccountRegistrations("pending")
        .flatMap((entry) => (entry.kind === "claim" && entry.member_id ? [entry.member_id] : [])),
    );
    return this.store
      .listLabMembers()
      .filter(
        (member) =>
          !this.store.getCredentialByMemberId(member.id) && !pendingClaimMemberIds.has(member.id),
      )
      .map((member) => ({ id: member.id, name: member.name }));
  }

  // Admin review list. Adds member name for claims and the proposed profile for signups; never
  // includes the password hash.
  listRegistrations(status: AdminBotRegistrationStatus = "pending"): AdminBotRegistrationView[] {
    return this.store.listAccountRegistrations(status).map((registration) => ({
      id: registration.id,
      kind: registration.kind,
      email: registration.email,
      status: registration.status,
      created_at: registration.created_at,
      ...(registration.member_id ? { member_id: registration.member_id } : {}),
      ...(registration.kind === "claim" && registration.member_id
        ? { member_name: this.store.getLabMember(registration.member_id)?.name }
        : {}),
      ...(registration.kind === "signup" && registration.profile_json
        ? { profile: JSON.parse(registration.profile_json) as Record<string, unknown> }
        : {}),
    }));
  }

  private newRegistration(
    kind: AdminBotRegistrationKind,
    email: string,
    password: string,
    extra: { member_id?: string; profile_json?: string },
  ): AdminBotAccountRegistration {
    return {
      id: `reg_${randomUUID()}`,
      kind,
      email,
      password_scrypt: hashPassword(password),
      status: "pending",
      created_at: this.now().toISOString(),
      ...(extra.member_id ? { member_id: extra.member_id } : {}),
      ...(extra.profile_json ? { profile_json: extra.profile_json } : {}),
    };
  }

  sessionView(principal: AdminBotMemberPrincipal): AdminBotAuthSessionView {
    return {
      expires_at: principal.session.expires_at,
      member: principal.member,
      // The one place the illusion is deliberately broken. Everything else about an impersonated
      // session reads as the member so the view is honest, but a browser that cannot tell it is
      // impersonating cannot offer a way back -- and an admin who forgets which account they are
      // in is how a "view as" ends with something filed under the wrong name.
      ...(principal.impersonator
        ? {
            impersonated_by: {
              id: principal.impersonator.id,
              name: principal.impersonator.name,
            },
          }
        : {}),
      ...(this.gatewayUrl ? { gateway: { url: this.gatewayUrl } } : {}),
    };
  }

  private startSession(
    member: AdminBotLabMember,
    impersonation?: { by: string; ttlMs: number },
  ): { payload: AdminBotAuthSessionPayload } {
    const rawToken = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    const nowMs = this.now().getTime();
    const createdIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(nowMs + (impersonation?.ttlMs ?? this.sessionTtlMs)).toISOString();
    this.store.saveSession({
      token_hash: hashToken(rawToken),
      member_id: member.id,
      created_at: createdIso,
      expires_at: expiresIso,
      last_seen_at: createdIso,
      ...(impersonation ? { impersonated_by: impersonation.by } : {}),
    });
    return {
      payload: {
        session_token: rawToken,
        expires_at: expiresIso,
        member,
        ...(this.gatewayUrl ? { gateway: { url: this.gatewayUrl } } : {}),
      },
    };
  }

  private checkRateLimit(
    keys: string[],
    email: string,
    remoteIp: string | undefined,
  ): (AdminBotAuthResponse<never> & { ok: false }) | undefined {
    const nowMs = this.now().getTime();
    for (const key of keys) {
      const failures = this.recentFailures(key, nowMs);
      if (failures.length >= RATE_LIMIT_MAX_FAILURES) {
        const retryAfterMs = failures[0] + RATE_LIMIT_WINDOW_MS - nowMs;
        const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
        this.audit("auth.rate_limited", email, {
          email,
          ...(remoteIp ? { remote_ip: remoteIp } : {}),
        });
        return {
          ok: false,
          status: 429,
          error: { message: "too many attempts, retry later" },
          retry_after_seconds: retryAfterSeconds,
        };
      }
    }
    return undefined;
  }

  private recordFailure(keys: string[]): void {
    const nowMs = this.now().getTime();
    for (const key of keys) {
      const failures = this.recentFailures(key, nowMs);
      failures.push(nowMs);
      this.failuresByKey.set(key, failures);
    }
  }

  private recentFailures(key: string, nowMs: number): number[] {
    const cutoff = nowMs - RATE_LIMIT_WINDOW_MS;
    return (this.failuresByKey.get(key) ?? []).filter((at) => at > cutoff);
  }

  private audit(
    type: AdminBotAuditEvent["type"],
    actor: string | undefined,
    details: Record<string, unknown>,
  ): void {
    this.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp: this.now().toISOString(),
      type,
      ...(actor ? { actor } : {}),
      details,
    });
  }
}

// scrypt$N$r$p$<salt_b64url>$<hash_b64url>
export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export function verifyPassword(serialized: string, password: string): boolean {
  const parts = serialized.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  let expected: Buffer;
  try {
    expected = Buffer.from(parts[5], "base64url");
  } catch {
    return false;
  }
  const salt = Buffer.from(parts[4], "base64url");
  const derived = scryptSync(password, salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export function createSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function rateLimitKeys(email: string, remoteIp: string | undefined): string[] {
  const keys = [`email:${email}`];
  if (remoteIp) {
    keys.push(`ip:${remoteIp}`);
  }
  return keys;
}

function authError<T>(status: number, message: string): AdminBotAuthResponse<T> {
  return { ok: false, status, error: { message } };
}

// Basic shape check only: one @, non-empty local part, and a dotted domain. Deliverability is not
// verified here; the login identifier just has to look like an address.
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email);
}

// Validate a signup profile: name is required and non-empty, only whitelisted keys are allowed,
// research_topics/projects must be string[], hours_per_week must be a finite number.
// Any unknown key or wrong type rejects the whole profile. A schedule is not part of signup:
// availability rows and time off are recorded by the member afterwards, in the console.
function sanitizeSignupProfile(
  profile: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof profile.name !== "string" || !profile.name.trim()) {
    return undefined;
  }
  const allowed = new Set<string>(SIGNUP_PROFILE_FIELDS);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (value === undefined) {
      continue;
    }
    if (!allowed.has(key)) {
      return undefined;
    }
    if (SIGNUP_STRING_ARRAY_FIELDS.has(key)) {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        return undefined;
      }
      result[key] = value;
      continue;
    }
    if (SIGNUP_NUMBER_FIELDS.has(key)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
      }
      result[key] = value;
      continue;
    }
    // Role is checked here, at the door, rather than only in validateLabMember. A signup that
    // carries a role outside the vocabulary used to be accepted as pending and then failed at
    // approval time -- so the person got a success screen, and an admin got an error days later
    // on a registration that could never be approved.
    if (key === "role" && typeof value === "string" && value.trim()) {
      const role = normalizeMemberRole(value);
      if (!role) {
        return undefined;
      }
      result[key] = role;
      continue;
    }
    if (typeof value !== "string") {
      return undefined;
    }
    result[key] = value;
  }
  return result;
}

function signupMemberInput(registration: AdminBotAccountRegistration): AdminBotLabMemberInput {
  const profile = registration.profile_json
    ? (JSON.parse(registration.profile_json) as Record<string, unknown>)
    : {};
  // A registration submitted before the role vocabulary existed still has to be approvable: the
  // person is waiting on an account, and a role nobody can match is not a reason to refuse them
  // one. Unmatched roles move to notes so the answer is not lost, and an admin can set the real
  // role afterwards.
  const rawRole = typeof profile.role === "string" ? profile.role.trim() : "";
  const role = rawRole ? normalizeMemberRole(rawRole) : undefined;
  const unmatchedRole = rawRole && !role ? rawRole : "";
  const notes = [
    typeof profile.notes === "string" ? profile.notes : "",
    unmatchedRole ? `Role as submitted: ${unmatchedRole}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  // New signups land as plain members; privilege/access are governance-owned, never from profile.
  return {
    ...(profile as Omit<AdminBotLabMemberInput, "id" | "privilege_level">),
    ...(role ? { role } : { role: "" }),
    ...(notes ? { notes } : {}),
    id: `mem_${randomUUID()}`,
    privilege_level: "member",
  };
}

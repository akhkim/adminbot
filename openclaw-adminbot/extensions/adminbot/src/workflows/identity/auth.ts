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

// scrypt cost parameters. Serialized alongside every hash so a future cost bump can be
// detected per-credential without a migration; verify re-derives with the stored params.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const MIN_PASSWORD_LENGTH = 10;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TOKEN_BYTES = 32;

// Sliding-window brute-force guard: at most this many failures per key inside the window.
const RATE_LIMIT_MAX_FAILURES = 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export type AdminBotAuthSessionPayload = {
  session_token: string;
  expires_at: string;
  member: AdminBotLabMember;
  gateway?: { url?: string; token: string };
};

// GET /auth/session view: same as the login payload minus the raw token, which is never echoed
// back once the cookie/bearer is established.
export type AdminBotAuthSessionView = {
  expires_at: string;
  member: AdminBotLabMember;
  gateway?: { url?: string; token: string };
};

export type AdminBotMemberPrincipal = {
  kind: "member";
  member: AdminBotLabMember;
  session: AdminBotAuthSession;
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
  inviteToLabCalendar?: (email: string) => Promise<void>;
  // Best-effort side effect fired (not awaited) when a registration is approved, telling the new
  // member their account is live. Same contract as inviteToLabCalendar: audited either way, never
  // fails or delays the approval response.
  sendAccountApprovedEmail?: (params: { email: string; name?: string }) => Promise<void>;
  // Best-effort side effect fired (not awaited) when a registration is approved, filing the DCS
  // Slack-access request form on the new member's behalf. Same contract as the two above.
  submitDcsForm?: (params: { firstName: string; lastName: string; email: string }) => Promise<void>;
  // Best-effort, fired but not awaited on a successful login (see login()): resolving it can take
  // a moment and must never slow down or fail the sign-in it happened alongside.
  geolocateIp?: (ip: string) => Promise<{ country?: string; continent?: string } | undefined>;
  gatewayToken?: string;
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

// The roster keeps one free-text `name`; the DCS form (like most external forms) wants separate
// First/Last Name answers, so this splits on the last space -- everything before it becomes the
// first name (covers middle names/initials), the final token becomes the last name. A one-word
// name (no space) has nothing to split, so it is used for both rather than leaving a required
// field blank.
function splitDisplayName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace === -1) {
    return { firstName: trimmed, lastName: trimmed };
  }
  return {
    firstName: trimmed.slice(0, lastSpace).trim(),
    lastName: trimmed.slice(lastSpace + 1).trim(),
  };
}

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
  private readonly inviteToLabCalendar?: (email: string) => Promise<void>;
  private readonly sendAccountApprovedEmail?: (params: {
    email: string;
    name?: string;
  }) => Promise<void>;
  private readonly submitDcsForm?: (params: {
    firstName: string;
    lastName: string;
    email: string;
  }) => Promise<void>;
  private readonly geolocateIp?: (
    ip: string,
  ) => Promise<{ country?: string; continent?: string } | undefined>;
  private readonly gatewayToken?: string;
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
    this.submitDcsForm = options.submitDcsForm;
    this.geolocateIp = options.geolocateIp;
    this.gatewayToken = options.gatewayToken?.trim() || undefined;
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
    if (this.geolocateIp && request.remoteIp) {
      // Not awaited: geolocation is a courtesy stamp on the member record, not part of the
      // sign-in itself, and must never make login wait on a third-party API.
      void this.recordLoginLocation(member.id, request.remoteIp);
    }
    return { ok: true, status: 200, payload, sessionToken: payload.session_token };
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
      if (!location || (!location.country && !location.continent)) {
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
        last_login_at: this.now().toISOString(),
        ...(location.country ? { last_login_country: location.country } : {}),
        ...(location.continent ? { last_login_continent: location.continent } : {}),
        updated_at: this.now().toISOString(),
      });
      this.audit("auth.login_location_updated", memberId, { ...location });
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
    return { kind: "member", member, session };
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
    this.store.saveCredential({
      ...credential,
      password_scrypt: hashPassword(newPassword),
      updated_at: this.now().toISOString(),
    });
    this.audit("auth.password_changed", memberId, {});
    return { ok: true, status: 200, payload: { changed: true } };
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
    // Generic 409 for any other credential or pending registration holding the email so a caller
    // cannot probe which addresses exist. Re-using the member's own current email is a no-op.
    const existing = this.store.getCredentialByEmail(email);
    const takenByOther = existing && existing.member_id !== memberId;
    if (takenByOther || this.store.getPendingRegistrationByEmail(email)) {
      return authError(409, "email unavailable");
    }
    const nowIso = this.now().toISOString();
    this.store.updateCredentialEmail(memberId, email, nowIso);
    const member = this.store.getLabMember(memberId);
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
    this.requestDcsFormSubmission(registration.email, memberId, decidedBy);
    return { ok: true, status: 200, payload: { status: "approved", member_id: memberId } };
  }

  // Fire-and-forget, same reasoning as the calendar invite: the approval is already recorded, so a
  // failed mail is audited for follow-up rather than rolled back. The member's name comes from the
  // roster record the approval just created/claimed, so the mail can greet them properly.
  private notifyAccountApproved(email: string, memberId: string, decidedBy: string): void {
    if (!this.sendAccountApprovedEmail) {
      return;
    }
    const name = this.store.getLabMember(memberId)?.name;
    void this.sendAccountApprovedEmail({ email, ...(name ? { name } : {}) })
      .then(() => {
        this.audit("auth.approval_email_sent", decidedBy, { member_id: memberId, email });
      })
      .catch((error: unknown) => {
        this.audit("auth.approval_email_failed", decidedBy, {
          member_id: memberId,
          email,
          error: error instanceof Error ? error.message : String(error),
        });
      });
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
  // last space (see splitDisplayName) to fill the form's separate First/Last Name questions --
  // the same shape the actual form asks a person to fill in by hand.
  private requestDcsFormSubmission(email: string, memberId: string, decidedBy: string): void {
    if (!this.submitDcsForm) {
      return;
    }
    const name = this.store.getLabMember(memberId)?.name ?? "";
    const { firstName, lastName } = splitDisplayName(name);
    void this.submitDcsForm({ firstName, lastName, email })
      .then(() => {
        this.audit("auth.dcs_form_submitted", decidedBy, { member_id: memberId, email });
      })
      .catch((error: unknown) => {
        this.audit("auth.dcs_form_failed", decidedBy, {
          member_id: memberId,
          email,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

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
      ...(this.gateway() ? { gateway: this.gateway() } : {}),
    };
  }

  private startSession(member: AdminBotLabMember): { payload: AdminBotAuthSessionPayload } {
    const rawToken = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    const nowMs = this.now().getTime();
    const createdIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(nowMs + this.sessionTtlMs).toISOString();
    this.store.saveSession({
      token_hash: hashToken(rawToken),
      member_id: member.id,
      created_at: createdIso,
      expires_at: expiresIso,
      last_seen_at: createdIso,
    });
    return {
      payload: {
        session_token: rawToken,
        expires_at: expiresIso,
        member,
        ...(this.gateway() ? { gateway: this.gateway() } : {}),
      },
    };
  }

  // The URL is omitted unless an operator configured one. This service knows its own gateway
  // token; it does not know how a given browser reaches the gateway, and a browser on another host
  // cannot use a loopback address. Omitting lets the client keep the URL it was already configured
  // with (which is how it reached the sign-in form in the first place).
  private gateway(): { url?: string; token: string } | undefined {
    if (!this.gatewayToken) {
      return undefined;
    }
    return { ...(this.gatewayUrl ? { url: this.gatewayUrl } : {}), token: this.gatewayToken };
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

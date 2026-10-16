import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
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
import { adminBotCalendarShareEmail } from "../../contracts/member-outreach-email.js";
import {
  formatAdminBotMemberRoles,
  parseAdminBotMemberRoles,
} from "../../contracts/member-roles.js";
import type { AdminBotServiceStore } from "../../kernel/service.js";
import {
  isNewDailyObservation,
  latestBySource,
  observationFor,
  utcDay,
} from "../members/location-history.js";
import {
  freshSlackTz,
  ipReadingVerdict,
  memberMapVisibility,
  usableDeviceZone,
} from "../members/member-map.js";
import { belongsOnSurface } from "../members/surface-membership.js";
import { isTravelHistorySubject } from "../members/travel-history.js";
import type { CalendarInviteRunner } from "../onboarding/calendar-invite.js";

// scrypt cost parameters. Serialized alongside every hash so a future cost bump can be
// detected per-credential without a migration; verify re-derives with the stored params.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
// A non-account hash with the normal cost. It keeps unknown-email checks comparable without
// doing a blocking derivation in the constructor or starting an unhandled background promise.
const DUMMY_PASSWORD_SCRYPT =
  "scrypt$16384$8$1$QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI$g_p5klroWlIELhg-ChTBOswpM1wy-RniabiDwRQxnYujj6YqPJA6iHQvFRjmSrDF7-r7xeW3El2NslxZDQUSwg";
function derivePassword(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) {
        reject(error);
      } else {
        resolve(derived);
      }
    });
  });
}

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
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

// Reset links are mailed, so they live long enough to survive a slow inbox but not long enough to
// sit in one as a standing credential.
const PASSWORD_RESET_TTL_MINUTES = 60;
const PASSWORD_RESET_TOKEN_BYTES = 32;

// Sliding-window brute-force guard: at most this many failures per key inside the window.
const RATE_LIMIT_MAX_FAILURES = 10;
const RATE_LIMIT_MAX_IN_FLIGHT = 10;
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

type Awaitable<T> = T | Promise<T>;

type AuthStoreMethod =
  | "appendLoginEvent"
  | "appendMemberLocation"
  | "attachLoginEventLocation"
  | "changeMemberLoginEmail"
  | "changePasswordAndRevokeSessions"
  | "consumePasswordResetAndRevokeSessions"
  | "getAccountRegistration"
  | "getCredentialByEmail"
  | "getCredentialByMemberId"
  | "getLabMember"
  | "getPasswordResetByTokenHash"
  | "getPendingRegistrationByEmail"
  | "getPendingRegistrationByMemberId"
  | "getSession"
  | "getSettings"
  | "listAccountRegistrations"
  | "listAuditEvents"
  | "listCredentialMemberIds"
  | "listLabMembers"
  | "listMemberLocations"
  | "markPasswordResetsUsedForMember"
  | "patchLabMemberAuthFields"
  | "pruneSessionsBefore"
  | "recordAudit"
  | "revokeSession"
  | "revokeSessionsForMember"
  | "saveAccountRegistration"
  | "saveCredential"
  | "saveLabMember"
  | "savePasswordReset"
  | "saveSession"
  | "saveSessionIfCredentialCurrent"
  | "searchUnclaimedRoster"
  | "touchSession"
  | "tryApproveRegistration"
  | "trySavePendingRegistration"
  | "updateAccountRegistrationDecision"
  | "updateCredentialEmail";

export type AdminBotAuthStore = {
  [K in AuthStoreMethod]: AdminBotServiceStore[K] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Awaitable<Result>
    : never;
};

export type AdminBotAuthServiceOptions = {
  store: AdminBotAuthStore;
  // Preparing a signup member must not write: only the store can commit member, credential and
  // approval together, after the pending decision has been claimed across processes.
  prepareMember: (input: AdminBotLabMemberInput) => Awaitable<AdminBotLabMember>;
  afterMemberCreated?: (member: AdminBotLabMember) => Awaitable<void>;
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
    | { country?: string; continent?: string; city?: string; region?: string; timezone?: string }
    | undefined
  >;
  // Fired (not awaited) after a sign-in stamped a city on the member: the meetup intros read it.
  // Gets only the member id, never the address or the place.
  afterLoginLocated?: (memberId: string) => void;
  /** Where a best-effort side effect reports its failure. Never given an address. Default console. */
  warn?: (message: string) => void;
  gatewayUrl?: string;
  sessionTtlMs?: number;
  now?: () => Date;
};

type LoginCredentials = {
  email: string;
  password: string;
  remoteIp?: string;
  /** The zone the browser reported with the request, see `AdminBotDeviceClock`. */
  device?: AdminBotDeviceClock;
};

/**
 * What the member's browser said about its own clock, sent as request headers by the Control UI:
 * the IANA zone name from `Intl.DateTimeFormat().resolvedOptions().timeZone` and the UTC offset in
 * minutes east. A name only, never coordinates, and nothing the member is asked for.
 */
export type AdminBotDeviceClock = { tz?: string; offsetMinutes?: number };

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
//
// A signup may name several roles, comma-joined. All of them have to match, because a half-matched
// answer stored as one role would silently drop the other half -- the unmatched string goes to
// notes instead, where an admin can see what the person actually wrote.
function normalizeMemberRole(value: string): string | undefined {
  const submitted = parseAdminBotMemberRoles(value);
  if (!submitted.length) {
    return undefined;
  }
  const matched: string[] = [];
  for (const role of submitted) {
    const needle = role.toLowerCase();
    const known = adminBotMemberRoles.find((entry) => entry.toLowerCase() === needle);
    if (!known) {
      return undefined;
    }
    matched.push(known);
  }
  return formatAdminBotMemberRoles(matched);
}

const SIGNUP_STRING_ARRAY_FIELDS = new Set<string>(["research_topics", "projects"]);
const SIGNUP_NUMBER_FIELDS = new Set<string>(["hours_per_week"]);

export class AdminBotAuthService {
  private readonly store: AdminBotAuthStore;
  private readonly prepareMember: (input: AdminBotLabMemberInput) => Awaitable<AdminBotLabMember>;
  private readonly afterMemberCreated?: (member: AdminBotLabMember) => Awaitable<void>;
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
    | { country?: string; continent?: string; city?: string; region?: string; timezone?: string }
    | undefined
  >;
  private readonly afterLoginLocated?: (memberId: string) => void;
  private readonly warn: (message: string) => void;
  private readonly gatewayUrl?: string;
  private readonly sessionTtlMs: number;
  private readonly now: () => Date;
  // Fixed dummy hash so verify against an unknown email costs the same scrypt work as a real
  // one; otherwise response timing would leak whether an email is on the roster.
  private readonly failuresByKey = new Map<string, number[]>();
  private readonly inFlightByKey = new Map<string, number>();
  private readonly registrationDecisionsInFlight = new Set<string>();
  // What noteAccountUse last looked up for each member: the UTC day, the address and the device
  // zone. A request matching all three is skipped, so it is one lookup per member per day plus one
  // per change of network or clock. In memory on purpose: after a restart the member record's own
  // `last_ip_observed_at` stands in for the day (see noteAccountUse), which is a better trade than
  // keeping a table of everybody's current IP on disk.
  private readonly lastCheckByMember = new Map<string, { day: string; ip: string; tz: string }>();

  constructor(options: AdminBotAuthServiceOptions) {
    this.store = options.store;
    this.prepareMember = options.prepareMember;
    this.afterMemberCreated = options.afterMemberCreated;
    this.inviteToLabCalendar = options.inviteToLabCalendar;
    this.sendAccountApprovedEmail = options.sendAccountApprovedEmail;
    this.sendPasswordResetEmail = options.sendPasswordResetEmail;
    this.geolocateIp = options.geolocateIp;
    this.afterLoginLocated = options.afterLoginLocated;
    this.warn = options.warn ?? ((message: string) => console.warn(message));
    this.gatewayUrl = options.gatewayUrl?.trim() || undefined;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  // Register interest in an existing roster profile. Never issues a session; success only queues a
  // pending registration that an admin must approve. Every uniqueness failure returns the same
  // generic 403 so a caller cannot probe which member/email exists or is already taken.
  async claim(request: ClaimRequest): Promise<AdminBotAuthResponse<{ status: "pending" }>> {
    const email = request.email.trim().toLowerCase();
    const memberId = request.member_id.trim();
    const keys = rateLimitKeys(email, request.remoteIp);
    const limited = await this.checkRateLimit(keys, email, request.remoteIp);
    if (limited) {
      return limited;
    }
    try {
      if (request.password.length < MIN_PASSWORD_LENGTH) {
        return authError(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      const memberTaken =
        !(await this.store.getLabMember(memberId)) ||
        (await this.store.getCredentialByMemberId(memberId)) ||
        (await this.store.getPendingRegistrationByMemberId(memberId));
      const emailTaken =
        (await this.store.getCredentialByEmail(email)) ||
        (await this.store.getPendingRegistrationByEmail(email));
      if (memberTaken || emailTaken) {
        this.recordFailure(keys);
        return authError(403, "unable to claim this profile");
      }
      const registration = await this.newRegistration("claim", email, request.password, {
        member_id: memberId,
      });
      if (!(await this.store.trySavePendingRegistration(registration))) {
        this.recordFailure(keys);
        return authError(403, "unable to claim this profile");
      }
      await this.audit("auth.registration_submitted", memberId, { kind: "claim", email });
      return { ok: true, status: 200, payload: { status: "pending" } };
    } finally {
      this.releaseRateLimit(keys);
    }
  }

  // Self-service application from someone not yet on the roster. Approval later mints the member.
  async signup(request: SignupRequest): Promise<AdminBotAuthResponse<{ status: "pending" }>> {
    const email = request.email.trim().toLowerCase();
    const keys = rateLimitKeys(email, request.remoteIp);
    const limited = await this.checkRateLimit(keys, email, request.remoteIp);
    if (limited) {
      return limited;
    }
    try {
      if (request.password.length < MIN_PASSWORD_LENGTH) {
        return authError(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      const profile = sanitizeSignupProfile(request.profile);
      if (!profile) {
        return authError(400, "invalid profile");
      }
      if (
        (await this.store.getCredentialByEmail(email)) ||
        (await this.store.getPendingRegistrationByEmail(email))
      ) {
        this.recordFailure(keys);
        return authError(403, "unable to register");
      }
      const registration = await this.newRegistration("signup", email, request.password, {
        profile_json: JSON.stringify(profile),
      });
      if (!(await this.store.trySavePendingRegistration(registration))) {
        this.recordFailure(keys);
        return authError(403, "unable to register");
      }
      await this.audit("auth.registration_submitted", undefined, { kind: "signup", email });
      return { ok: true, status: 200, payload: { status: "pending" } };
    } finally {
      this.releaseRateLimit(keys);
    }
  }

  async login(
    request: LoginCredentials,
  ): Promise<AdminBotAuthResponse<AdminBotAuthSessionPayload>> {
    const email = request.email.trim().toLowerCase();
    const keys = rateLimitKeys(email, request.remoteIp);
    const limited = await this.checkRateLimit(keys, email, request.remoteIp);
    if (limited) {
      return limited;
    }
    try {
      const credential = await this.store.getCredentialByEmail(email);
      if (!credential) {
        // A pending registration with the right password is a real account awaiting approval; tell
        // the caller so, but only after verifying the password against its hash.
        const pending = await this.store.getPendingRegistrationByEmail(email);
        if (pending && (await verifyPasswordAsync(pending.password_scrypt, request.password))) {
          await this.audit("auth.login_failed", email, { reason: "pending_approval" });
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
          await verifyPasswordAsync(DUMMY_PASSWORD_SCRYPT, request.password);
        }
        this.recordFailure(keys);
        await this.audit("auth.login_failed", email, { reason: "unknown_email" });
        return authError(401, "invalid email or password");
      }
      if (!(await verifyPasswordAsync(credential.password_scrypt, request.password))) {
        this.recordFailure(keys);
        await this.audit("auth.login_failed", email, { reason: "bad_password" });
        return authError(401, "invalid email or password");
      }
      const member = await this.store.getLabMember(credential.member_id);
      if (!member) {
        this.recordFailure(keys);
        await this.audit("auth.login_failed", email, { reason: "member_missing" });
        return authError(401, "invalid email or password");
      }
      const started = await this.startSession(member, {
        kind: "login",
        expectedPasswordHash: credential.password_scrypt,
      });
      if (!started) {
        await this.audit("auth.login_failed", email, { reason: "credential_changed" });
        return authError(401, "invalid email or password");
      }
      const { payload } = started;
      await this.audit("auth.login_succeeded", member.id, { email });
      const loginEventId = await this.recordLoginTime(member.id);
      if (this.geolocateIp && request.remoteIp) {
        // Not awaited: geolocation is a courtesy stamp on the member record, not part of the
        // sign-in itself, and must never make login wait on a third-party API.
        void this.recordLoginLocation(member.id, request.remoteIp, {
          loginEventId,
          ...(request.device ? { device: request.device } : {}),
        });
        this.lastCheckByMember.set(member.id, {
          day: utcDay(this.now().toISOString()),
          ip: request.remoteIp,
          tz: request.device?.tz ?? "",
        });
      }
      return { ok: true, status: 200, payload, sessionToken: payload.session_token };
    } finally {
      this.releaseRateLimit(keys);
    }
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
   * Awaited and unconditional, unlike the geolocation below: a stamp that is sometimes skipped is
   * worse than no stamp at all --
   * absent means "never signed in" to five different readers.
   *
   * A single store-side patch avoids overwriting a profile edit made while a login is in flight.
   */
  private async recordLoginTime(memberId: string): Promise<string | undefined> {
    const now = this.now().toISOString();
    if (
      !(await this.store.patchLabMemberAuthFields(memberId, {
        last_login_at: now,
        updated_at: now,
      }))
    ) {
      return undefined;
    }
    // The field above is overwritten by the next sign-in and by any bulk write that touches the
    // member; this row is not. It is the difference between "is this person alive" and "how often
    // do they actually come back", and only the second one can be read after an importer has run.
    //
    // Same choke point on purpose: a login that stamps the field but not the log, or the reverse,
    // is two sources of truth that disagree with nobody able to say which drifted.
    //
    // The id is returned so the geolocation below can stamp *this* sign-in with where it came
    // from. Matching on (member, timestamp) instead would be a guess: two tabs signing in within
    // the same second are two rows, and the travel timeline is only as good as the row the
    // location lands on.
    const loginEventId = randomUUID();
    await this.store.appendLoginEvent({ id: loginEventId, member_id: memberId, at: now });
    return loginEventId;
  }

  // Fire-and-forget, same contract as the calendar invite and the approval email: the login has
  // already succeeded, so a slow or unreachable geolocation provider must never delay or fail it.
  // Called at sign-in and by the daily check in noteAccountUse; the two differ only in whether
  // there is a sign-in row to attach the place to.
  //
  // Only the inferred last_login_* / last_ip_* / last_device_* fields are written. `location` and
  // `slack_location` are self-reported and are deliberately never touched here -- an inferred
  // country must not silently overwrite what a member told us about themselves.
  //
  // Every reading is checked against the member's clock first (see `ipReadingVerdict`): an IP city
  // whose UTC offset is more than two hours from the zone the request's browser reported (else the
  // member's Slack zone) is almost always a VPN exit. That reading is still logged -- the timeline
  // is a record of what was observed, flagged `suspected_vpn` -- but it does not replace the
  // member's place, is not attached to the sign-in row, and wakes no meetup hook.
  private async recordLoginLocation(
    memberId: string,
    remoteIp: string,
    context: { loginEventId?: string; device?: AdminBotDeviceClock } = {},
  ): Promise<void> {
    const { loginEventId } = context;
    try {
      const now = this.now();
      const nowIso = now.toISOString();
      const deviceTz = usableDeviceZone(context.device?.tz);
      const offset = context.device?.offsetMinutes;
      const deviceOffset =
        typeof offset === "number" && Number.isInteger(offset) && Math.abs(offset) <= 14 * 60
          ? offset
          : undefined;
      if (deviceTz) {
        await this.recordDeviceTimezone(memberId, deviceTz, nowIso);
      }
      const location = await this.geolocateIp?.(remoteIp);
      if (!location || (!location.country && !location.continent && !location.city)) {
        return;
      }
      const member = await this.store.getLabMember(memberId);
      if (!member) {
        return;
      }
      const verdict = ipReadingVerdict({
        location,
        ...(deviceTz ? { deviceTz } : {}),
        ...(deviceOffset !== undefined ? { deviceOffsetMinutes: deviceOffset } : {}),
        ...(freshSlackTz(member, now) ? { slackTz: freshSlackTz(member, now) } : {}),
        at: now,
      });
      if (verdict.suspected_vpn) {
        // The time and the flag only: the member's place stays whatever the last trusted reading
        // said, and the map knows today's reading was set aside rather than missing.
        const patched = await this.store.patchLabMemberAuthFields(memberId, {
          last_ip_observed_at: nowIso,
          last_ip_suspected_vpn: true,
          updated_at: nowIso,
        });
        if (!patched) {
          return;
        }
        await this.audit("auth.login_location_suspected_vpn", memberId, {
          ...(location.country ? { country: location.country } : {}),
          ...(location.city ? { city: location.city } : {}),
          hours: verdict.hours,
          against: verdict.against,
        });
        await this.appendIpObservation(memberId, location, nowIso, true);
        return;
      }
      // The sign-in row first, before the member row: it is the only one of the two that is a
      // record rather than a stamp, so if the process dies between these two writes the timeline
      // is the half that survives. The member fields below can be re-derived from it; the reverse
      // is not true, because the next login overwrites them.
      // Who gets a place stamped on their sign-in, and it is now two different answers.
      //
      // It used to be the head professor alone: hers was the only travel history the lab kept, and
      // gating the write as well as the read was the point -- "a location history nobody may read
      // is still a location history, and the cheapest way not to hold 200 people's movements is
      // not to record them."
      //
      // `location_audience_city` opts the lab out of that. A standing local event whose guest list
      // is "whoever is in Zurich" cannot be answered without knowing where people are, so setting
      // it turns the stamp on for everybody. This is a real change in what the lab holds: a
      // per-login movement record for all 200 members, not one. It is deliberately a setting
      // rather than a constant so the lab opts in explicitly and can stop by clearing one field --
      // and it is named for the feature that wanted it, so anybody asking "why are we keeping
      // these" finds the answer rather than a bare boolean.
      //
      // The *read* stays where it was. `isTravelHistorySubject` still gates
      // GET /lab/members/:id/travel, so the timeline page remains hers alone; the rows collected
      // for everybody else are read only by the audience sweep, which reports a city and never a
      // history. That asymmetry is exactly what the old comment warned about, and it is now a
      // choice the lab has made rather than an oversight -- see docs/tools/adminbot-local-event.md.
      const settings = await this.store.getSettings();
      const stampEveryone = Boolean(settings?.location_audience_city?.trim());
      if (loginEventId && (stampEveryone || isTravelHistorySubject(memberId, settings))) {
        await this.store.attachLoginEventLocation(loginEventId, location);
      }
      // Patch only the inferred fields atomically so a concurrent profile edit survives.
      const patched = await this.store.patchLabMemberAuthFields(memberId, {
        // `last_login_at` is not written here. It is a fact about signing in, not about
        // geolocation succeeding, and recordLoginTime owns it -- one writer for one fact. The time
        // of this reading is `last_ip_observed_at`, which is what the map ages the city by.
        ...(location.country ? { last_login_country: location.country } : {}),
        ...(location.continent ? { last_login_continent: location.continent } : {}),
        // City and region are written together, and cleared together when this reading located
        // only a country: the merge patch keeps any key it is not given, so leaving them out would
        // let last month's city ride along with today's `last_ip_observed_at` and look fresh.
        ...(location.city
          ? { last_login_city: location.city, last_login_region: location.region ?? "" }
          : location.country
            ? { last_login_city: "", last_login_region: "" }
            : {}),
        ...(location.timezone ? { last_login_timezone: location.timezone } : {}),
        last_ip_observed_at: nowIso,
        last_ip_suspected_vpn: false,
        updated_at: nowIso,
      });
      if (!patched) {
        return;
      }
      await this.audit("auth.login_location_updated", memberId, { ...location });
      if (location.city) {
        try {
          this.afterLoginLocated?.(memberId);
        } catch (error) {
          // A meetup hook failing must not cost the location timeline below.
          this.warn(`adminbot: meetup hook after IP location failed: ${errorText(error)}`);
        }
      }
      await this.appendIpObservation(memberId, location, nowIso, false);
    } catch (error) {
      // Best-effort, per the option's own contract: logged, never thrown into a request. The
      // address is not in the message on purpose.
      this.warn(`adminbot: IP location for member ${memberId} failed: ${errorText(error)}`);
    }
  }

  // The stamp is where they are *now* and overwrites itself; this is the timeline, which is what
  // makes "when did they move" answerable and what the drift prompt reads. Appended when the
  // country or the VPN verdict changed, and otherwise once per UTC day, so the history shows the
  // member was still there today without a row per request.
  private async appendIpObservation(
    memberId: string,
    location: { country?: string; timezone?: string },
    observedAt: string,
    suspectedVpn: boolean,
  ): Promise<void> {
    if (!location.country) {
      return;
    }
    const entry = observationFor({
      memberId,
      source: "login_ip",
      raw: location.country,
      observedAt,
      // The zone the provider returned for this IP, used only to stamp the collection time in
      // local wall-clock -- it is never written to the entry's `timezone`, which stays reserved
      // for a stated zone.
      zone: location.timezone,
    });
    if (!entry) {
      return;
    }
    const candidate = suspectedVpn ? { ...entry, suspected_vpn: true } : entry;
    const latest = latestBySource(await this.store.listMemberLocations(memberId, 20)).get(
      "login_ip",
    );
    if (isNewDailyObservation(latest, candidate)) {
      await this.store.appendMemberLocation(candidate);
    }
  }

  // The browser's zone: stamped on the member (the map's device-zone fallback and the VPN check's
  // witness) and appended to the timeline as its own source when it changed. Name only.
  private async recordDeviceTimezone(memberId: string, zone: string, at: string): Promise<void> {
    await this.store.patchLabMemberAuthFields(memberId, {
      last_device_tz: zone,
      last_device_tz_at: at,
      updated_at: at,
    });
    const entry = observationFor({
      memberId,
      source: "device_timezone",
      raw: zone,
      observedAt: at,
      zone,
    });
    if (!entry) {
      return;
    }
    const latest = latestBySource(await this.store.listMemberLocations(memberId, 20)).get(
      "device_timezone",
    );
    if (latest?.raw !== entry.raw) {
      await this.store.appendMemberLocation(entry);
    }
  }

  async resolveSession(rawToken: string): Promise<AdminBotMemberPrincipal | undefined> {
    const tokenHash = hashToken(rawToken);
    const session = await this.store.getSession(tokenHash);
    if (!session || session.revoked_at) {
      return undefined;
    }
    const now = this.now();
    const nowIso = now.toISOString();
    if (session.expires_at <= nowIso) {
      return undefined;
    }
    const member = await this.store.getLabMember(session.member_id);
    if (!member) {
      return undefined;
    }
    // A fixed-expiry session needs no activity write on every authenticated request.
    if (session.last_seen_at <= new Date(now.getTime() - SESSION_TOUCH_INTERVAL_MS).toISOString()) {
      await this.store.touchSession(tokenHash, nowIso);
    }
    if (!session.impersonated_by) {
      return { kind: "member", member, session };
    }
    // A "view as" session is only as good as the admin behind it. Resolving them on every request
    // rather than trusting the row means demoting or deleting an admin ends their impersonated
    // sessions at once, instead of leaving a token that outlives their own access.
    const impersonator = await this.store.getLabMember(session.impersonated_by);
    if (!impersonator || impersonator.privilege_level !== "admin") {
      await this.store.revokeSession(tokenHash, nowIso);
      return undefined;
    }
    return { kind: "member", member, session, impersonator };
  }

  /**
   * Sample where an account is being used from, on any authenticated request, once a day.
   *
   * A session outlives the login that opened it -- weeks, for somebody who never signs out -- so
   * `login()` on its own samples a member's location roughly never, which is why the map placed 80
   * of 90 members from their profile with the IP database switched on. Every authenticated member
   * request passes through here (service tokens never do: they resolve to a service principal
   * before any session is looked at), so this is the one place that can notice the account still
   * in use, and from where.
   *
   * One lookup per member per UTC day, plus one whenever the address or the browser's zone
   * changes mid-day. The day is remembered in memory and, after a restart, read from the member's
   * own `last_ip_observed_at`, so a restart does not cost a second lookup the same day.
   *
   * Fire-and-forget: the request never waits on it and never sees its failure, which is logged.
   *
   * Skipped for members whose map visibility is "stated" or "hidden" -- they said not to place
   * them by their network, so there is no reason to look it up -- and for impersonated sessions.
   * An admin viewing the lab as somebody else is sitting at their own desk, and writing that
   * address into the member's timeline would record a movement that nobody involved ever made.
   */
  noteAccountUse(
    principal: AdminBotMemberPrincipal,
    remoteIp: string | undefined,
    device?: AdminBotDeviceClock,
  ): void {
    try {
      const { member } = principal;
      if (!this.geolocateIp || !remoteIp || principal.impersonator) {
        return;
      }
      if (memberMapVisibility(member) !== "auto") {
        return;
      }
      const day = utcDay(this.now().toISOString());
      const tz = device?.tz?.trim() ?? "";
      const last = this.lastCheckByMember.get(member.id);
      if (last) {
        if (last.day === day && last.ip === remoteIp && last.tz === tz) {
          return;
        }
      } else if (utcDay(member.last_ip_observed_at) === day) {
        // First request since a restart, and the record says today's reading is already taken.
        // Remember it, and look again only if the address or zone changes from here.
        this.lastCheckByMember.set(member.id, { day, ip: remoteIp, tz });
        return;
      }
      this.lastCheckByMember.set(member.id, { day, ip: remoteIp, tz });
      // Same fire-and-forget contract as the login path. recordLoginLocation catches its own
      // errors; the catch here is for anything that throws before it returns its promise.
      void this.recordLoginLocation(member.id, remoteIp, device ? { device } : {}).catch(
        (error: unknown) => {
          this.warn(`adminbot: daily IP check failed: ${errorText(error)}`);
        },
      );
    } catch (error) {
      this.warn(`adminbot: daily IP check failed: ${errorText(error)}`);
    }
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
  async startImpersonation(params: {
    admin: AdminBotMemberPrincipal;
    memberId: string;
  }): Promise<AdminBotAuthResponse<AdminBotAuthSessionPayload>> {
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
    const member = await this.store.getLabMember(memberId);
    if (!member) {
      return authError(404, "member not found");
    }
    const started = await this.startSession(member, {
      kind: "impersonation",
      by: admin.member.id,
      ttlMs: IMPERSONATION_TTL_MS,
    });
    if (!started) {
      throw new Error("impersonation session could not be saved");
    }
    const { payload } = started;
    // Audited on the admin, like every other governance action, and carrying the subject -- so
    // "who was looking at my account, and when" is answerable from the trail alone.
    await this.audit("auth.impersonation_started", admin.member.id, {
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
  async endImpersonation(rawToken: string): Promise<AdminBotAuthResponse<{ ended: true }>> {
    const tokenHash = hashToken(rawToken);
    const session = await this.store.getSession(tokenHash);
    if (!session?.impersonated_by) {
      return authError(400, "not an impersonated session");
    }
    if (!session.revoked_at) {
      await this.store.revokeSession(tokenHash, this.now().toISOString());
      await this.audit("auth.impersonation_ended", session.impersonated_by, {
        member_id: session.member_id,
      });
    }
    return { ok: true, status: 200, payload: { ended: true } };
  }

  async logout(rawToken: string): Promise<AdminBotAuthResponse<{ logged_out: true }>> {
    const tokenHash = hashToken(rawToken);
    const session = await this.store.getSession(tokenHash);
    if (session && !session.revoked_at) {
      await this.store.revokeSession(tokenHash, this.now().toISOString());
      await this.audit("auth.logged_out", session.member_id, {});
    }
    return { ok: true, status: 200, payload: { logged_out: true } };
  }

  async changePassword(
    memberId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<AdminBotAuthResponse<{ changed: true }>> {
    const credential = await this.store.getCredentialByMemberId(memberId);
    if (!credential || !(await verifyPasswordAsync(credential.password_scrypt, currentPassword))) {
      return authError(401, "invalid email or password");
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return authError(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const nowIso = this.now().toISOString();
    const changed = await this.store.changePasswordAndRevokeSessions(
      memberId,
      credential.password_scrypt,
      await hashPasswordAsync(newPassword),
      nowIso,
    );
    if (!changed) {
      return authError(401, "invalid email or password");
    }
    // A password change is a containment action as well as a credential update. Keeping an older
    // session alive lets whoever stole it ignore the new password entirely.
    await this.audit("auth.password_changed", memberId, {});
    return { ok: true, status: 200, payload: { changed: true } };
  }

  /**
   * Starts a "forgot my password" flow. The response is deliberately identical whether or not the
   * address has an account: this route is unauthenticated, so a distinguishable answer would turn
   * it into a membership oracle for the whole roster. Rate-limited on the same keys as login so it
   * cannot be used to spray mail at an address either.
   */
  async requestPasswordReset(request: {
    email: string;
    remoteIp?: string;
  }): Promise<AdminBotAuthResponse<{ requested: true }>> {
    const email = request.email.trim().toLowerCase();
    const keys = rateLimitKeys(email, request.remoteIp);
    const limited = await this.checkRateLimit(keys, email, request.remoteIp);
    if (limited) {
      return limited;
    }
    try {
      this.recordFailure(keys);
      const credential = await this.store.getCredentialByEmail(email);
      if (credential) {
        const nowMs = this.now().getTime();
        const token = randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString("base64url");
        await this.store.savePasswordReset({
          token_hash: hashToken(token),
          member_id: credential.member_id,
          created_at: new Date(nowMs).toISOString(),
          expires_at: new Date(nowMs + PASSWORD_RESET_TTL_MINUTES * 60_000).toISOString(),
          used_at: null,
        });
        await this.audit("auth.password_reset_requested", credential.member_id, { email });
        void this.notifyPasswordReset(credential.email, credential.member_id, token).catch(
          () => {},
        );
      } else {
        // Audited so a burst against unknown addresses is still visible, keyed by the attempted
        // address because there is no member to attribute it to.
        await this.audit("auth.password_reset_requested", email, { email, unknown: true });
      }
      return { ok: true, status: 200, payload: { requested: true } };
    } finally {
      this.releaseRateLimit(keys);
    }
  }

  /**
   * Redeems a reset token and sets the new password. Every outstanding token for the member is
   * burned on success, and so is every live session: a password reset is exactly the moment where
   * "somebody else may be signed in as me" has to stop being true.
   */
  async resetPassword(request: {
    token: string;
    newPassword: string;
  }): Promise<AdminBotAuthResponse<{ reset: true }>> {
    const token = request.token.trim();
    if (!token) {
      return authError(400, "reset link is invalid or has expired");
    }
    const reset = await this.store.getPasswordResetByTokenHash(hashToken(token));
    const nowIso = this.now().toISOString();
    // One message for missing/used/expired alike: which of the three it is tells an attacker
    // whether a guessed token ever existed.
    if (!reset || reset.used_at || reset.expires_at <= nowIso) {
      return authError(400, "reset link is invalid or has expired");
    }
    if (request.newPassword.length < MIN_PASSWORD_LENGTH) {
      return authError(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const changed = await this.store.consumePasswordResetAndRevokeSessions(
      hashToken(token),
      await hashPasswordAsync(request.newPassword),
      this.now().toISOString(),
    );
    if (!changed) {
      return authError(400, "reset link is invalid or has expired");
    }
    await this.audit("auth.password_reset_completed", reset.member_id, {});
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
  private passwordResetRecipient(
    loginEmail: string,
    member: AdminBotLabMember | undefined,
  ): string {
    const correspondence =
      typeof member?.correspondence_email === "string" ? member.correspondence_email.trim() : "";
    return correspondence || loginEmail;
  }

  private async notifyPasswordReset(
    loginEmail: string,
    memberId: string,
    token: string,
  ): Promise<void> {
    if (!this.sendPasswordResetEmail) {
      return;
    }
    const member = await this.store.getLabMember(memberId);
    const name = typeof member?.name === "string" ? member.name : undefined;
    const email = this.passwordResetRecipient(loginEmail, member);
    void this.sendPasswordResetEmail({
      email,
      ...(name ? { name } : {}),
      token,
      expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
    })
      .then(
        () => this.audit("auth.password_reset_email_sent", memberId, { email }),
        (error: unknown) =>
          this.audit("auth.password_reset_email_failed", memberId, {
            email,
            error: error instanceof Error ? error.message : String(error),
          }),
      )
      .catch(() => {});
  }

  // Self-service change of the member's login email. Reverifies the current password (rate-limited
  // like login), then updates both the credential row (the login identifier) and the member record
  // so they never drift. Existing sessions are keyed by token hash, not email, so they stay valid.
  async changeEmail(
    memberId: string,
    newEmail: string,
    currentPassword: string,
    remoteIp?: string,
  ): Promise<AdminBotAuthResponse<{ email: string }>> {
    const credential = await this.store.getCredentialByMemberId(memberId);
    // No credential means this principal cannot own a login email; caller gates non-members too.
    if (!credential) {
      return authError(401, "invalid password");
    }
    const keys = rateLimitKeys(credential.email, remoteIp);
    const limited = await this.checkRateLimit(keys, credential.email, remoteIp);
    if (limited) {
      return limited;
    }
    try {
      if (!(await verifyPasswordAsync(credential.password_scrypt, currentPassword))) {
        this.recordFailure(keys);
        return authError(401, "invalid password");
      }
      const email = newEmail.trim().toLowerCase();
      if (!isValidEmail(email)) {
        return authError(400, "invalid email");
      }
      // No domain rule here on purpose: a cs.toronto.edu address is preferred, not required, and
      // `validateMemberEmail` on the roster side was loosened to match. Format is the whole check.
      // Generic 409 for any other credential or pending registration holding the email so a caller
      // cannot probe which addresses exist. Re-using the member's own current email is a no-op.
      const existing = await this.store.getCredentialByEmail(email);
      const takenByOther = existing && existing.member_id !== memberId;
      if (takenByOther || (await this.store.getPendingRegistrationByEmail(email))) {
        return authError(409, "email unavailable");
      }
      const nowIso = this.now().toISOString();
      const changed = await this.store.changeMemberLoginEmail(
        memberId,
        email,
        credential.password_scrypt,
        nowIso,
      );
      if (changed === "stale") {
        return authError(401, "invalid password");
      }
      if (changed === "taken") {
        return authError(409, "email unavailable");
      }
      await this.audit("auth.email_changed", memberId, { email });
      return { ok: true, status: 200, payload: { email } };
    } finally {
      this.releaseRateLimit(keys);
    }
  }

  // The store commits the decision, credential and any new roster member as one transaction.
  async approveRegistration(
    id: string,
    decidedBy: string,
  ): Promise<
    AdminBotAuthResponse<{
      status: "approved";
      member_id: string;
      member_created: boolean;
      /** The account's address, which a signed-up member's roster record may not carry. */
      email: string;
    }>
  > {
    if (this.registrationDecisionsInFlight.has(id)) {
      return authError(409, "registration decision in progress");
    }
    this.registrationDecisionsInFlight.add(id);
    try {
      const registration = await this.store.getAccountRegistration(id);
      if (!registration || registration.status !== "pending") {
        return authError(404, "registration not found");
      }
      const nowIso = this.now().toISOString();
      const preparedMember =
        registration.kind === "signup"
          ? await this.prepareMember(signupMemberInput(registration))
          : undefined;
      const approved = await this.store.tryApproveRegistration(
        id,
        decidedBy,
        nowIso,
        preparedMember,
      );
      if (!approved.ok) {
        return authError(
          approved.reason === "not_pending" ? 404 : 409,
          approved.reason === "not_pending" ? "registration not found" : "registration conflict",
        );
      }
      const memberId = approved.member_id;
      let memberHookError: string | undefined;
      if (preparedMember && this.afterMemberCreated) {
        try {
          await this.afterMemberCreated(preparedMember);
        } catch (error) {
          memberHookError = error instanceof Error ? error.message : String(error);
        }
      }
      await this.audit("auth.registration_approved", decidedBy, {
        registration_id: id,
        kind: registration.kind,
        member_id: memberId,
        ...(memberHookError ? { member_hook_error: memberHookError } : {}),
      });
      // Lab calendar access, the Monday meeting and the rest of onboarding are no longer granted
      // here: the route runs the shared onboarding for a member this approval created
      // (api/server.member-onboarding.ts), so a sign-up gets exactly what its access level gives
      // and nothing a person added any other way would not.
      void this.notifyAccountApproved(registration.email, memberId, decidedBy).catch(() => {});
      return {
        ok: true,
        status: 200,
        payload: {
          status: "approved",
          member_id: memberId,
          member_created: Boolean(preparedMember),
          email: registration.email,
        },
      };
    } finally {
      this.registrationDecisionsInFlight.delete(id);
    }
  }

  // Fire-and-forget, same reasoning as the calendar invite: the approval is already recorded, so a
  // failed mail is audited for follow-up rather than rolled back. Short transient failures are
  // retried because this message is the member's only guaranteed delivery of the dashboard URL.
  private async notifyAccountApproved(
    email: string,
    memberId: string,
    decidedBy: string,
  ): Promise<void> {
    if (!this.sendAccountApprovedEmail) {
      return;
    }
    const name = (await this.store.getLabMember(memberId))?.name;
    void this.sendAccountApprovedWithRetry({ email, ...(name ? { name } : {}) })
      .then(
        (attempts) =>
          this.audit("auth.approval_email_sent", decidedBy, {
            member_id: memberId,
            email,
            attempts,
          }),
        (error: unknown) =>
          this.audit("auth.approval_email_failed", decidedBy, {
            member_id: memberId,
            email,
            attempts: APPROVAL_EMAIL_MAX_ATTEMPTS,
            error: error instanceof Error ? error.message : String(error),
          }),
      )
      .catch(() => {});
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
    for (const event of await this.store.listAuditEvents()) {
      if (event.type !== "auth.calendar_invite_sent") {
        continue;
      }
      // Keyed by member *and* address: a share to an old non-Google login does not count as
      // access, so a member whose Gmail changed is invited again at the new address.
      const memberId = event.details?.member_id;
      const email = event.details?.email;
      if (typeof memberId === "string" && typeof email === "string") {
        invited.add(`${memberId}:${email.trim().toLowerCase()}`);
      }
    }
    const noAddress: Array<{ id: string; name: string }> = [];
    const candidates: Array<{ id: string; name: string; email: string }> = [];
    for (const member of await this.store.listLabMembers()) {
      if (!belongsOnSurface(member, "lab_calendar")) {
        continue;
      }
      // Only a Google account: an ACL to a departmental alias is accepted by Google but cannot
      // open the calendar. No Calendar email and no Gmail is reported, never guessed.
      const email = adminBotCalendarShareEmail(member);
      if (!email) {
        noAddress.push({ id: member.id, name: member.name });
        continue;
      }
      if (invited.has(`${member.id}:${email.toLowerCase()}`)) {
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
          // Silent, like every calendar grant (see CalendarInviteRunner).
          await this.inviteToLabCalendar(candidate.email);
          await this.audit("auth.calendar_invite_sent", params.actorId, {
            member_id: candidate.id,
            email: candidate.email,
            backfill: true,
          });
          granted.push(candidate);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.audit("auth.calendar_invite_failed", params.actorId, {
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

  async rejectRegistration(
    id: string,
    decidedBy: string,
  ): Promise<AdminBotAuthResponse<{ status: "rejected" }>> {
    if (this.registrationDecisionsInFlight.has(id)) {
      return authError(409, "registration decision in progress");
    }
    this.registrationDecisionsInFlight.add(id);
    try {
      const registration = await this.store.getAccountRegistration(id);
      if (!registration || registration.status !== "pending") {
        return authError(404, "registration not found");
      }
      const rejected = await this.store.updateAccountRegistrationDecision(
        id,
        "rejected",
        decidedBy,
        this.now().toISOString(),
      );
      if (!rejected) {
        return authError(404, "registration not found");
      }
      await this.audit("auth.registration_rejected", decidedBy, {
        registration_id: id,
        kind: registration.kind,
      });
      return { ok: true, status: 200, payload: { status: "rejected" } };
    } finally {
      this.registrationDecisionsInFlight.delete(id);
    }
  }

  // Anonymous results stay bounded even when the lab roster grows; the store filters claimed and
  // pending profiles before LIMIT so a busy first page cannot hide eligible members.
  async listRoster(query = ""): Promise<AdminBotRosterEntry[]> {
    return await this.store.searchUnclaimedRoster(query.trim(), 20);
  }

  // Admin review list. Adds member name for claims and the proposed profile for signups; never
  // includes the password hash.
  async listRegistrations(
    status: AdminBotRegistrationStatus = "pending",
  ): Promise<AdminBotRegistrationView[]> {
    const registrations: AdminBotRegistrationView[] = [];
    for (const registration of await this.store.listAccountRegistrations(status)) {
      registrations.push({
        id: registration.id,
        kind: registration.kind,
        email: registration.email,
        status: registration.status,
        created_at: registration.created_at,
        ...(registration.member_id ? { member_id: registration.member_id } : {}),
        ...(registration.kind === "claim" && registration.member_id
          ? { member_name: (await this.store.getLabMember(registration.member_id))?.name }
          : {}),
        ...(registration.kind === "signup" && registration.profile_json
          ? { profile: JSON.parse(registration.profile_json) as Record<string, unknown> }
          : {}),
      });
    }
    return registrations;
  }

  private async newRegistration(
    kind: AdminBotRegistrationKind,
    email: string,
    password: string,
    extra: { member_id?: string; profile_json?: string },
  ): Promise<AdminBotAccountRegistration> {
    return {
      id: `reg_${randomUUID()}`,
      kind,
      email,
      password_scrypt: await hashPasswordAsync(password),
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

  private async startSession(
    member: AdminBotLabMember,
    request:
      | { kind: "login"; expectedPasswordHash: string }
      | { kind: "impersonation"; by: string; ttlMs: number },
  ): Promise<{ payload: AdminBotAuthSessionPayload } | undefined> {
    const rawToken = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    const nowMs = this.now().getTime();
    const createdIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(
      nowMs + (request.kind === "impersonation" ? request.ttlMs : this.sessionTtlMs),
    ).toISOString();
    // New sessions are much rarer than authenticated requests; prune expired rows here.
    await this.store.pruneSessionsBefore(createdIso);
    const session: AdminBotAuthSession = {
      token_hash: hashToken(rawToken),
      member_id: member.id,
      created_at: createdIso,
      expires_at: expiresIso,
      last_seen_at: createdIso,
      ...(request.kind === "impersonation" ? { impersonated_by: request.by } : {}),
    };
    if (request.kind === "login") {
      if (
        !(await this.store.saveSessionIfCredentialCurrent(session, request.expectedPasswordHash))
      ) {
        return undefined;
      }
    } else {
      await this.store.saveSession(session);
    }
    return {
      payload: {
        session_token: rawToken,
        expires_at: expiresIso,
        member,
        ...(this.gatewayUrl ? { gateway: { url: this.gatewayUrl } } : {}),
      },
    };
  }

  private async checkRateLimit(
    keys: string[],
    email: string,
    remoteIp: string | undefined,
  ): Promise<(AdminBotAuthResponse<never> & { ok: false }) | undefined> {
    const nowMs = this.now().getTime();
    for (const key of keys) {
      const failures = this.recentFailures(key, nowMs);
      if (
        failures.length >= RATE_LIMIT_MAX_FAILURES ||
        (this.inFlightByKey.get(key) ?? 0) >= RATE_LIMIT_MAX_IN_FLIGHT
      ) {
        const retryAfterMs = failures[0] ? failures[0] + RATE_LIMIT_WINDOW_MS - nowMs : 1000;
        const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
        await this.audit("auth.rate_limited", email, {
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
    for (const key of keys) {
      this.inFlightByKey.set(key, (this.inFlightByKey.get(key) ?? 0) + 1);
    }
    return undefined;
  }

  private releaseRateLimit(keys: string[]): void {
    for (const key of keys) {
      const remaining = (this.inFlightByKey.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.inFlightByKey.set(key, remaining);
      } else {
        this.inFlightByKey.delete(key);
      }
    }
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

  private async audit(
    type: AdminBotAuditEvent["type"],
    actor: string | undefined,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.store.recordAudit({
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

// Request handlers use libuv's worker pool for scrypt so password checks do not stall unrelated
// page requests on the Node event loop. One-off CLI scripts can keep the synchronous helper above.
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = await derivePassword(password, salt, SCRYPT_KEYLEN, {
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
  const parsed = parsePasswordHash(serialized);
  if (!parsed) {
    return false;
  }
  const derived = scryptSync(password, parsed.salt, parsed.expected.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return timingSafeEqual(parsed.expected, derived);
}

export async function verifyPasswordAsync(serialized: string, password: string): Promise<boolean> {
  const parsed = parsePasswordHash(serialized);
  if (!parsed) {
    return false;
  }
  try {
    const derived = await derivePassword(password, parsed.salt, parsed.expected.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_MAXMEM,
    });
    return timingSafeEqual(parsed.expected, derived);
  } catch {
    return false;
  }
}

function parsePasswordHash(serialized: string): {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
} | null {
  const parts = serialized.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return null;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return null;
  }
  const expected = Buffer.from(parts[5], "base64url");
  const salt = Buffer.from(parts[4], "base64url");
  if (!salt.length || !expected.length) {
    return null;
  }
  return { n, r, p, salt, expected };
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

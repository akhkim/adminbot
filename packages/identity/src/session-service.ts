import { randomBytes, randomUUID } from "node:crypto";
import type {
  AccessRoleName,
  AuthenticatedSessionRecord,
  TransactionBoundary,
} from "@adminbot/ports";
import { IdentityKeyDeriver } from "./keys.js";
import { ScryptPasswordHasher, type PasswordHasher } from "./password.js";
import { SessionValidationError, validateLoginInput } from "./session-validation.js";

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_RECENT_REAUTHENTICATION_MS = 15 * 60 * 1_000;
const DEFAULT_TOUCH_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000;
const DEFAULT_MAXIMUM_ATTEMPTS = 10;
const SESSION_TOKEN_BYTES = 32;

export interface SessionServiceOptions {
  readonly transactions: TransactionBoundary;
  readonly organizationId: string;
  readonly keySecret: string | Buffer;
  readonly passwordHasher?: PasswordHasher;
  readonly dummyPasswordHash?: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly createToken?: () => string;
  readonly sessionTtlMs?: number;
  readonly recentReauthenticationMs?: number;
  readonly touchIntervalMs?: number;
  readonly rateLimitWindowMs?: number;
  readonly maximumAttempts?: number;
}

export interface SessionRequestContext {
  readonly remoteAddress?: string;
}

export type AuthenticationLevel = "single_factor" | "recent_reauthentication";

export interface SessionViewBody {
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly authenticationLevel: AuthenticationLevel;
  readonly person: {
    readonly id: string;
    readonly organizationId: string;
    readonly displayName: string;
    readonly status: "active";
    readonly version: number;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly roles: readonly AccessRoleName[];
}

export interface AuthenticatedHumanSession {
  readonly sessionId: string;
  readonly accountId: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly roles: readonly AccessRoleName[];
  readonly authenticationLevel: AuthenticationLevel;
  readonly expiresAt: Date;
  readonly view: SessionViewBody;
}

export interface SessionErrorBody {
  readonly code:
    | "not_authenticated"
    | "account_pending_approval"
    | "payload_invalid"
    | "rate_limited";
  readonly message: string;
  readonly retryable: boolean;
}

export type SessionLoginResult =
  | Readonly<{
      ok: true;
      status: 200;
      body: SessionViewBody;
      credential: { readonly token: string; readonly maximumAgeSeconds: number };
    }>
  | Readonly<{
      ok: false;
      status: 400 | 401 | 403 | 429;
      body: SessionErrorBody;
      retryAfterSeconds?: number;
    }>;

export type CurrentSessionResult =
  | Readonly<{ ok: true; status: 200; body: SessionViewBody }>
  | Readonly<{ ok: false; status: 401; body: SessionErrorBody }>;

export class SessionService {
  private readonly transactions: TransactionBoundary;
  private readonly organizationId: string;
  private readonly keys: IdentityKeyDeriver;
  private readonly passwordHasher: PasswordHasher;
  private readonly dummyPasswordHash: Promise<string>;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly createToken: () => string;
  private readonly sessionTtlMs: number;
  private readonly recentReauthenticationMs: number;
  private readonly touchIntervalMs: number;
  private readonly rateLimitWindowMs: number;
  private readonly maximumAttempts: number;

  constructor(options: SessionServiceOptions) {
    if (!isUuid(options.organizationId)) throw new Error("organizationId must be a UUID");
    this.transactions = options.transactions;
    this.organizationId = options.organizationId;
    this.keys = new IdentityKeyDeriver(options.keySecret);
    this.passwordHasher = options.passwordHasher ?? new ScryptPasswordHasher();
    this.dummyPasswordHash =
      options.dummyPasswordHash === undefined
        ? this.passwordHasher.hash(randomBytes(32).toString("base64url"))
        : Promise.resolve(options.dummyPasswordHash);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.createToken =
      options.createToken ?? (() => randomBytes(SESSION_TOKEN_BYTES).toString("base64url"));
    this.sessionTtlMs = positiveDuration(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS, "sessionTtlMs");
    this.recentReauthenticationMs = positiveDuration(
      options.recentReauthenticationMs,
      DEFAULT_RECENT_REAUTHENTICATION_MS,
      "recentReauthenticationMs",
    );
    this.touchIntervalMs = positiveDuration(
      options.touchIntervalMs,
      DEFAULT_TOUCH_INTERVAL_MS,
      "touchIntervalMs",
    );
    this.rateLimitWindowMs = positiveDuration(
      options.rateLimitWindowMs,
      DEFAULT_RATE_LIMIT_WINDOW_MS,
      "rateLimitWindowMs",
    );
    this.maximumAttempts = positiveInteger(
      options.maximumAttempts,
      DEFAULT_MAXIMUM_ATTEMPTS,
      "maximumAttempts",
    );
  }

  async login(
    input: unknown,
    context: SessionRequestContext = {},
  ): Promise<SessionLoginResult> {
    let request;
    try {
      request = validateLoginInput(input);
    } catch (error) {
      if (!(error instanceof SessionValidationError)) throw error;
      return failure(400, "payload_invalid", error.message);
    }

    const now = this.now();
    const rateLimitKeys = this.rateLimitKeys(request.email, context.remoteAddress);
    const retryAfterSeconds = await this.transactions.write(({ rateLimits }) =>
      rateLimits.consume({
        keys: rateLimitKeys,
        now,
        windowMs: this.rateLimitWindowMs,
        maximumAttempts: this.maximumAttempts,
      }),
    );
    if (retryAfterSeconds !== undefined) {
      return {
        ...failure(429, "rate_limited", "too many attempts", true),
        retryAfterSeconds,
      };
    }

    const material = await this.transactions.read(async ({ sessions }) => ({
      account: await sessions.findLoginIdentity(this.organizationId, request.email),
      pending: await sessions.findOpenRegistrationLogin(this.organizationId, request.email),
    }));

    if (material.account === undefined) {
      const pendingMatches =
        material.pending === undefined
          ? await this.passwordHasher.verify(await this.dummyPasswordHash, request.password)
          : await this.passwordHasher.verify(material.pending.passwordHash, request.password);
      if (material.pending !== undefined && pendingMatches) {
        await this.resetRateLimit(rateLimitKeys);
        await this.recordLoginEvent("identity.login_failed", undefined, "pending_approval", now);
        return failure(403, "account_pending_approval", "account pending approval");
      }
      await this.recordLoginEvent("identity.login_failed", undefined, "credentials_invalid", now);
      return failure(401, "not_authenticated", "invalid email or password");
    }

    const account = material.account;
    const passwordMatches = await this.passwordHasher.verify(account.passwordHash, request.password);
    if (
      !passwordMatches ||
      account.accountStatus !== "active" ||
      account.personStatus !== "active"
    ) {
      await this.recordLoginEvent(
        "identity.login_failed",
        account.personId,
        "credentials_invalid",
        now,
      );
      return failure(401, "not_authenticated", "invalid email or password");
    }

    const rawToken = this.createToken();
    assertSessionToken(rawToken);
    const sessionId = this.createId();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    const created = await this.transactions.write(async ({ audit, sessions }) => {
      const stored = await sessions.createSession({
        id: sessionId,
        accountId: account.accountId,
        tokenHash: this.keys.sessionToken(rawToken),
        now,
        expiresAt,
      });
      if (!stored) return false;
      await audit.append({
        id: this.createId(),
        organizationId: this.organizationId,
        eventType: "identity.login_succeeded",
        actorId: account.accountId,
        subjectId: account.personId,
        safeDetails: { authenticationLevel: "recent_reauthentication" },
        occurredAt: now,
      });
      return true;
    });
    if (!created) return failure(401, "not_authenticated", "invalid email or password");

    await this.resetRateLimit(rateLimitKeys);
    const authenticated = await this.authenticate(rawToken, { touch: false });
    if (authenticated === undefined) {
      throw new Error("newly created session could not be resolved");
    }
    return {
      ok: true,
      status: 200,
      body: authenticated.view,
      credential: {
        token: rawToken,
        maximumAgeSeconds: Math.floor(this.sessionTtlMs / 1_000),
      },
    };
  }

  async current(rawToken: string | undefined): Promise<CurrentSessionResult> {
    const authenticated = await this.authenticate(rawToken);
    return authenticated === undefined
      ? failure(401, "not_authenticated", "authentication required")
      : { ok: true, status: 200, body: authenticated.view };
  }

  async authenticate(
    rawToken: string | undefined,
    options: { readonly touch?: boolean } = {},
  ): Promise<AuthenticatedHumanSession | undefined> {
    if (!isSessionToken(rawToken)) return undefined;
    const now = this.now();
    const session = await this.transactions.read(({ sessions }) =>
      sessions.findSession(this.organizationId, this.keys.sessionToken(rawToken), now),
    );
    if (
      session === undefined ||
      session.revokedAt !== undefined ||
      session.expiresAt <= now ||
      session.accountStatus !== "active" ||
      session.personStatus !== "active"
    ) {
      return undefined;
    }
    if (
      options.touch !== false &&
      now.getTime() - session.lastSeenAt.getTime() >= this.touchIntervalMs
    ) {
      await this.transactions.write(({ sessions }) => sessions.touchSession(session.sessionId, now));
    }
    return authenticatedSession(session, now, this.recentReauthenticationMs);
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!isSessionToken(rawToken)) return;
    const now = this.now();
    await this.transactions.write(async ({ audit, sessions }) => {
      const session = await sessions.findSession(
        this.organizationId,
        this.keys.sessionToken(rawToken),
        now,
      );
      const revoked = await sessions.revokeSession({
        tokenHash: this.keys.sessionToken(rawToken),
        revokedAt: now,
        reason: "logout",
      });
      if (revoked && session !== undefined) {
        await audit.append({
          id: this.createId(),
          organizationId: this.organizationId,
          eventType: "identity.session_revoked",
          actorId: session.accountId,
          subjectId: session.sessionId,
          safeDetails: { reason: "logout" },
          occurredAt: now,
        });
      }
    });
  }

  private rateLimitKeys(email: string, remoteAddress: string | undefined): readonly string[] {
    const keys = [this.keys.loginEmailAttempt(this.organizationId, email)];
    const address = remoteAddress?.trim();
    if (address !== undefined && address.length > 0) {
      keys.push(this.keys.loginAddressAttempt(this.organizationId, address.slice(0, 128)));
    }
    return keys;
  }

  private resetRateLimit(keys: readonly string[]): Promise<void> {
    return this.transactions.write(({ rateLimits }) => rateLimits.reset(keys));
  }

  private recordLoginEvent(
    eventType: string,
    subjectId: string | undefined,
    reason: string,
    occurredAt: Date,
  ): Promise<void> {
    return this.transactions.write(({ audit }) =>
      audit.append({
        id: this.createId(),
        organizationId: this.organizationId,
        eventType,
        ...(subjectId === undefined ? {} : { subjectId }),
        safeDetails: { reason },
        occurredAt,
      }),
    );
  }
}

function authenticatedSession(
  session: AuthenticatedSessionRecord,
  now: Date,
  recentReauthenticationMs: number,
): AuthenticatedHumanSession {
  const authenticationLevel =
    now.getTime() - session.lastReauthenticatedAt.getTime() <= recentReauthenticationMs
      ? "recent_reauthentication"
      : "single_factor";
  const view: SessionViewBody = {
    sessionId: session.sessionId,
    expiresAt: session.expiresAt.toISOString(),
    authenticationLevel,
    person: {
      id: session.personId,
      organizationId: session.organizationId,
      displayName: session.displayName,
      status: "active",
      version: session.personVersion,
      createdAt: session.personCreatedAt.toISOString(),
      updatedAt: session.personUpdatedAt.toISOString(),
    },
    roles: session.roles,
  };
  return {
    sessionId: session.sessionId,
    accountId: session.accountId,
    organizationId: session.organizationId,
    personId: session.personId,
    roles: session.roles,
    authenticationLevel,
    expiresAt: session.expiresAt,
    view,
  };
}

function failure<
  Status extends 400 | 401 | 403 | 429,
  Code extends SessionErrorBody["code"],
>(
  status: Status,
  code: Code,
  message: string,
  retryable = false,
): { readonly ok: false; readonly status: Status; readonly body: SessionErrorBody } {
  return { ok: false, status, body: { code, message, retryable } };
}

function positiveDuration(
  configured: number | undefined,
  fallback: number,
  name: string,
): number {
  const value = configured ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1_000) {
    throw new Error(`${name} must be an integer of at least 1000`);
  }
  return value;
}

function positiveInteger(configured: number | undefined, fallback: number, name: string): number {
  const value = configured ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function assertSessionToken(value: string): void {
  if (!isSessionToken(value)) throw new Error("session token generator returned an invalid token");
}

function isSessionToken(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

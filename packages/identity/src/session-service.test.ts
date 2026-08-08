import type {
  AdminBotUnitOfWork,
  AuditEventInput,
  AuthenticatedSessionRecord,
  LoginIdentityRecord,
  RevokeSessionInput,
  TransactionBoundary,
} from "@adminbot/ports";
import { describe, expect, it, vi } from "vitest";
import type { PasswordHasher } from "./password.js";
import { SessionService } from "./session-service.js";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const PERSON_ID = "20000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "21000000-0000-4000-8000-000000000001";
const SESSION_ID = "22000000-0000-4000-8000-000000000001";
const KEY_SECRET = "a-test-only-session-key-secret-with-at-least-32-bytes";
const RAW_TOKEN = "a".repeat(43);
const NOW = new Date("2026-08-08T12:00:00.000Z");

describe("SessionService", () => {
  it("authenticates an active account and persists only a derived session token", async () => {
    const harness = createHarness({ account: activeAccount() });
    const service = createService(harness);

    const result = await service.login(
      { email: " ADMIN@example.com ", password: "correct password" },
      { remoteAddress: "192.0.2.20" },
    );

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      body: {
        sessionId: SESSION_ID,
        authenticationLevel: "recent_reauthentication",
        person: { id: PERSON_ID, displayName: "Synthetic Administrator" },
        roles: ["administrator"],
      },
      credential: { token: RAW_TOKEN, maximumAgeSeconds: 604_800 },
    });
    expect(harness.createdSession?.tokenHash).not.toContain(RAW_TOKEN);
    expect(harness.createdSession?.tokenHash).toMatch(/^v1:session-token:[0-9a-f]{64}$/u);
    expect(harness.audits.at(-1)).toMatchObject({
      eventType: "identity.login_succeeded",
      actorId: ACCOUNT_ID,
      subjectId: PERSON_ID,
    });
    expect(harness.resetKeys).toHaveLength(2);
  });

  it("keeps unknown, wrong-password, suspended, and inactive identities indistinguishable", async () => {
    const cases: Array<LoginIdentityRecord | undefined> = [
      undefined,
      activeAccount(),
      { ...activeAccount(), accountStatus: "suspended" },
      { ...activeAccount(), personStatus: "inactive" },
    ];
    for (const [index, account] of cases.entries()) {
      const harness = createHarness({ account });
      const service = createService(harness);
      const password = index === 0 ? "anything" : index === 1 ? "wrong" : "correct password";

      const result = await service.login({ email: "admin@example.com", password });

      expect(result).toEqual({
        ok: false,
        status: 401,
        body: {
          code: "not_authenticated",
          message: "invalid email or password",
          retryable: false,
        },
      });
      expect(harness.createdSession).toBeUndefined();
    }
  });

  it("reveals pending approval only after the submitted password is verified", async () => {
    const matching = createHarness({ pendingPasswordHash: "hash:submitted password" });
    const wrong = createHarness({ pendingPasswordHash: "hash:submitted password" });

    await expect(
      createService(matching).login({
        email: "pending@example.com",
        password: "submitted password",
      }),
    ).resolves.toMatchObject({
      status: 403,
      body: { code: "account_pending_approval" },
    });
    await expect(
      createService(wrong).login({ email: "pending@example.com", password: "wrong" }),
    ).resolves.toMatchObject({ status: 401, body: { code: "not_authenticated" } });
  });

  it("rejects expired and revoked sessions and revokes logout idempotently", async () => {
    const harness = createHarness({ account: activeAccount() });
    const service = createService(harness);
    await service.login({ email: "admin@example.com", password: "correct password" });

    await expect(service.current(RAW_TOKEN)).resolves.toMatchObject({ ok: true, status: 200 });
    await service.logout(RAW_TOKEN);
    await service.logout(RAW_TOKEN);
    await expect(service.current(RAW_TOKEN)).resolves.toMatchObject({
      ok: false,
      status: 401,
      body: { code: "not_authenticated" },
    });
    expect(harness.revocations).toHaveLength(2);
    expect(harness.audits.filter(({ eventType }) => eventType === "identity.session_revoked"))
      .toHaveLength(1);

    if (harness.session === undefined) throw new Error("expected test session");
    harness.session = { ...harness.session, expiresAt: new Date(NOW.getTime() - 1) };
    await expect(service.current(RAW_TOKEN)).resolves.toMatchObject({ status: 401 });
  });

  it("durably limits repeated login attempts by pseudonymous email and address keys", async () => {
    const harness = createHarness();
    const service = createService(harness, { maximumAttempts: 1 });
    const input = { email: "missing@example.com", password: "wrong" };
    const context = { remoteAddress: "192.0.2.50" };

    await expect(service.login(input, context)).resolves.toMatchObject({ status: 401 });
    await expect(service.login(input, context)).resolves.toMatchObject({
      status: 429,
      retryAfterSeconds: 900,
    });
    expect(harness.consumedKeys[0]).toHaveLength(2);
    expect(harness.consumedKeys[0]?.join(" ")).not.toContain("missing@example.com");
    expect(harness.consumedKeys[0]?.join(" ")).not.toContain("192.0.2.50");
  });
});

interface HarnessOptions {
  readonly account?: LoginIdentityRecord | undefined;
  readonly pendingPasswordHash?: string;
}

interface Harness {
  transactions: TransactionBoundary;
  readonly audits: AuditEventInput[];
  readonly consumedKeys: string[][];
  readonly resetKeys: string[];
  readonly revocations: RevokeSessionInput[];
  createdSession?: {
    readonly id: string;
    readonly accountId: string;
    readonly tokenHash: string;
    readonly now: Date;
    readonly expiresAt: Date;
  };
  session?: AuthenticatedSessionRecord;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const audits: AuditEventInput[] = [];
  const consumedKeys: string[][] = [];
  const resetKeys: string[] = [];
  const revocations: RevokeSessionInput[] = [];
  const attempts = new Map<string, number>();
  const harness = {
    audits,
    consumedKeys,
    resetKeys,
    revocations,
  } as Harness;
  const unitOfWork: AdminBotUnitOfWork = {
    audit: {
      append: async (input) => {
        audits.push(input);
      },
      listForOrganization: async () => [],
    },
    identity: {
      listClaimablePeople: async () => [],
      createSignupRegistration: async () => false,
      createClaimRegistration: async () => false,
    },
    legacyMigration: {
      hasCompletedRun: async () => false,
      importIdentity: async () => undefined,
    },
    outbox: { enqueue: async () => undefined, listPending: async () => [] },
    rateLimits: {
      consume: async (input) => {
        consumedKeys.push([...input.keys]);
        if (input.keys.some((key) => (attempts.get(key) ?? 0) >= input.maximumAttempts)) {
          return Math.ceil(input.windowMs / 1_000);
        }
        for (const key of input.keys) attempts.set(key, (attempts.get(key) ?? 0) + 1);
        return undefined;
      },
      reset: async (keys) => {
        resetKeys.push(...keys);
        for (const key of keys) attempts.delete(key);
      },
    },
    registrationReviews: {
      listRegistrations: async () => [],
      commitRegistrationDecision: async () => ({ status: "not_found" }),
    },
    sessions: {
      findLoginIdentity: async () => options.account,
      findOpenRegistrationLogin: async () =>
        options.pendingPasswordHash === undefined
          ? undefined
          : {
              registrationId: "30000000-0000-4000-8000-000000000001",
              passwordHash: options.pendingPasswordHash,
            },
      createSession: async (input) => {
        harness.createdSession = input;
        harness.session = sessionRecord(input.id, input.accountId, input.now, input.expiresAt);
        return true;
      },
      findSession: async (_organizationId, _tokenHash, now) => {
        const session = harness.session;
        if (
          session === undefined ||
          session.expiresAt <= now ||
          session.revokedAt !== undefined
        ) {
          return undefined;
        }
        return session;
      },
      touchSession: async () => undefined,
      revokeSession: async (input) => {
        revocations.push(input);
        if (harness.session === undefined || harness.session.revokedAt !== undefined) return false;
        harness.session = { ...harness.session, revokedAt: input.revokedAt };
        return true;
      },
    },
  };
  const transactions: TransactionBoundary = {
    read: async (work) => work(unitOfWork),
    write: async (work) => work(unitOfWork),
  };
  harness.transactions = transactions;
  return harness;
}

function createService(
  harness: Harness,
  overrides: { readonly maximumAttempts?: number } = {},
): SessionService {
  const passwordHasher: PasswordHasher = {
    hash: vi.fn(async (password) => `hash:${password}`),
    verify: vi.fn(async (serialized, password) => serialized === `hash:${password}`),
  };
  return new SessionService({
    transactions: harness.transactions,
    organizationId: ORGANIZATION_ID,
    keySecret: KEY_SECRET,
    passwordHasher,
    dummyPasswordHash: "hash:dummy",
    now: () => NOW,
    createId: () => SESSION_ID,
    createToken: () => RAW_TOKEN,
    ...overrides,
  });
}

function activeAccount(): LoginIdentityRecord {
  return {
    accountId: ACCOUNT_ID,
    organizationId: ORGANIZATION_ID,
    personId: PERSON_ID,
    displayName: "Synthetic Administrator",
    accountStatus: "active",
    personStatus: "active",
    passwordHash: "hash:correct password",
  };
}

function sessionRecord(
  sessionId: string,
  accountId: string,
  createdAt: Date,
  expiresAt: Date,
): AuthenticatedSessionRecord {
  return {
    sessionId,
    accountId,
    organizationId: ORGANIZATION_ID,
    personId: PERSON_ID,
    displayName: "Synthetic Administrator",
    personStatus: "active",
    personVersion: 1,
    personCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
    personUpdatedAt: NOW,
    accountStatus: "active",
    createdAt,
    expiresAt,
    lastSeenAt: createdAt,
    lastReauthenticatedAt: createdAt,
    roles: ["administrator"],
  };
}

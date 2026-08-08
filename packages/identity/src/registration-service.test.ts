import type {
  AdminBotUnitOfWork,
  AuditEventInput,
  ClaimablePersonRecord,
  CreateClaimRegistration,
  CreateSignupRegistration,
  OutboxEventInput,
  TransactionBoundary,
} from "@adminbot/ports";
import { describe, expect, it } from "vitest";
import type { PasswordHasher } from "./password.js";
import { RegistrationService } from "./registration-service.js";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const PERSON_ID = "20000000-0000-4000-8000-000000000001";
const KEY_SECRET = "a-test-only-registration-key-secret-with-32-bytes";

describe("RegistrationService", () => {
  it("submits a strict signup with state, safe audit, and minimal outbox atomically", async () => {
    const harness = createHarness();
    const service = createService(harness);

    const result = await service.submitSignup(
      {
        email: "  NEW.MEMBER@Example.COM ",
        password: "correct horse battery staple",
        profile: {
          displayName: "  New Member  ",
          researchTopics: [" systems ", "systems", "privacy"],
          hoursPerWeek: 20,
          timezone: "Europe/London",
          personalWebsite: "https://example.com/about",
        },
      },
      { remoteAddress: "192.0.2.10" },
    );

    expect(result).toEqual({
      ok: true,
      status: 202,
      body: {
        registrationId: "00000000-0000-4000-8000-000000000001",
        state: "submitted",
      },
    });
    expect(harness.signups).toHaveLength(1);
    expect(harness.signups[0]).toMatchObject({
      requestedLoginHandle: "new.member@example.com",
      passwordHash: "test-hash:correct horse battery staple",
      profile: {
        displayName: "New Member",
        researchTopics: ["systems", "privacy"],
        personalWebsite: "https://example.com/about",
      },
    });
    expect(harness.audits).toHaveLength(1);
    expect(harness.audits[0]?.safeDetails).toEqual({ kind: "signup" });
    expect(JSON.stringify(harness.audits)).not.toContain("new.member@example.com");
    expect(harness.outbox[0]?.payload).toEqual({
      registrationId: "00000000-0000-4000-8000-000000000001",
      kind: "signup",
      hasProposedProfile: true,
    });
  });

  it("rejects unknown profile fields before rate limiting or password work", async () => {
    const harness = createHarness();
    const service = createService(harness);

    const result = await service.submitSignup({
      email: "new@example.com",
      password: "correct horse battery staple",
      profile: { displayName: "New Member", privilegeLevel: "administrator" },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { code: "payload_invalid", retryable: false },
    });
    expect(harness.passwords).toEqual([]);
    expect(harness.consumedKeys).toEqual([]);
    expect(harness.signups).toEqual([]);
  });

  it("does not disclose why a claim or signup is unavailable", async () => {
    const harness = createHarness({ createRegistration: false });
    const service = createService(harness);

    const signup = await service.submitSignup({
      email: "taken@example.com",
      password: "correct horse battery staple",
      profile: { displayName: "Applicant" },
    });
    const claim = await service.submitClaim({
      personId: PERSON_ID,
      email: "other@example.com",
      password: "correct horse battery staple",
    });

    expect(signup).toEqual({
      ok: false,
      status: 403,
      body: { code: "not_authorized", message: "unable to register", retryable: false },
    });
    expect(claim).toEqual({
      ok: false,
      status: 403,
      body: {
        code: "not_authorized",
        message: "unable to claim this profile",
        retryable: false,
      },
    });
    expect(harness.audits).toEqual([]);
    expect(harness.outbox).toEqual([]);
  });

  it("limits all registration attempts by trusted remote address", async () => {
    const harness = createHarness();
    const service = createService(harness, { maximumAttempts: 2 });
    const request = (email: string) => ({
      email,
      password: "correct horse battery staple",
      profile: { displayName: "Applicant" },
    });

    await expect(
      service.submitSignup(request("one@example.com"), { remoteAddress: "192.0.2.20" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      service.submitSignup(request("two@example.com"), { remoteAddress: "192.0.2.20" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      service.submitSignup(request("three@example.com"), { remoteAddress: "192.0.2.20" }),
    ).resolves.toMatchObject({
      ok: false,
      status: 429,
      retryAfterSeconds: 900,
      body: { code: "rate_limited", retryable: true },
    });
    expect(harness.passwords).toHaveLength(2);
    expect(harness.signups).toHaveLength(2);
  });

  it("returns only the anonymous-safe claim roster projection", async () => {
    const harness = createHarness({
      people: [{ personId: PERSON_ID, displayName: "Synthetic Member" }],
    });
    const service = createService(harness);
    await expect(service.listClaimablePeople()).resolves.toEqual([
      { personId: PERSON_ID, displayName: "Synthetic Member" },
    ]);
  });
});

interface HarnessOptions {
  readonly createRegistration?: boolean;
  readonly people?: readonly ClaimablePersonRecord[];
}

interface Harness {
  readonly transactions: TransactionBoundary;
  readonly audits: AuditEventInput[];
  readonly outbox: OutboxEventInput[];
  readonly signups: CreateSignupRegistration[];
  readonly claims: CreateClaimRegistration[];
  readonly consumedKeys: string[][];
  readonly passwords: string[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const audits: AuditEventInput[] = [];
  const outbox: OutboxEventInput[] = [];
  const signups: CreateSignupRegistration[] = [];
  const claims: CreateClaimRegistration[] = [];
  const consumedKeys: string[][] = [];
  const attempts = new Map<string, { count: number; startedAt: Date }>();
  const unitOfWork: AdminBotUnitOfWork = {
    audit: {
      append: async (input) => {
        audits.push(input);
      },
      listForOrganization: async () => [],
    },
    identity: {
      listClaimablePeople: async () => options.people ?? [],
      createSignupRegistration: async (input) => {
        signups.push(input);
        return options.createRegistration ?? true;
      },
      createClaimRegistration: async (input) => {
        claims.push(input);
        return options.createRegistration ?? true;
      },
    },
    legacyMigration: {
      hasCompletedRun: async () => false,
      importIdentity: async () => undefined,
    },
    outbox: {
      enqueue: async (input) => {
        outbox.push(input);
      },
      listPending: async () => [],
    },
    rateLimits: {
      consume: async (input) => {
        consumedKeys.push([...input.keys]);
        let retryAfterMs = 0;
        for (const key of input.keys) {
          const bucket = attempts.get(key);
          if (
            bucket !== undefined &&
            bucket.count >= input.maximumAttempts &&
            bucket.startedAt.getTime() + input.windowMs > input.now.getTime()
          ) {
            retryAfterMs = Math.max(
              retryAfterMs,
              bucket.startedAt.getTime() + input.windowMs - input.now.getTime(),
            );
          }
        }
        if (retryAfterMs > 0) return Math.ceil(retryAfterMs / 1_000);
        for (const key of input.keys) {
          const bucket = attempts.get(key);
          if (
            bucket === undefined ||
            bucket.startedAt.getTime() + input.windowMs <= input.now.getTime()
          ) {
            attempts.set(key, { count: 1, startedAt: input.now });
          } else {
            bucket.count += 1;
          }
        }
        return undefined;
      },
      reset: async (keys) => {
        for (const key of keys) attempts.delete(key);
      },
    },
    registrationReviews: {
      listRegistrations: async () => [],
      commitRegistrationDecision: async () => ({ status: "not_found" }),
    },
    sessions: {
      findLoginIdentity: async () => undefined,
      findOpenRegistrationLogin: async () => undefined,
      createSession: async () => false,
      findSession: async () => undefined,
      touchSession: async () => undefined,
      revokeSession: async () => false,
    },
  };
  const transactions: TransactionBoundary = {
    read: async (work) => work(unitOfWork),
    write: async (work) => work(unitOfWork),
  };
  return {
    transactions,
    audits,
    outbox,
    signups,
    claims,
    consumedKeys,
    passwords: [],
  };
}

function createService(
  harness: Harness,
  overrides: { readonly maximumAttempts?: number } = {},
): RegistrationService {
  let nextId = 1;
  const passwordHasher: PasswordHasher = {
    hash: async (password) => {
      harness.passwords.push(password);
      return `test-hash:${password}`;
    },
    verify: async (serialized, password) => serialized === `test-hash:${password}`,
  };
  return new RegistrationService({
    transactions: harness.transactions,
    organizationId: ORGANIZATION_ID,
    keySecret: KEY_SECRET,
    passwordHasher,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    createId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    ...overrides,
  });
}

import type {
  AdminBotUnitOfWork,
  AuditEventInput,
  OutboxEventInput,
  RegistrationDecisionCommit,
  RegistrationDecisionCommitResult,
  RegistrationReviewRecord,
  TransactionBoundary,
} from "@adminbot/ports";
import { describe, expect, it } from "vitest";
import { RegistrationReviewService } from "./registration-review-service.js";
import type { AuthenticatedHumanSession } from "./session-service.js";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const ADMIN_PERSON_ID = "20000000-0000-4000-8000-000000000001";
const ADMIN_ACCOUNT_ID = "21000000-0000-4000-8000-000000000001";
const REGISTRATION_ID = "30000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-08T12:00:00.000Z");

describe("RegistrationReviewService", () => {
  it("denies anonymous and non-administrator callers before repository access", async () => {
    const harness = createHarness();
    const service = createService(harness);

    await expect(service.list(undefined)).resolves.toMatchObject({
      status: 401,
      body: { code: "not_authenticated" },
    });
    await expect(service.list(actor(["member"]))).resolves.toMatchObject({
      status: 403,
      body: { code: "not_authorized" },
    });
    expect(harness.listCalls).toEqual([]);
  });

  it("lists only the requested safe registration projection", async () => {
    const harness = createHarness({ registrations: [submittedSignup()] });
    const service = createService(harness);

    const result = await service.list(actor(["administrator"]), "submitted");

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      body: [
        {
          id: REGISTRATION_ID,
          kind: "signup",
          requestedLoginHandle: "applicant@example.com",
          requestedDisplayName: "Synthetic Applicant",
          state: "submitted",
          profile: { displayName: "Synthetic Applicant" },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("password");
    expect(harness.listCalls).toEqual(["submitted"]);
  });

  it("requires recent administrator authentication for a membership decision", async () => {
    const harness = createHarness();
    const service = createService(harness);

    await expect(
      service.decide(
        actor(["administrator"], "single_factor"),
        REGISTRATION_ID,
        { decision: "approve" },
      ),
    ).resolves.toMatchObject({
      status: 403,
      body: { message: "recent reauthentication required" },
    });
    expect(harness.commits).toEqual([]);
  });

  it("approves atomically with a least-privileged default, audit, and outbox event", async () => {
    const decided = {
      ...submittedSignup(),
      status: "approved" as const,
      linkedPersonId: "20000000-0000-4000-8000-000000000010",
      reviewedByPersonId: ADMIN_PERSON_ID,
      reviewedAt: NOW,
      version: 2,
    };
    const harness = createHarness({
      commitResult: { status: "decided", registration: decided },
    });
    const service = createService(harness);

    const result = await service.decide(actor(["administrator"]), REGISTRATION_ID, {
      decision: "approve",
      reason: " reviewed and accepted ",
    });

    expect(result).toMatchObject({ ok: true, body: { state: "approved", version: 2 } });
    expect(harness.commits[0]).toMatchObject({
      decision: "approve",
      registrationId: REGISTRATION_ID,
      actorPersonId: ADMIN_PERSON_ID,
      defaultRole: "external_collaborator",
      reason: "reviewed and accepted",
    });
    expect(harness.audits).toHaveLength(1);
    expect(harness.audits[0]).toMatchObject({
      eventType: "identity.registration_approved",
      actorId: ADMIN_ACCOUNT_ID,
      subjectId: REGISTRATION_ID,
    });
    expect(harness.outbox[0]).toMatchObject({
      eventType: "identity.registration_approved",
      aggregateId: REGISTRATION_ID,
    });
  });

  it("rejects unknown fields and maps concurrent decisions to a stable conflict", async () => {
    const invalidHarness = createHarness();
    const invalidService = createService(invalidHarness);
    await expect(
      invalidService.decide(actor(["administrator"]), REGISTRATION_ID, {
        decision: "approve",
        privilege: "administrator",
      }),
    ).resolves.toMatchObject({ status: 400, body: { code: "payload_invalid" } });

    const conflictHarness = createHarness({ commitResult: { status: "state_conflict" } });
    await expect(
      createService(conflictHarness).decide(actor(["administrator"]), REGISTRATION_ID, {
        decision: "reject",
      }),
    ).resolves.toMatchObject({ status: 409, body: { code: "conflict" } });
  });
});

interface HarnessOptions {
  readonly registrations?: readonly RegistrationReviewRecord[];
  readonly commitResult?: RegistrationDecisionCommitResult;
}

interface Harness {
  readonly transactions: TransactionBoundary;
  readonly audits: AuditEventInput[];
  readonly outbox: OutboxEventInput[];
  readonly commits: RegistrationDecisionCommit[];
  readonly listCalls: Array<RegistrationReviewRecord["status"] | undefined>;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const audits: AuditEventInput[] = [];
  const outbox: OutboxEventInput[] = [];
  const commits: RegistrationDecisionCommit[] = [];
  const listCalls: Array<RegistrationReviewRecord["status"] | undefined> = [];
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
    outbox: {
      enqueue: async (input) => {
        outbox.push(input);
      },
      listPending: async () => [],
    },
    rateLimits: { consume: async () => undefined, reset: async () => undefined },
    registrationReviews: {
      listRegistrations: async (_organizationId, state) => {
        listCalls.push(state);
        return options.registrations ?? [];
      },
      commitRegistrationDecision: async (input) => {
        commits.push(input);
        return options.commitResult ?? { status: "not_found" };
      },
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
  return { transactions, audits, outbox, commits, listCalls };
}

function createService(harness: Harness): RegistrationReviewService {
  let nextId = 1;
  return new RegistrationReviewService({
    transactions: harness.transactions,
    organizationId: ORGANIZATION_ID,
    now: () => NOW,
    createId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
  });
}

function actor(
  roles: AuthenticatedHumanSession["roles"],
  authenticationLevel: AuthenticatedHumanSession["authenticationLevel"] =
    "recent_reauthentication",
): AuthenticatedHumanSession {
  return {
    sessionId: "22000000-0000-4000-8000-000000000001",
    accountId: ADMIN_ACCOUNT_ID,
    organizationId: ORGANIZATION_ID,
    personId: ADMIN_PERSON_ID,
    roles,
    authenticationLevel,
    expiresAt: new Date("2026-08-15T12:00:00.000Z"),
    view: {
      sessionId: "22000000-0000-4000-8000-000000000001",
      expiresAt: "2026-08-15T12:00:00.000Z",
      authenticationLevel,
      person: {
        id: ADMIN_PERSON_ID,
        organizationId: ORGANIZATION_ID,
        displayName: "Synthetic Administrator",
        status: "active",
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: NOW.toISOString(),
      },
      roles,
    },
  };
}

function submittedSignup(): RegistrationReviewRecord {
  return {
    id: REGISTRATION_ID,
    organizationId: ORGANIZATION_ID,
    kind: "signup",
    status: "submitted",
    requestedLoginHandle: "applicant@example.com",
    requestedDisplayName: "Synthetic Applicant",
    profile: { displayName: "Synthetic Applicant", researchTopics: ["systems"] },
    createdAt: new Date("2026-08-07T12:00:00.000Z"),
    updatedAt: new Date("2026-08-07T12:00:00.000Z"),
    version: 1,
  };
}

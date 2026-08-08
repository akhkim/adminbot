import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openPersistence, type Persistence } from "./transaction-boundary.js";

const temporaryDirectories: string[] = [];
const openConnections: Persistence[] = [];

afterEach(async () => {
  await Promise.all(openConnections.splice(0).map(async (persistence) => persistence.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Prisma transaction boundary", () => {
  it("commits state and its audit/outbox records together", async () => {
    const persistence = openTestPersistence();
    const occurredAt = new Date("2026-08-08T12:00:00.000Z");

    await persistence.transactions.write(async ({ audit, outbox }) => {
      await audit.append({
        id: "audit-1",
        organizationId: "org-1",
        eventType: "registration.submitted",
        subjectId: "registration-1",
        safeDetails: { kind: "signup" },
        occurredAt,
      });
      await outbox.enqueue({
        id: "outbox-1",
        organizationId: "org-1",
        eventType: "registration.submitted",
        aggregateType: "registration",
        aggregateId: "registration-1",
        payload: { registrationId: "registration-1" },
        availableAt: occurredAt,
      });
    });

    const result = await persistence.transactions.read(async ({ audit, outbox }) => ({
      audit: await audit.listForOrganization("org-1"),
      outbox: await outbox.listPending({
        availableBefore: new Date("2026-08-08T12:01:00.000Z"),
      }),
    }));
    expect(result.audit).toHaveLength(1);
    expect(result.outbox).toHaveLength(1);
  });

  it("rolls back every repository when work fails", async () => {
    const persistence = openTestPersistence();

    await expect(
      persistence.transactions.write(async ({ audit }) => {
        await audit.append({
          id: "audit-rollback",
          organizationId: "org-1",
          eventType: "test.rollback",
          safeDetails: {},
          occurredAt: new Date("2026-08-08T12:00:00.000Z"),
        });
        throw new Error("synthetic failure");
      }),
    ).rejects.toThrow("synthetic failure");

    const audit = await persistence.transactions.read(({ audit }) =>
      audit.listForOrganization("org-1"),
    );
    expect(audit).toEqual([]);
  });

  it("rejects unsafe nested audit details before persistence", async () => {
    const persistence = openTestPersistence();
    await expect(
      persistence.transactions.write(({ audit }) =>
        audit.append({
          id: "audit-unsafe",
          organizationId: "org-1",
          eventType: "test.unsafe",
          safeDetails: { leaked: { secret: "value" } } as never,
          occurredAt: new Date("2026-08-08T12:00:00.000Z"),
        }),
      ),
    ).rejects.toThrow("non-safe value");
  });

  it("atomically limits attempts across pseudonymous buckets", async () => {
    const persistence = openTestPersistence();
    const startedAt = new Date("2026-08-08T12:00:00.000Z");
    const consume = (now: Date) =>
      persistence.transactions.write(({ rateLimits }) =>
        rateLimits.consume({
          keys: ["email:digest", "address:digest"],
          now,
          windowMs: 60_000,
          maximumAttempts: 2,
        }),
      );

    await expect(consume(startedAt)).resolves.toBeUndefined();
    await expect(consume(new Date("2026-08-08T12:00:01.000Z"))).resolves.toBeUndefined();
    await expect(consume(new Date("2026-08-08T12:00:02.000Z"))).resolves.toBe(58);
    await expect(consume(new Date("2026-08-08T12:01:00.000Z"))).resolves.toBeUndefined();
  });

  it("persists one open signup per organization and normalized login handle", async () => {
    const persistence = openTestPersistence();
    const now = new Date("2026-08-08T12:00:00.000Z");
    const create = (id: string) =>
      persistence.transactions.write(({ identity }) =>
        identity.createSignupRegistration({
          id,
          organizationId: "10000000-0000-4000-8000-000000000001",
          requestedLoginHandle: "synthetic@example.com",
          passwordHash: "synthetic-password-hash",
          openRequestKey: "v1:open-email:synthetic-digest",
          profile: { displayName: "Synthetic Applicant" },
          now,
        }),
      );

    await expect(create("30000000-0000-4000-8000-000000000001")).resolves.toBe(true);
    await expect(create("30000000-0000-4000-8000-000000000002")).resolves.toBe(false);
  });

  it("imports an identity batch and its replay ledger through Prisma", async () => {
    const persistence = openTestPersistence();
    const now = new Date("2026-08-08T12:00:00.000Z");

    await persistence.transactions.write(({ legacyMigration }) =>
      legacyMigration.importIdentity({
        run: {
          id: "40000000-0000-4000-8000-000000000001",
          scope: "identity",
          sourceFingerprint: "a".repeat(64),
          mapperSetVersion: "identity-test-v1",
          redactedReport: { people: 1 },
          completedAt: now,
        },
        people: [
          {
            id: "20000000-0000-4000-8000-000000000001",
            organizationId: "10000000-0000-4000-8000-000000000001",
            displayName: "Synthetic Imported Person",
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        ],
        accounts: [],
        registrations: [],
        roles: [],
        links: [
          {
            legacyMemberId: "synthetic-legacy-member",
            personId: "20000000-0000-4000-8000-000000000001",
            importedAt: now,
          },
        ],
      }),
    );

    const result = await persistence.transactions.read(async ({ identity, legacyMigration }) => ({
      completed: await legacyMigration.hasCompletedRun(
        "identity",
        "a".repeat(64),
        "identity-test-v1",
      ),
      roster: await identity.listClaimablePeople(
        "10000000-0000-4000-8000-000000000001",
      ),
    }));
    expect(result.completed).toBe(true);
    expect(result.roster).toEqual([
      {
        personId: "20000000-0000-4000-8000-000000000001",
        displayName: "Synthetic Imported Person",
      },
    ]);
  });

  it("persists session resolution and least-privileged registration approval", async () => {
    const persistence = openTestPersistence();
    const organizationId = "10000000-0000-4000-8000-000000000001";
    const adminPersonId = "20000000-0000-4000-8000-000000000001";
    const adminAccountId = "21000000-0000-4000-8000-000000000001";
    const registrationId = "30000000-0000-4000-8000-000000000001";
    const now = new Date("2026-08-08T12:00:00.000Z");
    await persistence.transactions.write(({ legacyMigration }) =>
      legacyMigration.importIdentity({
        run: {
          id: "40000000-0000-4000-8000-000000000002",
          scope: "identity",
          sourceFingerprint: "b".repeat(64),
          mapperSetVersion: "identity-session-test-v1",
          redactedReport: { people: 1, accounts: 1 },
          completedAt: now,
        },
        people: [
          {
            id: adminPersonId,
            organizationId,
            displayName: "Synthetic Administrator",
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        ],
        accounts: [
          {
            id: adminAccountId,
            organizationId,
            personId: adminPersonId,
            loginHandle: "admin@example.com",
            passwordHash: "synthetic-password-hash",
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        ],
        registrations: [],
        roles: [
          {
            id: "23000000-0000-4000-8000-000000000001",
            organizationId,
            personId: adminPersonId,
            role: "administrator",
            validFrom: now,
            assignedBy: adminPersonId,
            createdAt: now,
            updatedAt: now,
          },
        ],
        links: [
          {
            legacyMemberId: "synthetic-admin",
            personId: adminPersonId,
            importedAt: now,
          },
        ],
      }),
    );

    await persistence.transactions.write(async ({ identity, sessions }) => {
      await expect(
        sessions.createSession({
          id: "22000000-0000-4000-8000-000000000001",
          accountId: adminAccountId,
          tokenHash: "v1:session-token:synthetic",
          now,
          expiresAt: new Date("2026-08-15T12:00:00.000Z"),
        }),
      ).resolves.toBe(true);
      await expect(
        identity.createSignupRegistration({
          id: registrationId,
          organizationId,
          requestedLoginHandle: "applicant@example.com",
          passwordHash: "synthetic-applicant-password-hash",
          openRequestKey: "v1:open-email:applicant",
          profile: {
            displayName: "Synthetic Applicant",
            researchTopics: ["systems"],
          },
          now,
        }),
      ).resolves.toBe(true);
    });

    const beforeDecision = await persistence.transactions.read(async ({ sessions }) => ({
      login: await sessions.findLoginIdentity(organizationId, "admin@example.com"),
      session: await sessions.findSession(
        organizationId,
        "v1:session-token:synthetic",
        now,
      ),
    }));
    expect(beforeDecision.login).toMatchObject({ accountId: adminAccountId });
    expect(beforeDecision.session?.roles).toEqual(["administrator"]);

    const decision = await persistence.transactions.write(({ registrationReviews }) =>
      registrationReviews.commitRegistrationDecision({
        decision: "approve",
        organizationId,
        registrationId,
        actorPersonId: adminPersonId,
        accountId: "21000000-0000-4000-8000-000000000002",
        signupPersonId: "20000000-0000-4000-8000-000000000002",
        roleAssignmentId: "23000000-0000-4000-8000-000000000002",
        defaultRole: "external_collaborator",
        now,
      }),
    );
    expect(decision).toMatchObject({
      status: "decided",
      registration: { status: "approved", version: 2 },
    });

    const afterDecision = await persistence.transactions.read(
      async ({ registrationReviews, sessions, members }) => ({
        account: await sessions.findLoginIdentity(organizationId, "applicant@example.com"),
        pending: await sessions.findOpenRegistrationLogin(
          organizationId,
          "applicant@example.com",
        ),
        registrations: await registrationReviews.listRegistrations(
          organizationId,
          "approved",
        ),
        members: members === undefined ? [] : await members.list(organizationId, now),
      }),
    );
    expect(afterDecision.account).toMatchObject({
      personId: "20000000-0000-4000-8000-000000000002",
      accountStatus: "active",
    });
    expect(afterDecision.pending).toBeUndefined();
    expect(afterDecision.registrations[0]).toMatchObject({
      status: "approved",
      linkedPersonId: "20000000-0000-4000-8000-000000000002",
      profile: { researchTopics: ["systems"] },
    });
    expect(afterDecision.members).toEqual(expect.arrayContaining([
      expect.objectContaining({
        profile: expect.objectContaining({
          personId: "20000000-0000-4000-8000-000000000002",
          researchTopics: ["systems"],
        }),
        membership: expect.objectContaining({ tier: "external_collaborator" }),
      }),
    ]));
  });

  it("backfills imported people into version-checked member aggregates", async () => {
    const persistence = openTestPersistence();
    const organizationId = "10000000-0000-4000-8000-000000000001";
    const personId = "20000000-0000-4000-8000-000000000008";
    const now = new Date("2026-08-08T12:00:00.000Z");
    await persistence.transactions.write(({ legacyMigration }) => legacyMigration.importIdentity({
      run: { id: "40000000-0000-4000-8000-000000000008", scope: "identity", sourceFingerprint: "d".repeat(64), mapperSetVersion: "members-test-v1", redactedReport: { people: 1 }, completedAt: now },
      people: [{ id: personId, organizationId, displayName: "Synthetic Member", status: "active", createdAt: now, updatedAt: now }],
      accounts: [], registrations: [], roles: [], links: [{ legacyMemberId: "synthetic-member", personId, importedAt: now }],
    }));
    const updated = await persistence.transactions.write(({ members }) => {
      if (members === undefined) throw new Error("member repository missing");
      return members.updateOwnProfile({
        organizationId, personId, expectedVersion: 1,
        preferredName: "Synth", biography: "Synthetic biography",
        researchTopics: ["Systems"], now,
      });
    });
    expect(updated).toMatchObject({
      profile: { preferredName: "Synth", version: 2, researchTopics: ["Systems"] },
      membership: { tier: "external_collaborator", lifecycle: "active", version: 1 },
    });
    await expect(persistence.transactions.write(({ members }) => {
      if (members === undefined) throw new Error("member repository missing");
      return members.updateOwnProfile({ organizationId, personId, expectedVersion: 1, biography: "stale", now });
    })).resolves.toBe("conflict");
    const governed = await persistence.transactions.write(({ members }) => {
      if (members === undefined) throw new Error("member repository missing");
      return members.updateGovernance({
        organizationId, personId, expectedProfileVersion: 2, expectedMembershipVersion: 1,
        displayName: "Synthetic Canonical Member", institutionalEmail: "member@example.com",
        tier: "member", lifecycle: "active", now,
      });
    });
    expect(governed).toMatchObject({
      profile: { displayName: "Synthetic Canonical Member", institutionalEmail: "member@example.com", version: 3 },
      membership: { tier: "member", version: 2 },
    });
  });

  it("persists and version-checks availability plans with their entry replacement", async () => {
    const persistence = openTestPersistence();
    const organizationId = "10000000-0000-4000-8000-000000000001";
    const personId = "20000000-0000-4000-8000-000000000009";
    const now = new Date("2026-08-08T12:00:00.000Z");
    await persistence.transactions.write(({ legacyMigration }) => legacyMigration.importIdentity({
      run: { id: "40000000-0000-4000-8000-000000000009", scope: "identity", sourceFingerprint: "c".repeat(64), mapperSetVersion: "availability-test-v1", redactedReport: { people: 1 }, completedAt: now },
      people: [{ id: personId, organizationId, displayName: "Synthetic Planner", status: "active", createdAt: now, updatedAt: now }], accounts: [], registrations: [], roles: [], links: [{ legacyMemberId: "synthetic-planner", personId, importedAt: now }],
    }));
    const ensured = await persistence.transactions.write(({ availability }) => {
      if (availability === undefined) throw new Error("availability repository missing");
      return availability.ensure({ id: "30000000-0000-4000-8000-000000000009", organizationId, personId, timeZone: "UTC", defaultWeeklyHours: 40, now });
    });
    if (ensured === "person_not_found") throw new Error("person missing");
    const replaced = await persistence.transactions.write(({ availability }) => {
      if (availability === undefined) throw new Error("availability repository missing");
      return availability.replace({ id: ensured.id, organizationId, personId, expectedVersion: 1, timeZone: "Europe/London", defaultWeeklyHours: 35, now, entries: [{ id: "50000000-0000-4000-8000-000000000009", kind: "allocation", startsOn: "2026-08-01", endsOn: "2026-12-31", hoursPerWeek: 20, label: "Synthetic Project", visibility: "members", source: "manual", confirmedAt: now }] });
    });
    expect(replaced).toMatchObject({ version: 2, timeZone: "Europe/London", entries: [{ label: "Synthetic Project", hoursPerWeek: 20 }] });
    await expect(persistence.transactions.write(({ availability }) => {
      if (availability === undefined) throw new Error("availability repository missing");
      return availability.replace({ id: ensured.id, organizationId, personId, expectedVersion: 1, timeZone: "UTC", defaultWeeklyHours: 40, now, entries: [] });
    })).resolves.toBe("conflict");
  });
});

function openTestPersistence(): Persistence {
  const directory = mkdtempSync(join(tmpdir(), "adminbot-persistence-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "test.sqlite");
  applyCommittedMigrations(databasePath);
  const persistence = openPersistence({ databaseUrl: `file:${databasePath}` });
  openConnections.push(persistence);
  return persistence;
}

function applyCommittedMigrations(databasePath: string): void {
  const migrationRoot = fileURLToPath(new URL("../prisma/migrations", import.meta.url));
  const database = new Database(databasePath);
  try {
    const directories = readdirSync(migrationRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const directory of directories) {
      const migrationPath = join(migrationRoot, directory, "migration.sql");
      database.exec(readFileSync(migrationPath, "utf8"));
    }
  } finally {
    database.close();
  }
}

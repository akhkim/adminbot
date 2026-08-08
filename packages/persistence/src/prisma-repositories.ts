import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import type {
  AdminBotUnitOfWork,
  AuditEventRecord,
  AuditRepository,
  IdentityRepository,
  JsonValue,
  LegacyIdentityImportBatch,
  LegacyMigrationRepository,
  OutboxEventRecord,
  OutboxRepository,
  PaperRecord,
  PaperRepository,
  RateLimitRepository,
  RegistrationReviewRepository,
  RegistrationProfileRecord,
  SafeAuditDetails,
  SessionRepository,
} from "@adminbot/ports";

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly database: DatabaseClient) {}

  async append(input: Parameters<AuditRepository["append"]>[0]): Promise<void> {
    assertSafeAuditDetails(input.safeDetails);
    await this.database.auditEvent.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        eventType: input.eventType,
        safeDetails: input.safeDetails,
        occurredAt: input.occurredAt,
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
        ...(input.correlationId === undefined
          ? {}
          : { correlationId: input.correlationId }),
      },
    });
  }

  async listForOrganization(
    organizationId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly AuditEventRecord[]> {
    const rows = await this.database.auditEvent.findMany({
      where: { organizationId },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: boundedLimit(options.limit),
    });
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      eventType: row.eventType,
      safeDetails: parseSafeAuditDetails(row.safeDetails),
      occurredAt: row.occurredAt,
      ...(row.actorId === null ? {} : { actorId: row.actorId }),
      ...(row.subjectId === null ? {} : { subjectId: row.subjectId }),
      ...(row.correlationId === null ? {} : { correlationId: row.correlationId }),
    }));
  }
}

class PrismaOutboxRepository implements OutboxRepository {
  constructor(private readonly database: DatabaseClient) {}

  async enqueue(input: Parameters<OutboxRepository["enqueue"]>[0]): Promise<void> {
    await this.database.outboxEvent.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        eventType: input.eventType,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        payload: input.payload as Prisma.InputJsonValue,
        availableAt: input.availableAt,
      },
    });
  }

  async listPending(
    options: { readonly availableBefore?: Date; readonly limit?: number } = {},
  ): Promise<readonly OutboxEventRecord[]> {
    const rows = await this.database.outboxEvent.findMany({
      where: {
        status: "pending",
        availableAt: { lte: options.availableBefore ?? new Date() },
      },
      orderBy: [{ availableAt: "asc" }, { id: "asc" }],
      take: boundedLimit(options.limit),
    });
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      eventType: row.eventType,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      payload: parseJsonValue(row.payload),
      availableAt: row.availableAt,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }
}

class PrismaIdentityRepository implements IdentityRepository {
  constructor(private readonly database: DatabaseClient) {}

  async listClaimablePeople(organizationId: string) {
    const people = await this.database.person.findMany({
      where: { organizationId, status: "active", account: null },
      select: { id: true, displayName: true },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
    });
    if (people.length === 0) return [];
    const claimed = await this.database.registration.findMany({
      where: {
        organizationId,
        status: { in: ["submitted", "under_review"] },
        linkedPersonId: { in: people.map((person) => person.id) },
      },
      select: { linkedPersonId: true },
    });
    const claimedIds = new Set(
      claimed.flatMap((registration) =>
        registration.linkedPersonId === null ? [] : [registration.linkedPersonId],
      ),
    );
    return people
      .filter((person) => !claimedIds.has(person.id))
      .map((person) => ({ personId: person.id, displayName: person.displayName }));
  }

  async createSignupRegistration(input: Parameters<IdentityRepository["createSignupRegistration"]>[0]): Promise<boolean> {
    const existingAccount = await this.database.account.findUnique({
      where: {
        organizationId_loginHandle: {
          organizationId: input.organizationId,
          loginHandle: input.requestedLoginHandle,
        },
      },
      select: { id: true },
    });
    if (existingAccount !== null) return false;
    try {
      await this.database.registration.create({
        data: {
          id: input.id,
          organizationId: input.organizationId,
          kind: "signup",
          requestedLoginHandle: input.requestedLoginHandle,
          requestedDisplayName: input.profile.displayName,
          passwordHash: input.passwordHash,
          openRequestKey: input.openRequestKey,
          createdAt: input.now,
          updatedAt: input.now,
          profile: { create: profileCreateData(input.profile, input.now) },
        },
      });
      return true;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  async createClaimRegistration(input: Parameters<IdentityRepository["createClaimRegistration"]>[0]): Promise<boolean> {
    const [person, existingAccount] = await Promise.all([
      this.database.person.findUnique({
        where: {
          organizationId_id: {
            organizationId: input.organizationId,
            id: input.personId,
          },
        },
        select: { displayName: true, status: true, account: { select: { id: true } } },
      }),
      this.database.account.findUnique({
        where: {
          organizationId_loginHandle: {
            organizationId: input.organizationId,
            loginHandle: input.requestedLoginHandle,
          },
        },
        select: { id: true },
      }),
    ]);
    if (
      person === null ||
      person.status !== "active" ||
      person.account !== null ||
      existingAccount !== null
    ) {
      return false;
    }
    try {
      await this.database.registration.create({
        data: {
          id: input.id,
          organizationId: input.organizationId,
          kind: "claim",
          requestedLoginHandle: input.requestedLoginHandle,
          requestedDisplayName: person.displayName,
          passwordHash: input.passwordHash,
          openRequestKey: input.openRequestKey,
          openClaimPersonKey: input.openClaimPersonKey,
          linkedPersonId: input.personId,
          createdAt: input.now,
          updatedAt: input.now,
        },
      });
      return true;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  async findLoginIdentity(
    organizationId: string,
    loginHandle: string,
  ) {
    const account = await this.database.account.findUnique({
      where: { organizationId_loginHandle: { organizationId, loginHandle } },
      include: { person: true },
    });
    if (account === null) return undefined;
    return {
      accountId: account.id,
      organizationId: account.organizationId,
      personId: account.personId,
      displayName: account.person.displayName,
      accountStatus: account.status,
      personStatus: account.person.status,
      passwordHash: account.passwordHash,
    };
  }

  async findOpenRegistrationLogin(
    organizationId: string,
    loginHandle: string,
  ) {
    const registration = await this.database.registration.findFirst({
      where: {
        organizationId,
        requestedLoginHandle: loginHandle,
        status: { in: ["submitted", "under_review"] },
        passwordHash: { not: null },
      },
      select: { id: true, passwordHash: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return registration?.passwordHash === null || registration === null
      ? undefined
      : {
          registrationId: registration.id,
          passwordHash: registration.passwordHash,
        };
  }

  async createSession(
    input: Parameters<SessionRepository["createSession"]>[0],
  ): Promise<boolean> {
    const account = await this.database.account.findUnique({
      where: { id: input.accountId },
      select: { status: true, person: { select: { status: true } } },
    });
    if (
      account === null ||
      account.status !== "active" ||
      account.person.status !== "active"
    ) {
      return false;
    }
    await this.database.session.create({
      data: {
        id: input.id,
        accountId: input.accountId,
        tokenHash: input.tokenHash,
        createdAt: input.now,
        expiresAt: input.expiresAt,
        lastSeenAt: input.now,
        lastReauthenticatedAt: input.now,
      },
    });
    return true;
  }

  async findSession(
    organizationId: string,
    tokenHash: string,
    now: Date,
  ) {
    const session = await this.database.session.findUnique({
      where: { tokenHash },
      include: {
        account: {
          include: {
            person: {
              include: {
                roles: {
                  where: {
                    validFrom: { lte: now },
                    OR: [{ validUntil: null }, { validUntil: { gt: now } }],
                  },
                  orderBy: [{ role: "asc" }, { id: "asc" }],
                },
              },
            },
          },
        },
      },
    });
    if (
      session === null ||
      session.account.organizationId !== organizationId ||
      session.expiresAt <= now
    ) {
      return undefined;
    }
    return {
      sessionId: session.id,
      accountId: session.accountId,
      organizationId: session.account.organizationId,
      personId: session.account.personId,
      displayName: session.account.person.displayName,
      personStatus: session.account.person.status,
      personVersion: session.account.person.version,
      personCreatedAt: session.account.person.createdAt,
      personUpdatedAt: session.account.person.updatedAt,
      accountStatus: session.account.status,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      lastReauthenticatedAt: session.lastReauthenticatedAt,
      ...(session.revokedAt === null ? {} : { revokedAt: session.revokedAt }),
      roles: session.account.person.roles.map((assignment) => assignment.role),
    };
  }

  async touchSession(sessionId: string, seenAt: Date): Promise<void> {
    await this.database.session.updateMany({
      where: { id: sessionId, revokedAt: null, expiresAt: { gt: seenAt } },
      data: { lastSeenAt: seenAt },
    });
  }

  async revokeSession(
    input: Parameters<SessionRepository["revokeSession"]>[0],
  ): Promise<boolean> {
    const result = await this.database.session.updateMany({
      where: { tokenHash: input.tokenHash, revokedAt: null },
      data: {
        revokedAt: input.revokedAt,
        revocationReason: input.reason,
      },
    });
    return result.count === 1;
  }

  async listRegistrations(
    organizationId: string,
    state?: Parameters<RegistrationReviewRepository["listRegistrations"]>[1],
  ) {
    const registrations = await this.database.registration.findMany({
      where: {
        organizationId,
        status: state ?? { in: ["submitted", "under_review"] },
      },
      include: { profile: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return registrations.map(toRegistrationReviewRecord);
  }

  async commitRegistrationDecision(
    input: Parameters<RegistrationReviewRepository["commitRegistrationDecision"]>[0],
  ) {
    const registration = await this.database.registration.findUnique({
      where: { id: input.registrationId },
      include: { profile: true },
    });
    if (registration === null || registration.organizationId !== input.organizationId) {
      return { status: "not_found" as const };
    }
    if (registration.status !== "submitted" && registration.status !== "under_review") {
      return { status: "state_conflict" as const };
    }

    if (input.decision === "approve") {
      if (registration.passwordHash === null) {
        return { status: "identity_conflict" as const };
      }
      const existingAccount = await this.database.account.findUnique({
        where: {
          organizationId_loginHandle: {
            organizationId: input.organizationId,
            loginHandle: registration.requestedLoginHandle,
          },
        },
        select: { id: true },
      });
      if (existingAccount !== null) return { status: "identity_conflict" as const };

      const personId =
        registration.kind === "claim" ? registration.linkedPersonId : input.signupPersonId;
      if (personId === null) return { status: "identity_conflict" as const };
      if (registration.kind === "claim") {
        const person = await this.database.person.findUnique({
          where: {
            organizationId_id: { organizationId: input.organizationId, id: personId },
          },
          select: { status: true, account: { select: { id: true } } },
        });
        if (person === null || person.status !== "active" || person.account !== null) {
          return { status: "identity_conflict" as const };
        }
      } else {
        await this.database.person.create({
          data: {
            id: personId,
            organizationId: input.organizationId,
            displayName: registration.requestedDisplayName,
            status: "active",
            createdAt: input.now,
            updatedAt: input.now,
          },
        });
      }

      await this.database.account.create({
        data: {
          id: input.accountId,
          organizationId: input.organizationId,
          personId,
          loginHandle: registration.requestedLoginHandle,
          passwordHash: registration.passwordHash,
          status: "active",
          createdAt: input.now,
          updatedAt: input.now,
        },
      });
      if (registration.kind === "signup") {
        await this.database.roleAssignment.create({
          data: {
            id: input.roleAssignmentId,
            organizationId: input.organizationId,
            personId,
            role: input.defaultRole,
            validFrom: input.now,
            assignedBy: input.actorPersonId,
            createdAt: input.now,
            updatedAt: input.now,
          },
        });
      }
      const decided = await this.database.registration.update({
        where: { id: registration.id },
        data: {
          status: "approved",
          linkedPersonId: personId,
          reviewedByPersonId: input.actorPersonId,
          reviewedAt: input.now,
          reviewReason: input.reason ?? null,
          passwordHash: null,
          openRequestKey: null,
          openClaimPersonKey: null,
          version: { increment: 1 },
          updatedAt: input.now,
        },
        include: { profile: true },
      });
      return { status: "decided" as const, registration: toRegistrationReviewRecord(decided) };
    }

    const decided = await this.database.registration.update({
      where: { id: registration.id },
      data: {
        status: "rejected",
        reviewedByPersonId: input.actorPersonId,
        reviewedAt: input.now,
        reviewReason: input.reason ?? null,
        passwordHash: null,
        openRequestKey: null,
        openClaimPersonKey: null,
        version: { increment: 1 },
        updatedAt: input.now,
      },
      include: { profile: true },
    });
    return { status: "decided" as const, registration: toRegistrationReviewRecord(decided) };
  }

}

class PrismaRateLimitRepository implements RateLimitRepository {
  constructor(private readonly database: DatabaseClient) {}

  async consume(input: Parameters<RateLimitRepository["consume"]>[0]) {
    const keys = [...new Set(input.keys)];
    if (keys.length === 0) return undefined;
    const rows = await this.database.rateLimitBucket.findMany({
      where: { key: { in: keys } },
    });
    const rowsByKey = new Map(rows.map((row) => [row.key, row]));
    let retryAfterMs = 0;
    for (const row of rows) {
      const expiresAt = row.windowStartedAt.getTime() + input.windowMs;
      if (row.attemptCount >= input.maximumAttempts && expiresAt > input.now.getTime()) {
        retryAfterMs = Math.max(retryAfterMs, expiresAt - input.now.getTime());
      }
    }
    if (retryAfterMs > 0) return Math.ceil(retryAfterMs / 1000);

    for (const key of keys) {
      const current = rowsByKey.get(key);
      const expired =
        current === undefined ||
        current.windowStartedAt.getTime() + input.windowMs <= input.now.getTime();
      await this.database.rateLimitBucket.upsert({
        where: { key },
        create: { key, attemptCount: 1, windowStartedAt: input.now },
        update: expired
          ? { attemptCount: 1, windowStartedAt: input.now }
          : { attemptCount: { increment: 1 } },
      });
    }
    return undefined;
  }

  async reset(keys: readonly string[]): Promise<void> {
    const uniqueKeys = [...new Set(keys)];
    if (uniqueKeys.length === 0) return;
    await this.database.rateLimitBucket.deleteMany({ where: { key: { in: uniqueKeys } } });
  }
}

class PrismaPaperRepository implements PaperRepository {
  constructor(private readonly database: DatabaseClient) {}

  async list(organizationId: string): Promise<readonly PaperRecord[]> {
    const rows = await this.database.paper.findMany({
      where: { organizationId },
      orderBy: [{ deadlineAt: "asc" }, { title: "asc" }, { id: "asc" }],
    });
    return this.hydrate(rows);
  }

  async find(organizationId: string, paperId: string): Promise<PaperRecord | undefined> {
    const row = await this.database.paper.findFirst({ where: { id: paperId, organizationId } });
    return row === null ? undefined : (await this.hydrate([row]))[0];
  }

  async create(input: Parameters<PaperRepository["create"]>[0]) {
    if (!(await this.authorsExist(input.organizationId, input.authorIds))) {
      return "authors_not_found" as const;
    }
    const row = await this.database.paper.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        title: input.title,
        authorIds: [...input.authorIds],
        stage: input.stage,
        topicTags: [...input.topicTags],
        version: 1,
        createdAt: input.now,
        updatedAt: input.now,
        ...(input.targetVenue === undefined ? {} : { targetVenue: input.targetVenue }),
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
        ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
      },
    });
    return (await this.hydrate([row]))[0] as PaperRecord;
  }

  async update(input: Parameters<PaperRepository["update"]>[0]) {
    if (
      input.authorIds !== undefined &&
      !(await this.authorsExist(input.organizationId, input.authorIds))
    ) {
      return "authors_not_found" as const;
    }
    const existing = await this.database.paper.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      select: { version: true },
    });
    if (existing === null) return "not_found" as const;
    if (existing.version !== input.expectedVersion) return "conflict" as const;
    const changed = await this.database.paper.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        version: input.expectedVersion,
      },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.authorIds === undefined ? {} : { authorIds: [...input.authorIds] }),
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.targetVenue === undefined ? {} : { targetVenue: input.targetVenue }),
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
        ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
        ...(input.topicTags === undefined ? {} : { topicTags: [...input.topicTags] }),
        version: { increment: 1 },
        updatedAt: input.now,
      },
    });
    if (changed.count !== 1) return "conflict" as const;
    const row = await this.database.paper.findUniqueOrThrow({ where: { id: input.id } });
    return (await this.hydrate([row]))[0] as PaperRecord;
  }

  async delete(organizationId: string, paperId: string, expectedVersion: number) {
    const existing = await this.database.paper.findFirst({
      where: { id: paperId, organizationId },
      select: { version: true },
    });
    if (existing === null) return "not_found" as const;
    if (existing.version !== expectedVersion) return "conflict" as const;
    const deleted = await this.database.paper.deleteMany({
      where: { id: paperId, organizationId, version: expectedVersion },
    });
    return deleted.count === 1 ? ("deleted" as const) : ("conflict" as const);
  }

  private async authorsExist(organizationId: string, authorIds: readonly string[]): Promise<boolean> {
    const count = await this.database.person.count({
      where: { organizationId, id: { in: [...authorIds] }, status: "active" },
    });
    return count === new Set(authorIds).size;
  }

  private async hydrate(
    rows: readonly Prisma.PaperGetPayload<Record<string, never>>[],
  ): Promise<readonly PaperRecord[]> {
    const ids = [...new Set(rows.flatMap((row) => parseStoredStringArray(row.authorIds, "paper authors")))];
    const people = await this.database.person.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true },
    });
    const names = new Map(people.map((person) => [person.id, person.displayName]));
    return rows.map((row) => {
      const authorIds = parseStoredStringArray(row.authorIds, "paper authors");
      return {
        id: row.id,
        organizationId: row.organizationId,
        title: row.title,
        authorIds,
        authorNames: authorIds.map((id) => names.get(id) ?? id),
        stage: row.stage,
        topicTags: parseStoredStringArray(row.topicTags, "paper topics"),
        version: row.version,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.targetVenue === null ? {} : { targetVenue: row.targetVenue }),
        ...(row.deadlineAt === null ? {} : { deadlineAt: row.deadlineAt }),
        ...(row.sourceUri === null ? {} : { sourceUri: row.sourceUri }),
      };
    });
  }
}

class PrismaLegacyMigrationRepository implements LegacyMigrationRepository {
  constructor(private readonly database: DatabaseClient) {}

  async hasCompletedRun(
    scope: string,
    sourceFingerprint: string,
    mapperSetVersion: string,
  ): Promise<boolean> {
    const run = await this.database.legacyMigrationRun.findUnique({
      where: {
        scope_sourceFingerprint_mapperSetVersion: {
          scope,
          sourceFingerprint,
          mapperSetVersion,
        },
      },
      select: { status: true },
    });
    return run?.status === "completed";
  }

  async importIdentity(batch: LegacyIdentityImportBatch): Promise<void> {
    if (batch.people.length > 0) {
      await this.database.person.createMany({ data: [...batch.people] });
    }
    if (batch.accounts.length > 0) {
      await this.database.account.createMany({ data: [...batch.accounts] });
    }
    if (batch.registrations.length > 0) {
      await this.database.registration.createMany({
        data: batch.registrations.map(({ profile: _profile, ...registration }) => registration),
      });
    }
    const profiles = batch.registrations.flatMap((registration) =>
      registration.profile === undefined
        ? []
        : [
            {
              registrationId: registration.id,
              ...profileCreateData(registration.profile, registration.createdAt),
            },
          ],
    );
    if (profiles.length > 0) {
      await this.database.registrationProfile.createMany({ data: profiles });
    }
    if (batch.roles.length > 0) {
      await this.database.roleAssignment.createMany({ data: [...batch.roles] });
    }
    if (batch.links.length > 0) {
      await this.database.legacyIdentityLink.createMany({ data: [...batch.links] });
    }
    await this.database.legacyMigrationRun.create({
      data: {
        id: batch.run.id,
        scope: batch.run.scope,
        sourceFingerprint: batch.run.sourceFingerprint,
        mapperSetVersion: batch.run.mapperSetVersion,
        status: "completed",
        redactedReport: batch.run.redactedReport as Prisma.InputJsonValue,
        startedAt: batch.run.completedAt,
        completedAt: batch.run.completedAt,
      },
    });
  }
}

export function createUnitOfWork(database: DatabaseClient): AdminBotUnitOfWork {
  const identity = new PrismaIdentityRepository(database);
  return {
    audit: new PrismaAuditRepository(database),
    identity,
    legacyMigration: new PrismaLegacyMigrationRepository(database),
    outbox: new PrismaOutboxRepository(database),
    papers: new PrismaPaperRepository(database),
    rateLimits: new PrismaRateLimitRepository(database),
    registrationReviews: identity as RegistrationReviewRepository,
    sessions: identity as SessionRepository,
  };
}

function profileCreateData(profile: RegistrationProfileRecord, now: Date) {
  return {
    createdAt: now,
    updatedAt: now,
    ...(profile.slackUserId === undefined ? {} : { slackUserId: profile.slackUserId }),
    ...(profile.role === undefined ? {} : { role: profile.role }),
    ...(profile.affiliation === undefined ? {} : { affiliation: profile.affiliation }),
    ...(profile.researchBranch === undefined ? {} : { researchBranch: profile.researchBranch }),
    ...(profile.researchTopics === undefined ? {} : { researchTopics: [...profile.researchTopics] }),
    ...(profile.projects === undefined ? {} : { projects: [...profile.projects] }),
    ...(profile.hoursPerWeek === undefined ? {} : { hoursPerWeek: profile.hoursPerWeek }),
    ...(profile.location === undefined ? {} : { location: profile.location }),
    ...(profile.timezone === undefined ? {} : { timezone: profile.timezone }),
    ...(profile.personalWebsite === undefined ? {} : { personalWebsite: profile.personalWebsite }),
    ...(profile.notes === undefined ? {} : { notes: profile.notes }),
  };
}

function toRegistrationReviewRecord(
  registration: Prisma.RegistrationGetPayload<{ include: { profile: true } }>,
) {
  return {
    id: registration.id,
    organizationId: registration.organizationId,
    kind: registration.kind,
    status: registration.status,
    requestedLoginHandle: registration.requestedLoginHandle,
    requestedDisplayName: registration.requestedDisplayName,
    ...(registration.linkedPersonId === null
      ? {}
      : { linkedPersonId: registration.linkedPersonId }),
    ...(registration.profile === null
      ? {}
      : {
          profile: {
            displayName: registration.requestedDisplayName,
            ...(registration.profile.slackUserId === null
              ? {}
              : { slackUserId: registration.profile.slackUserId }),
            ...(registration.profile.role === null ? {} : { role: registration.profile.role }),
            ...(registration.profile.affiliation === null
              ? {}
              : { affiliation: registration.profile.affiliation }),
            ...(registration.profile.researchBranch === null
              ? {}
              : { researchBranch: registration.profile.researchBranch }),
            ...(registration.profile.researchTopics === null
              ? {}
              : { researchTopics: parseStringArray(registration.profile.researchTopics) }),
            ...(registration.profile.projects === null
              ? {}
              : { projects: parseStringArray(registration.profile.projects) }),
            ...(registration.profile.hoursPerWeek === null
              ? {}
              : { hoursPerWeek: registration.profile.hoursPerWeek }),
            ...(registration.profile.location === null
              ? {}
              : { location: registration.profile.location }),
            ...(registration.profile.timezone === null
              ? {}
              : { timezone: registration.profile.timezone }),
            ...(registration.profile.personalWebsite === null
              ? {}
              : { personalWebsite: registration.profile.personalWebsite }),
            ...(registration.profile.notes === null
              ? {}
              : { notes: registration.profile.notes }),
          },
        }),
    ...(registration.reviewedByPersonId === null
      ? {}
      : { reviewedByPersonId: registration.reviewedByPersonId }),
    ...(registration.reviewedAt === null ? {} : { reviewedAt: registration.reviewedAt }),
    ...(registration.reviewReason === null ? {} : { reviewReason: registration.reviewReason }),
    createdAt: registration.createdAt,
    updatedAt: registration.updatedAt,
    version: registration.version,
  };
}

function parseStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("stored registration profile array is invalid");
  }
  return value as string[];
}

function parseStoredStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`stored ${label} are invalid`);
  }
  return value as string[];
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("limit must be an integer between 1 and 500");
  }
  return limit;
}

function parseSafeAuditDetails(value: unknown): SafeAuditDetails {
  if (!isRecord(value)) throw new Error("stored audit details are not an object");
  assertSafeAuditDetails(value);
  const parsed: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    parsed[key] = item as string | number | boolean | null;
  }
  return parsed;
}

function assertSafeAuditDetails(value: unknown): asserts value is SafeAuditDetails {
  if (!isRecord(value)) throw new Error("audit details must be an object");
  for (const item of Object.values(value)) {
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw new Error("audit details contain a non-safe value");
    }
  }
}

function parseJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(parseJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, parseJsonValue(item)]));
  }
  throw new Error("stored outbox payload is not valid JSON");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  RateLimitRepository,
  RegistrationProfileRecord,
  SafeAuditDetails,
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
  return {
    audit: new PrismaAuditRepository(database),
    identity: new PrismaIdentityRepository(database),
    legacyMigration: new PrismaLegacyMigrationRepository(database),
    outbox: new PrismaOutboxRepository(database),
    rateLimits: new PrismaRateLimitRepository(database),
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

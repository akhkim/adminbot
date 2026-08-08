import type { JsonValue, RegistrationProfileRecord } from "./shared.js";

export type { JsonValue, RegistrationProfileRecord } from "./shared.js";

export type SafeAuditValue = string | number | boolean | null;
export type SafeAuditDetails = Readonly<Record<string, SafeAuditValue>>;

export interface AuditEventInput {
  readonly id: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly actorId?: string;
  readonly subjectId?: string;
  readonly correlationId?: string;
  readonly safeDetails: SafeAuditDetails;
  readonly occurredAt: Date;
}

export interface AuditEventRecord extends AuditEventInput {}

export interface AuditRepository {
  append(input: AuditEventInput): Promise<void>;
  listForOrganization(
    organizationId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly AuditEventRecord[]>;
}

export interface OutboxEventInput {
  readonly id: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: JsonValue;
  readonly availableAt: Date;
}

export interface OutboxEventRecord extends OutboxEventInput {
  readonly status: "pending" | "processing" | "delivered" | "failed";
  readonly attempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OutboxRepository {
  enqueue(input: OutboxEventInput): Promise<void>;
  listPending(options?: {
    readonly availableBefore?: Date;
    readonly limit?: number;
  }): Promise<readonly OutboxEventRecord[]>;
}

export interface RegistrationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: "claim" | "signup";
  readonly status: "submitted" | "under_review" | "approved" | "rejected" | "withdrawn";
  readonly requestedLoginHandle: string;
  readonly requestedDisplayName: string;
  readonly linkedPersonId?: string;
  readonly profile?: RegistrationProfileRecord;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface CreateSignupRegistration {
  readonly id: string;
  readonly organizationId: string;
  readonly requestedLoginHandle: string;
  readonly passwordHash: string;
  readonly openRequestKey: string;
  readonly profile: RegistrationProfileRecord;
  readonly now: Date;
}

export interface CreateClaimRegistration {
  readonly id: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly requestedLoginHandle: string;
  readonly passwordHash: string;
  readonly openRequestKey: string;
  readonly openClaimPersonKey: string;
  readonly now: Date;
}

export interface ClaimablePersonRecord {
  readonly personId: string;
  readonly displayName: string;
}

export interface IdentityRepository {
  listClaimablePeople(organizationId: string): Promise<readonly ClaimablePersonRecord[]>;
  createSignupRegistration(input: CreateSignupRegistration): Promise<boolean>;
  createClaimRegistration(input: CreateClaimRegistration): Promise<boolean>;
}

export interface ConsumeRateLimitInput {
  readonly keys: readonly string[];
  readonly now: Date;
  readonly windowMs: number;
  readonly maximumAttempts: number;
}

export interface RateLimitRepository {
  /**
   * Atomically reserves one attempt against every key. A blocked request reserves nothing and
   * returns the longest number of seconds it must wait.
   */
  consume(input: ConsumeRateLimitInput): Promise<number | undefined>;
}

/**
 * The only repository bundle a transaction callback receives. It is extended centrally as
 * vertical slices land; domain packages never create transaction/session abstractions.
 */
export interface AdminBotUnitOfWork {
  readonly audit: AuditRepository;
  readonly identity: IdentityRepository;
  readonly legacyMigration: import("./legacy-migration.js").LegacyMigrationRepository;
  readonly outbox: OutboxRepository;
  readonly rateLimits: RateLimitRepository;
}

export interface TransactionBoundary {
  read<Result>(work: (unitOfWork: AdminBotUnitOfWork) => Promise<Result>): Promise<Result>;
  write<Result>(work: (unitOfWork: AdminBotUnitOfWork) => Promise<Result>): Promise<Result>;
}

export * from "./legacy-migration.js";

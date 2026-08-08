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

export type AccessRoleName =
  | "external_collaborator"
  | "member"
  | "administrator"
  | "approver"
  | "security_operator"
  | "auditor";

export type AccountStatus = "pending" | "active" | "suspended" | "closed";
export type PersonStatus = "active" | "inactive" | "merged";

export interface LoginIdentityRecord {
  readonly accountId: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly displayName: string;
  readonly accountStatus: AccountStatus;
  readonly personStatus: PersonStatus;
  readonly passwordHash: string;
}

export interface OpenRegistrationLoginRecord {
  readonly registrationId: string;
  readonly passwordHash: string;
}

export interface CreateSessionRecord {
  readonly id: string;
  readonly accountId: string;
  readonly tokenHash: string;
  readonly now: Date;
  readonly expiresAt: Date;
}

export interface AuthenticatedSessionRecord {
  readonly sessionId: string;
  readonly accountId: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly displayName: string;
  readonly personStatus: PersonStatus;
  readonly personVersion: number;
  readonly personCreatedAt: Date;
  readonly personUpdatedAt: Date;
  readonly accountStatus: AccountStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly lastReauthenticatedAt: Date;
  readonly revokedAt?: Date;
  readonly roles: readonly AccessRoleName[];
}

export interface RevokeSessionInput {
  readonly tokenHash: string;
  readonly revokedAt: Date;
  readonly reason:
    | "logout"
    | "password_changed"
    | "email_changed"
    | "account_suspended"
    | "legacy_migration"
    | "administrator";
}

export interface RegistrationReviewRecord extends RegistrationRecord {
  readonly reviewedByPersonId?: string;
  readonly reviewedAt?: Date;
  readonly reviewReason?: string;
}

export type RegistrationDecisionCommit =
  | Readonly<{
      decision: "reject";
      organizationId: string;
      registrationId: string;
      actorPersonId: string;
      reason?: string;
      now: Date;
    }>
  | Readonly<{
      decision: "approve";
      organizationId: string;
      registrationId: string;
      actorPersonId: string;
      accountId: string;
      signupPersonId: string;
      roleAssignmentId: string;
      defaultRole: "external_collaborator";
      reason?: string;
      now: Date;
    }>;

export type RegistrationDecisionCommitResult =
  | Readonly<{ status: "decided"; registration: RegistrationReviewRecord }>
  | Readonly<{
      status: "not_found" | "state_conflict" | "identity_conflict";
    }>;

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

export interface SessionRepository {
  findLoginIdentity(
    organizationId: string,
    loginHandle: string,
  ): Promise<LoginIdentityRecord | undefined>;
  findOpenRegistrationLogin(
    organizationId: string,
    loginHandle: string,
  ): Promise<OpenRegistrationLoginRecord | undefined>;
  createSession(input: CreateSessionRecord): Promise<boolean>;
  findSession(
    organizationId: string,
    tokenHash: string,
    now: Date,
  ): Promise<AuthenticatedSessionRecord | undefined>;
  touchSession(sessionId: string, seenAt: Date): Promise<void>;
  revokeSession(input: RevokeSessionInput): Promise<boolean>;
}

export interface RegistrationReviewRepository {
  listRegistrations(
    organizationId: string,
    state?: RegistrationRecord["status"],
  ): Promise<readonly RegistrationReviewRecord[]>;
  commitRegistrationDecision(
    input: RegistrationDecisionCommit,
  ): Promise<RegistrationDecisionCommitResult>;
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
  reset(keys: readonly string[]): Promise<void>;
}

export type PaperStageName =
  | "idea"
  | "outline"
  | "drafting"
  | "internal_review"
  | "submission_ready"
  | "submitted"
  | "revision"
  | "accepted"
  | "camera_ready"
  | "published"
  | "archived";

export interface PaperRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly title: string;
  readonly authorIds: readonly string[];
  readonly authorNames: readonly string[];
  readonly stage: PaperStageName;
  readonly targetVenue?: string;
  readonly deadlineAt?: Date;
  readonly sourceUri?: string;
  readonly topicTags: readonly string[];
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreatePaperRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly title: string;
  readonly authorIds: readonly string[];
  readonly stage: PaperStageName;
  readonly targetVenue?: string;
  readonly deadlineAt?: Date;
  readonly sourceUri?: string;
  readonly topicTags: readonly string[];
  readonly now: Date;
}

export interface UpdatePaperRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly authorIds?: readonly string[];
  readonly stage?: PaperStageName;
  readonly targetVenue?: string | null;
  readonly deadlineAt?: Date | null;
  readonly sourceUri?: string | null;
  readonly topicTags?: readonly string[];
  readonly now: Date;
}

export interface PaperRepository {
  list(organizationId: string): Promise<readonly PaperRecord[]>;
  find(organizationId: string, paperId: string): Promise<PaperRecord | undefined>;
  create(input: CreatePaperRecord): Promise<PaperRecord | "authors_not_found">;
  update(input: UpdatePaperRecord): Promise<PaperRecord | "not_found" | "conflict" | "authors_not_found">;
  delete(organizationId: string, paperId: string, expectedVersion: number): Promise<"deleted" | "not_found" | "conflict">;
}

export type AvailabilityEntryKind = "allocation" | "open_capacity" | "time_off" | "tentative";
export type AvailabilityVisibility = "administrators" | "members" | "summary_only";

export interface AvailabilityEntryRecord {
  readonly id: string;
  readonly planId: string;
  readonly kind: AvailabilityEntryKind;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly hoursPerWeek?: number;
  readonly label?: string;
  readonly color?: string;
  readonly timeOffAvailability?: "none" | "partial";
  readonly privateReason?: string;
  readonly supportingUri?: string;
  readonly visibility: AvailabilityVisibility;
  readonly source: "manual" | "imported";
  readonly confirmedAt: Date;
}

export interface AvailabilityPlanRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly personName: string;
  readonly timeZone: string;
  readonly defaultWeeklyHours: number;
  readonly entries: readonly AvailabilityEntryRecord[];
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ReplaceAvailabilityPlanRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly expectedVersion: number;
  readonly timeZone: string;
  readonly defaultWeeklyHours: number;
  readonly entries: readonly Omit<AvailabilityEntryRecord, "planId">[];
  readonly now: Date;
}

export interface AvailabilityRepository {
  listPeople(organizationId: string): Promise<readonly { readonly personId: string; readonly personName: string }[]>;
  find(organizationId: string, personId: string): Promise<AvailabilityPlanRecord | undefined>;
  list(organizationId: string): Promise<readonly AvailabilityPlanRecord[]>;
  ensure(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly personId: string;
    readonly timeZone: string;
    readonly defaultWeeklyHours: number;
    readonly now: Date;
  }): Promise<AvailabilityPlanRecord | "person_not_found">;
  replace(input: ReplaceAvailabilityPlanRecord): Promise<AvailabilityPlanRecord | "not_found" | "conflict">;
}

/**
 * The only repository bundle a transaction callback receives. It is extended centrally as
 * vertical slices land; domain packages never create transaction/session abstractions.
 */
export interface AdminBotUnitOfWork {
  readonly availability?: AvailabilityRepository;
  readonly audit: AuditRepository;
  readonly identity: IdentityRepository;
  readonly legacyMigration: import("./legacy-migration.js").LegacyMigrationRepository;
  readonly outbox: OutboxRepository;
  readonly papers?: PaperRepository;
  readonly rateLimits: RateLimitRepository;
  readonly registrationReviews: RegistrationReviewRepository;
  readonly sessions: SessionRepository;
}

export interface TransactionBoundary {
  read<Result>(work: (unitOfWork: AdminBotUnitOfWork) => Promise<Result>): Promise<Result>;
  write<Result>(work: (unitOfWork: AdminBotUnitOfWork) => Promise<Result>): Promise<Result>;
}

export * from "./legacy-migration.js";

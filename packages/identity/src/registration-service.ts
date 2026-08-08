import { randomUUID } from "node:crypto";
import type {
  AuditRepository,
  OutboxRepository,
  RegistrationProfileRecord,
  TransactionBoundary,
} from "@adminbot/ports";
import { ScryptPasswordHasher, type PasswordHasher } from "./password.js";
import { IdentityKeyDeriver } from "./keys.js";
import {
  RegistrationValidationError,
  validateClaimRegistration,
  validateSignupRegistration,
} from "./registration-validation.js";

const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000;
const DEFAULT_MAXIMUM_ATTEMPTS = 10;

export interface RegistrationServiceOptions {
  readonly transactions: TransactionBoundary;
  readonly organizationId: string;
  /** Secret used only to pseudonymize durable rate-limit and uniqueness keys. */
  readonly keySecret: string | Buffer;
  readonly passwordHasher?: PasswordHasher;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly rateLimitWindowMs?: number;
  readonly maximumAttempts?: number;
}

export interface RegistrationRequestContext {
  /** Trusted transport metadata. This value is never read from the request body. */
  readonly remoteAddress?: string;
}

export interface RegistrationSubmittedBody {
  readonly registrationId: string;
  readonly state: "submitted";
}

export interface IdentityErrorBody {
  readonly code: "not_authorized" | "payload_invalid" | "rate_limited";
  readonly message: string;
  readonly retryable: boolean;
}

export type RegistrationSubmissionResult =
  | { readonly ok: true; readonly status: 202; readonly body: RegistrationSubmittedBody }
  | {
      readonly ok: false;
      readonly status: 400 | 403 | 429;
      readonly body: IdentityErrorBody;
      readonly retryAfterSeconds?: number;
    };

export class RegistrationService {
  private readonly transactions: TransactionBoundary;
  private readonly organizationId: string;
  private readonly keys: IdentityKeyDeriver;
  private readonly passwordHasher: PasswordHasher;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly rateLimitWindowMs: number;
  private readonly maximumAttempts: number;

  constructor(options: RegistrationServiceOptions) {
    if (!isUuid(options.organizationId)) throw new Error("organizationId must be a UUID");
    if (
      options.rateLimitWindowMs !== undefined &&
      (!Number.isSafeInteger(options.rateLimitWindowMs) || options.rateLimitWindowMs < 1_000)
    ) {
      throw new Error("rateLimitWindowMs must be an integer of at least 1000");
    }
    if (
      options.maximumAttempts !== undefined &&
      (!Number.isSafeInteger(options.maximumAttempts) || options.maximumAttempts < 1)
    ) {
      throw new Error("maximumAttempts must be a positive integer");
    }
    this.transactions = options.transactions;
    this.organizationId = options.organizationId;
    this.keys = new IdentityKeyDeriver(options.keySecret);
    this.passwordHasher = options.passwordHasher ?? new ScryptPasswordHasher();
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    this.maximumAttempts = options.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS;
  }

  listClaimablePeople() {
    return this.transactions.read(({ identity }) =>
      identity.listClaimablePeople(this.organizationId),
    );
  }

  async submitSignup(
    input: unknown,
    context: RegistrationRequestContext = {},
  ): Promise<RegistrationSubmissionResult> {
    let request;
    try {
      request = validateSignupRegistration(input);
    } catch (error) {
      return validationFailure(error);
    }

    const now = this.now();
    const rateLimited = await this.consumeAttempt(request.email, context.remoteAddress, now);
    if (rateLimited !== undefined) return rateLimitFailure(rateLimited);
    const passwordHash = await this.passwordHasher.hash(request.password);
    const registrationId = this.createId();
    const result = await this.transactions.write(async ({ audit, identity, outbox }) => {
      const created = await identity.createSignupRegistration({
        id: registrationId,
        organizationId: this.organizationId,
        requestedLoginHandle: request.email,
        passwordHash,
        openRequestKey: this.keys.openRegistrationEmail(
          this.organizationId,
          request.email,
        ),
        profile: request.profile,
        now,
      });
      if (!created) return false;
      await this.recordSubmission(audit, outbox, registrationId, "signup", request.profile, now);
      return true;
    });
    return result
      ? submissionSuccess(registrationId)
      : genericFailure("unable to register");
  }

  async submitClaim(
    input: unknown,
    context: RegistrationRequestContext = {},
  ): Promise<RegistrationSubmissionResult> {
    let request;
    try {
      request = validateClaimRegistration(input);
    } catch (error) {
      return validationFailure(error);
    }

    const now = this.now();
    const rateLimited = await this.consumeAttempt(request.email, context.remoteAddress, now);
    if (rateLimited !== undefined) return rateLimitFailure(rateLimited);
    const passwordHash = await this.passwordHasher.hash(request.password);
    const registrationId = this.createId();
    const result = await this.transactions.write(async ({ audit, identity, outbox }) => {
      const created = await identity.createClaimRegistration({
        id: registrationId,
        organizationId: this.organizationId,
        personId: request.personId,
        requestedLoginHandle: request.email,
        passwordHash,
        openRequestKey: this.keys.openRegistrationEmail(
          this.organizationId,
          request.email,
        ),
        openClaimPersonKey: this.keys.openClaimPerson(
          this.organizationId,
          request.personId,
        ),
        now,
      });
      if (!created) return false;
      await this.recordSubmission(audit, outbox, registrationId, "claim", undefined, now);
      return true;
    });
    return result
      ? submissionSuccess(registrationId)
      : genericFailure("unable to claim this profile");
  }

  private async consumeAttempt(
    email: string,
    remoteAddress: string | undefined,
    now: Date,
  ): Promise<number | undefined> {
    const keys = [this.keys.registrationEmailAttempt(this.organizationId, email)];
    const normalizedAddress = remoteAddress?.trim();
    if (normalizedAddress !== undefined && normalizedAddress.length > 0) {
      keys.push(
        this.keys.registrationAddressAttempt(
          this.organizationId,
          normalizedAddress.slice(0, 128),
        ),
      );
    }
    return this.transactions.write(({ rateLimits }) =>
      rateLimits.consume({
        keys,
        now,
        windowMs: this.rateLimitWindowMs,
        maximumAttempts: this.maximumAttempts,
      }),
    );
  }

  private async recordSubmission(
    audit: AuditRepository,
    outbox: OutboxRepository,
    registrationId: string,
    kind: "claim" | "signup",
    profile: RegistrationProfileRecord | undefined,
    now: Date,
  ): Promise<void> {
    await audit.append({
      id: this.createId(),
      organizationId: this.organizationId,
      eventType: "identity.registration_submitted",
      subjectId: registrationId,
      safeDetails: { kind },
      occurredAt: now,
    });
    await outbox.enqueue({
      id: this.createId(),
      organizationId: this.organizationId,
      eventType: "identity.registration_submitted",
      aggregateType: "registration",
      aggregateId: registrationId,
      payload: {
        registrationId,
        kind,
        hasProposedProfile: profile !== undefined,
      },
      availableAt: now,
    });
  }
}

function validationFailure(error: unknown): RegistrationSubmissionResult {
  if (!(error instanceof RegistrationValidationError)) throw error;
  return {
    ok: false,
    status: 400,
    body: { code: "payload_invalid", message: error.message, retryable: false },
  };
}

function rateLimitFailure(retryAfterSeconds: number): RegistrationSubmissionResult {
  return {
    ok: false,
    status: 429,
    body: {
      code: "rate_limited",
      message: "too many registration attempts; try again later",
      retryable: true,
    },
    retryAfterSeconds,
  };
}

function genericFailure(message: string): RegistrationSubmissionResult {
  return {
    ok: false,
    status: 403,
    body: { code: "not_authorized", message, retryable: false },
  };
}

function submissionSuccess(registrationId: string): RegistrationSubmissionResult {
  return { ok: true, status: 202, body: { registrationId, state: "submitted" } };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

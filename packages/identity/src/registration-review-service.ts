import { randomUUID } from "node:crypto";
import type {
  RegistrationDecisionCommit,
  RegistrationProfileRecord,
  RegistrationReviewRecord,
  TransactionBoundary,
} from "@adminbot/ports";
import type { AuthenticatedHumanSession } from "./session-service.js";

const REGISTRATION_STATES = new Set([
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "withdrawn",
]);

type RegistrationState = RegistrationReviewRecord["status"];

export interface RegistrationReviewServiceOptions {
  readonly transactions: TransactionBoundary;
  readonly organizationId: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export interface RegistrationViewBody {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: "claim" | "signup";
  readonly requestedLoginHandle: string;
  readonly requestedDisplayName: string;
  readonly state: RegistrationState;
  readonly linkedPersonId?: string;
  readonly profile?: RegistrationProfileRecord;
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RegistrationReviewErrorBody {
  readonly code:
    | "not_authenticated"
    | "not_authorized"
    | "not_found"
    | "conflict"
    | "payload_invalid";
  readonly message: string;
  readonly retryable: boolean;
}

export type RegistrationListResult =
  | Readonly<{ ok: true; status: 200; body: readonly RegistrationViewBody[] }>
  | Readonly<{
      ok: false;
      status: 400 | 401 | 403;
      body: RegistrationReviewErrorBody;
    }>;

export type RegistrationDecisionResult =
  | Readonly<{ ok: true; status: 200; body: RegistrationViewBody }>
  | Readonly<{
      ok: false;
      status: 400 | 401 | 403 | 404 | 409;
      body: RegistrationReviewErrorBody;
    }>;

export class RegistrationReviewService {
  private readonly transactions: TransactionBoundary;
  private readonly organizationId: string;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: RegistrationReviewServiceOptions) {
    if (!isUuid(options.organizationId)) throw new Error("organizationId must be a UUID");
    this.transactions = options.transactions;
    this.organizationId = options.organizationId;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async list(
    actor: AuthenticatedHumanSession | undefined,
    requestedState?: string,
  ): Promise<RegistrationListResult> {
    const authorization = authorizeAdministrator(actor, this.organizationId, false);
    if (authorization !== undefined) return authorization;
    if (actor === undefined) throw new Error("authorization invariant violated");
    const state = parseState(requestedState);
    if (state === null) {
      return failure(400, "payload_invalid", "registration state is invalid");
    }
    const registrations = await this.transactions.read(({ registrationReviews }) =>
      registrationReviews.listRegistrations(this.organizationId, state),
    );
    return { ok: true, status: 200, body: registrations.map(toRegistrationView) };
  }

  async decide(
    actor: AuthenticatedHumanSession | undefined,
    registrationId: string,
    input: unknown,
  ): Promise<RegistrationDecisionResult> {
    const authorization = authorizeAdministrator(actor, this.organizationId, true);
    if (authorization !== undefined) return authorization;
    if (actor === undefined) throw new Error("authorization invariant violated");
    if (!isUuid(registrationId)) {
      return failure(404, "not_found", "registration not found");
    }
    const decision = validateDecision(input);
    if (!decision.ok) return decision.result;
    const now = this.now();
    const commit: RegistrationDecisionCommit =
      decision.decision === "reject"
        ? {
            decision: "reject",
            organizationId: this.organizationId,
            registrationId,
            actorPersonId: actor.personId,
            ...(decision.reason === undefined ? {} : { reason: decision.reason }),
            now,
          }
        : {
            decision: "approve",
            organizationId: this.organizationId,
            registrationId,
            actorPersonId: actor.personId,
            accountId: this.createId(),
            signupPersonId: this.createId(),
            roleAssignmentId: this.createId(),
            defaultRole: "external_collaborator",
            ...(decision.reason === undefined ? {} : { reason: decision.reason }),
            now,
          };

    const committed = await this.transactions.write(
      async ({ audit, outbox, registrationReviews }) => {
        const result = await registrationReviews.commitRegistrationDecision(commit);
        if (result.status !== "decided") return result;
        const eventType =
          `identity.registration_${decision.decision === "approve" ? "approved" : "rejected"}`;
        await audit.append({
          id: this.createId(),
          organizationId: this.organizationId,
          eventType,
          actorId: actor.accountId,
          subjectId: registrationId,
          safeDetails: {
            kind: result.registration.kind,
            decision: decision.decision,
            defaultRoleApplied:
              decision.decision === "approve" && result.registration.kind === "signup",
          },
          occurredAt: now,
        });
        await outbox.enqueue({
          id: this.createId(),
          organizationId: this.organizationId,
          eventType,
          aggregateType: "registration",
          aggregateId: registrationId,
          payload: {
            registrationId,
            decision: decision.decision,
            personId: result.registration.linkedPersonId ?? null,
          },
          availableAt: now,
        });
        return result;
      },
    );
    switch (committed.status) {
      case "decided":
        return { ok: true, status: 200, body: toRegistrationView(committed.registration) };
      case "not_found":
        return failure(404, "not_found", "registration not found");
      case "state_conflict":
        return failure(409, "conflict", "registration is no longer pending");
      case "identity_conflict":
        return failure(409, "conflict", "registration cannot be approved");
    }
  }
}

function authorizeAdministrator(
  actor: AuthenticatedHumanSession | undefined,
  organizationId: string,
  requireRecentAuthentication: boolean,
):
  | {
      readonly ok: false;
      readonly status: 401 | 403;
      readonly body: RegistrationReviewErrorBody;
    }
  | undefined {
  if (actor === undefined) {
    return failure(401, "not_authenticated", "authentication required");
  }
  if (actor.organizationId !== organizationId || !actor.roles.includes("administrator")) {
    return failure(403, "not_authorized", "administrator role required");
  }
  if (requireRecentAuthentication && actor.authenticationLevel !== "recent_reauthentication") {
    return failure(403, "not_authorized", "recent reauthentication required");
  }
  return undefined;
}

function validateDecision(input: unknown):
  | Readonly<{ ok: true; decision: "approve" | "reject"; reason?: string }>
  | Readonly<{ ok: false; result: RegistrationDecisionResult }> {
  if (!isRecord(input)) {
    return {
      ok: false,
      result: failure(400, "payload_invalid", "request must be an object"),
    };
  }
  for (const key of Object.keys(input)) {
    if (key !== "decision" && key !== "reason") {
      return {
        ok: false,
        result: failure(400, "payload_invalid", "request contains an unsupported field"),
      };
    }
  }
  if (input.decision !== "approve" && input.decision !== "reject") {
    return {
      ok: false,
      result: failure(400, "payload_invalid", "decision must be approve or reject"),
    };
  }
  if (input.reason !== undefined && typeof input.reason !== "string") {
    return {
      ok: false,
      result: failure(400, "payload_invalid", "reason must be a string"),
    };
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : undefined;
  if (reason !== undefined && reason.length > 2_000) {
    return {
      ok: false,
      result: failure(400, "payload_invalid", "reason must be at most 2000 characters"),
    };
  }
  return {
    ok: true,
    decision: input.decision,
    ...(reason === undefined || reason.length === 0 ? {} : { reason }),
  };
}

function parseState(value: string | undefined): RegistrationState | undefined | null {
  if (value === undefined || value === "") return undefined;
  return REGISTRATION_STATES.has(value) ? (value as RegistrationState) : null;
}

function toRegistrationView(registration: RegistrationReviewRecord): RegistrationViewBody {
  return {
    id: registration.id,
    organizationId: registration.organizationId,
    kind: registration.kind,
    requestedLoginHandle: registration.requestedLoginHandle,
    requestedDisplayName: registration.requestedDisplayName,
    state: registration.status,
    ...(registration.linkedPersonId === undefined
      ? {}
      : { linkedPersonId: registration.linkedPersonId }),
    ...(registration.profile === undefined ? {} : { profile: registration.profile }),
    ...(registration.reviewedByPersonId === undefined
      ? {}
      : { reviewedBy: registration.reviewedByPersonId }),
    ...(registration.reviewedAt === undefined
      ? {}
      : { reviewedAt: registration.reviewedAt.toISOString() }),
    version: registration.version,
    createdAt: registration.createdAt.toISOString(),
    updatedAt: registration.updatedAt.toISOString(),
  };
}

function failure<
  Status extends 400 | 401 | 403 | 404 | 409,
  Code extends RegistrationReviewErrorBody["code"],
>(
  status: Status,
  code: Code,
  message: string,
): {
  readonly ok: false;
  readonly status: Status;
  readonly body: RegistrationReviewErrorBody;
} {
  return { ok: false, status, body: { code, message, retryable: false } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

import { createHmac } from "node:crypto";
import type {
  ReimbursementConversationResult,
  ReimbursementPacketResult,
} from "@adminbot/api-contracts";
import type { TransactionBoundary } from "@adminbot/ports";
import type { ReimbursementRequestContext, ReimbursementRuntime } from "./types.js";
import {
  applyDerivedFields,
  missingDraftFields,
  packetWarnings,
  ReimbursementValidationError,
  validateConversation,
  validatePacketRequest,
} from "./validation.js";

const RATE_WINDOW_MS = 15 * 60 * 1_000;
const MAXIMUM_OPERATIONS = 10;

export interface ReimbursementServiceOptions {
  readonly transactions: TransactionBoundary;
  readonly runtime: ReimbursementRuntime;
  readonly keySecret: string | Buffer;
  readonly now?: () => Date;
  readonly onDependencyError?: (operation: "reason" | "generate", error: unknown) => void;
}

export type ReimbursementResult =
  | Readonly<{
      ok: true;
      status: 200;
      body: ReimbursementConversationResult | ReimbursementPacketResult;
    }>
  | Readonly<{
      ok: false;
      status: 400 | 429 | 503;
      body: {
        code: "payload_invalid" | "rate_limited" | "dependency_unavailable";
        message: string;
        retryable: boolean;
      };
      retryAfterSeconds?: number;
    }>;

export class ReimbursementService {
  private readonly now: () => Date;

  constructor(private readonly options: ReimbursementServiceOptions) {
    if (Buffer.byteLength(options.keySecret) < 32) {
      throw new Error("reimbursement keySecret must contain at least 32 bytes");
    }
    this.now = options.now ?? (() => new Date());
  }

  async converse(input: unknown, context: ReimbursementRequestContext = {}): Promise<ReimbursementResult> {
    let request;
    try {
      request = validateConversation(input);
    } catch (error) {
      return validationFailure(error);
    }
    const limited = await this.consumeRateLimit(context, "conversation");
    if (limited !== undefined) return limited;
    try {
      const reasoned = await this.options.runtime.reason(request);
      const draft = applyDerivedFields(reasoned.draft);
      const missingFields = missingDraftFields(draft);
      return {
        ok: true,
        status: 200,
        body: {
          assistantMessage:
            reasoned.assistantMessage ??
            (missingFields.length === 0
              ? "The packet is ready for your review."
              : `Please provide ${missingFields.map(friendlyField).join(", ")}.`),
          draft,
          missingFields: [...missingFields],
          ready: missingFields.length === 0,
          receiptNames: request.receipts.map(({ filename }) => filename),
        },
      };
    } catch (error) {
      this.options.onDependencyError?.("reason", error);
      return dependencyFailure("The local reimbursement assistant is unavailable.");
    }
  }

  async generate(input: unknown, context: ReimbursementRequestContext = {}): Promise<ReimbursementResult> {
    let request;
    try {
      request = validatePacketRequest(input);
    } catch (error) {
      return validationFailure(error);
    }
    const draft = applyDerivedFields(request.draft);
    const missing = missingDraftFields(draft);
    if (missing.length > 0) {
      return failure(400, "payload_invalid", `reimbursement details are incomplete: ${missing.join(", ")}`);
    }
    const limited = await this.consumeRateLimit(context, "packet");
    if (limited !== undefined) return limited;
    try {
      const artifacts = await this.options.runtime.generate(draft);
      if (artifacts.length !== 2) throw new Error("packet runtime returned an invalid artifact set");
      return {
        ok: true,
        status: 200,
        body: { artifacts: [...artifacts], warnings: [...packetWarnings(draft)] },
      };
    } catch (error) {
      this.options.onDependencyError?.("generate", error);
      return dependencyFailure("The local reimbursement form generator is unavailable.");
    }
  }

  private async consumeRateLimit(
    context: ReimbursementRequestContext,
    operation: "conversation" | "packet",
  ): Promise<ReimbursementResult | undefined> {
    const address = context.remoteAddress?.trim() || "unknown-loopback-client";
    const digest = createHmac("sha256", this.options.keySecret)
      .update(`reimbursement:${operation}:${address.slice(0, 128)}`)
      .digest("base64url");
    const retryAfterSeconds = await this.options.transactions.write(({ rateLimits }) =>
      rateLimits.consume({
        keys: [`reimbursement:${operation}:${digest}`],
        now: this.now(),
        windowMs: RATE_WINDOW_MS,
        maximumAttempts: MAXIMUM_OPERATIONS,
      }),
    );
    return retryAfterSeconds === undefined
      ? undefined
      : {
          ...failure(429, "rate_limited", "too many reimbursement requests", true),
          retryAfterSeconds,
        };
  }
}

function validationFailure(error: unknown): ReimbursementResult {
  if (!(error instanceof ReimbursementValidationError)) throw error;
  return failure(400, "payload_invalid", error.message);
}

function dependencyFailure(message: string): ReimbursementResult {
  return failure(503, "dependency_unavailable", message, true);
}

function failure(
  status: 400 | 429 | 503,
  code: "payload_invalid" | "rate_limited" | "dependency_unavailable",
  message: string,
  retryable = false,
): Extract<ReimbursementResult, { readonly ok: false }> {
  return { ok: false, status, body: { code, message, retryable } };
}

function friendlyField(value: string): string {
  return value.replaceAll("_", " ");
}

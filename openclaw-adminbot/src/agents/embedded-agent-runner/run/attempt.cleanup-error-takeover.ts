/**
 * Attempt stage: teardown error precedence.
 *
 * Decides which failure an attempt reports when the prompt already failed and
 * cleanup then failed too. A session takeover during cleanup must not mask the
 * original prompt error, so the two are carried together and surfaced under the
 * takeover's name.
 */
import { formatErrorMessage } from "../../../infra/errors.js";
import { EmbeddedAttemptSessionTakeoverError } from "./attempt.session-lock.js";

export function shouldPreservePromptErrorAfterCleanupError(params: {
  promptError: unknown;
  cleanupError: unknown;
}): boolean {
  return (
    Boolean(params.promptError) &&
    params.cleanupError instanceof EmbeddedAttemptSessionTakeoverError
  );
}

export class EmbeddedAttemptPromptErrorWithCleanupTakeoverError extends Error {
  readonly promptError: unknown;
  readonly cleanupError: EmbeddedAttemptSessionTakeoverError;

  constructor(params: { promptError: unknown; cleanupError: EmbeddedAttemptSessionTakeoverError }) {
    super(formatErrorMessage(params.promptError), { cause: params.cleanupError });
    this.name = "EmbeddedAttemptSessionTakeoverError";
    this.promptError = params.promptError;
    this.cleanupError = params.cleanupError;
  }
}

export function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

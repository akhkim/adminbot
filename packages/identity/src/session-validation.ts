import { normalizeEmailAddress, RegistrationValidationError } from "./registration-validation.js";

const PASSWORD_MAX_LENGTH = 1_024;

export interface ValidLoginInput {
  readonly email: string;
  readonly password: string;
}

export class SessionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionValidationError";
  }
}

export function validateLoginInput(input: unknown): ValidLoginInput {
  if (!isRecord(input)) throw new SessionValidationError("request must be an object");
  for (const key of Object.keys(input)) {
    if (key !== "email" && key !== "password") {
      throw new SessionValidationError("request contains an unsupported field");
    }
  }
  if (typeof input.email !== "string") {
    throw new SessionValidationError("email must be a string");
  }
  if (
    typeof input.password !== "string" ||
    input.password.length < 1 ||
    input.password.length > PASSWORD_MAX_LENGTH
  ) {
    throw new SessionValidationError(
      `password must be between 1 and ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  try {
    return { email: normalizeEmailAddress(input.email), password: input.password };
  } catch (error) {
    if (error instanceof RegistrationValidationError) {
      throw new SessionValidationError("email is invalid");
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

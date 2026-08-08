import {
  apiRoutes,
  createApiUrl,
  isApiErrorCode,
  type ClaimRegistrationInput,
  type ClaimablePerson,
  type ErrorResponse,
  type RegistrationSubmitted,
  type SignupRegistrationInput,
} from "@adminbot/api-contracts";

export interface RegistrationClient {
  listClaimablePeople(): Promise<readonly ClaimablePerson[]>;
  submitClaim(input: ClaimRegistrationInput): Promise<RegistrationSubmitted>;
  submitSignup(input: SignupRegistrationInput): Promise<RegistrationSubmitted>;
}

export interface RegistrationApiClientOptions {
  readonly serviceOrigin: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class RegistrationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorResponse["code"],
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "RegistrationApiError";
  }
}

export class RegistrationApiClient implements RegistrationClient {
  private readonly serviceOrigin: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: RegistrationApiClientOptions) {
    this.serviceOrigin = options.serviceOrigin;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async listClaimablePeople(): Promise<readonly ClaimablePerson[]> {
    const response = await this.request(apiRoutes.listClaimablePeople.build(), {
      method: apiRoutes.listClaimablePeople.method,
    });
    const body = await readJson(response);
    if (!Array.isArray(body) || body.some((item) => !isClaimablePerson(item))) {
      throw invalidResponse();
    }
    return body;
  }

  async submitClaim(input: ClaimRegistrationInput): Promise<RegistrationSubmitted> {
    return this.submit(apiRoutes.submitClaim.build(), apiRoutes.submitClaim.method, input);
  }

  async submitSignup(input: SignupRegistrationInput): Promise<RegistrationSubmitted> {
    return this.submit(apiRoutes.submitSignup.build(), apiRoutes.submitSignup.method, input);
  }

  private async submit(
    path: string,
    method: "POST",
    input: ClaimRegistrationInput | SignupRegistrationInput,
  ): Promise<RegistrationSubmitted> {
    const response = await this.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await readJson(response);
    if (!isRegistrationSubmitted(body)) throw invalidResponse();
    return body;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetch(createApiUrl(this.serviceOrigin, path), {
      ...init,
      credentials: "include",
      headers: { accept: "application/json", ...init.headers },
    });
    if (response.ok) return response;
    const body = await readJson(response).catch(() => undefined);
    const error = isErrorResponse(body)
      ? body
      : { code: "internal_error" as const, message: "AdminBot could not process the request" };
    const retryAfter = response.headers.get("retry-after");
    const retryAfterSeconds = retryAfter === null ? undefined : Number(retryAfter);
    throw new RegistrationApiError(
      response.status,
      error.code,
      error.message,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    );
  }
}

function isClaimablePerson(value: unknown): value is ClaimablePerson {
  return (
    isRecord(value) &&
    typeof value.personId === "string" &&
    typeof value.displayName === "string"
  );
}

function isRegistrationSubmitted(value: unknown): value is RegistrationSubmitted {
  return (
    isRecord(value) &&
    typeof value.registrationId === "string" &&
    value.state === "submitted"
  );
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  return (
    isRecord(value) &&
    isApiErrorCode(value.code) &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean"
  );
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw invalidResponse();
  return response.json() as Promise<unknown>;
}

function invalidResponse(): RegistrationApiError {
  return new RegistrationApiError(
    502,
    "dependency_unavailable",
    "AdminBot returned an invalid response",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

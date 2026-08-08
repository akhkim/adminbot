import {
  apiRoutes,
  createApiUrl,
  isApiErrorCode,
  type ClaimRegistrationInput,
  type ClaimablePerson,
  type ErrorResponse,
  type LoginInput,
  type Registration,
  type RegistrationDecisionInput,
  type RegistrationSubmitted,
  type SessionView,
  type SignupRegistrationInput,
} from "@adminbot/api-contracts";

export interface RegistrationClient {
  listClaimablePeople(): Promise<readonly ClaimablePerson[]>;
  submitClaim(input: ClaimRegistrationInput): Promise<RegistrationSubmitted>;
  submitSignup(input: SignupRegistrationInput): Promise<RegistrationSubmitted>;
}

export interface SessionClient {
  login(input: LoginInput): Promise<SessionView>;
  restore(): Promise<SessionView | undefined>;
  logout(): Promise<void>;
}

export interface RegistrationReviewClient {
  list(state?: Registration["state"]): Promise<readonly Registration[]>;
  decide(
    registrationId: string,
    input: RegistrationDecisionInput,
  ): Promise<Registration>;
}

export interface RegistrationApiClientOptions {
  readonly serviceOrigin: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class AdminBotApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorResponse["code"],
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AdminBotApiError";
  }
}

/** Kept as a source-compatible name for the registration form. */
export { AdminBotApiError as RegistrationApiError };

class ApiTransport {
  private readonly serviceOrigin: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: RegistrationApiClientOptions) {
    this.serviceOrigin = options.serviceOrigin;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async request(path: string, init: RequestInit): Promise<Response> {
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
    throw new AdminBotApiError(
      response.status,
      error.code,
      error.message,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    );
  }
}

export class RegistrationApiClient implements RegistrationClient {
  private readonly transport: ApiTransport;

  constructor(options: RegistrationApiClientOptions) {
    this.transport = new ApiTransport(options);
  }

  async listClaimablePeople(): Promise<readonly ClaimablePerson[]> {
    const response = await this.transport.request(apiRoutes.listClaimablePeople.build(), {
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
    const response = await this.transport.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await readJson(response);
    if (!isRegistrationSubmitted(body)) throw invalidResponse();
    return body;
  }

}

export class SessionApiClient implements SessionClient {
  private readonly transport: ApiTransport;

  constructor(options: RegistrationApiClientOptions) {
    this.transport = new ApiTransport(options);
  }

  async login(input: LoginInput): Promise<SessionView> {
    const response = await this.transport.request(apiRoutes.createSession.build(), {
      method: apiRoutes.createSession.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return readSession(response);
  }

  async restore(): Promise<SessionView | undefined> {
    try {
      const response = await this.transport.request(apiRoutes.getCurrentSession.build(), {
        method: apiRoutes.getCurrentSession.method,
      });
      return readSession(response);
    } catch (error) {
      if (error instanceof AdminBotApiError && error.status === 401) return undefined;
      throw error;
    }
  }

  async logout(): Promise<void> {
    await this.transport.request(apiRoutes.deleteCurrentSession.build(), {
      method: apiRoutes.deleteCurrentSession.method,
    });
  }
}

export class RegistrationReviewApiClient implements RegistrationReviewClient {
  private readonly transport: ApiTransport;

  constructor(options: RegistrationApiClientOptions) {
    this.transport = new ApiTransport(options);
  }

  async list(state?: Registration["state"]): Promise<readonly Registration[]> {
    const path = apiRoutes.listRegistrations.build();
    const response = await this.transport.request(
      state === undefined ? path : `${path}?state=${encodeURIComponent(state)}`,
      { method: apiRoutes.listRegistrations.method },
    );
    const body = await readJson(response);
    if (!Array.isArray(body) || body.some((item) => !isRegistration(item))) {
      throw invalidResponse();
    }
    return body;
  }

  async decide(
    registrationId: string,
    input: RegistrationDecisionInput,
  ): Promise<Registration> {
    const response = await this.transport.request(
      apiRoutes.decideRegistration.build({ registrationId }),
      {
        method: apiRoutes.decideRegistration.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    const body = await readJson(response);
    if (!isRegistration(body)) throw invalidResponse();
    return body;
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

function readSession(response: Response): Promise<SessionView> {
  return readJson(response).then((body) => {
    if (!isSessionView(body)) throw invalidResponse();
    return body;
  });
}

function isSessionView(value: unknown): value is SessionView {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.expiresAt === "string" &&
    (value.authenticationLevel === "single_factor" ||
      value.authenticationLevel === "recent_reauthentication") &&
    isRecord(value.person) &&
    typeof value.person.id === "string" &&
    typeof value.person.displayName === "string" &&
    Array.isArray(value.roles) &&
    value.roles.every((role) => typeof role === "string")
  );
}

function isRegistration(value: unknown): value is Registration {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.organizationId === "string" &&
    (value.kind === "claim" || value.kind === "signup") &&
    typeof value.requestedLoginHandle === "string" &&
    typeof value.requestedDisplayName === "string" &&
    typeof value.state === "string" &&
    typeof value.version === "number" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
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

function invalidResponse(): AdminBotApiError {
  return new AdminBotApiError(
    502,
    "dependency_unavailable",
    "AdminBot returned an invalid response",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

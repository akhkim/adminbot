import {
  apiRoutes,
  type ClaimablePerson,
  type StaticApiRoute,
} from "@adminbot/api-contracts";
import type {
  RegistrationRequestContext,
  RegistrationSubmissionResult,
} from "@adminbot/identity";

export interface RegistrationApplication {
  listClaimablePeople(): Promise<readonly ClaimablePerson[]>;
  submitClaim(
    input: unknown,
    context?: RegistrationRequestContext,
  ): Promise<RegistrationSubmissionResult>;
  submitSignup(
    input: unknown,
    context?: RegistrationRequestContext,
  ): Promise<RegistrationSubmissionResult>;
}

export interface ApiRequestContext extends RegistrationRequestContext {
  readonly body?: unknown;
}

export interface ApiResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ApiRouteHandler {
  readonly route: StaticApiRoute;
  readonly body: "json" | "none";
  handle(context: ApiRequestContext): Promise<ApiResponse>;
}

export function createRegistrationRoutes(
  application: RegistrationApplication,
): readonly ApiRouteHandler[] {
  return Object.freeze([
    {
      route: apiRoutes.listClaimablePeople,
      body: "none",
      handle: async () => ({ status: 200, body: await application.listClaimablePeople() }),
    },
    {
      route: apiRoutes.submitClaim,
      body: "json",
      handle: async (context) =>
        submissionResponse(
          await application.submitClaim(context.body, {
            ...(context.remoteAddress === undefined
              ? {}
              : { remoteAddress: context.remoteAddress }),
          }),
        ),
    },
    {
      route: apiRoutes.submitSignup,
      body: "json",
      handle: async (context) =>
        submissionResponse(
          await application.submitSignup(context.body, {
            ...(context.remoteAddress === undefined
              ? {}
              : { remoteAddress: context.remoteAddress }),
          }),
        ),
    },
  ] satisfies readonly ApiRouteHandler[]);
}

function submissionResponse(result: RegistrationSubmissionResult): ApiResponse {
  return {
    status: result.status,
    body: result.body,
    ...(!result.ok && result.retryAfterSeconds !== undefined
      ? { headers: { "retry-after": String(result.retryAfterSeconds) } }
      : {}),
  };
}

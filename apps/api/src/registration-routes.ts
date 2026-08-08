import {
  apiRoutes,
  type ClaimablePerson,
} from "@adminbot/api-contracts";
import type {
  RegistrationRequestContext,
  RegistrationSubmissionResult,
} from "@adminbot/identity";
import type {
  ApiRequestContext,
  ApiResponse,
  ApiRouteHandler,
} from "./route-handler.js";

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

import { apiRoutes } from "@adminbot/api-contracts";
import type {
  AuthenticatedHumanSession,
  RegistrationDecisionResult,
  RegistrationListResult,
} from "@adminbot/identity";
import type { ApiResponse, ApiRouteHandler } from "./route-handler.js";

export interface SessionAuthenticator {
  authenticate(rawToken: string | undefined): Promise<AuthenticatedHumanSession | undefined>;
}

export interface RegistrationReviewApplication {
  list(
    actor: AuthenticatedHumanSession | undefined,
    requestedState?: string,
  ): Promise<RegistrationListResult>;
  decide(
    actor: AuthenticatedHumanSession | undefined,
    registrationId: string,
    input: unknown,
  ): Promise<RegistrationDecisionResult>;
}

export function createRegistrationReviewRoutes(
  sessions: SessionAuthenticator,
  reviews: RegistrationReviewApplication,
): readonly ApiRouteHandler[] {
  return Object.freeze([
    {
      route: apiRoutes.listRegistrations,
      body: "none",
      handle: async (context) => {
        const state = singleStateQuery(context.query);
        if (!state.ok) return state.response;
        const actor = await sessions.authenticate(context.sessionToken);
        return reviews.list(actor, state.value);
      },
    },
    {
      route: apiRoutes.decideRegistration,
      body: "json",
      handle: async (context) => {
        const parameters = apiRoutes.decideRegistration.match(context.pathname);
        if (parameters === undefined) return notFound();
        const actor = await sessions.authenticate(context.sessionToken);
        return reviews.decide(actor, parameters.registrationId, context.body);
      },
    },
  ] satisfies readonly ApiRouteHandler[]);
}

function singleStateQuery(query: URLSearchParams):
  | Readonly<{ ok: true; value?: string }>
  | Readonly<{ ok: false; response: ApiResponse }> {
  for (const key of query.keys()) {
    if (key !== "state") return { ok: false, response: invalidQuery() };
  }
  const values = query.getAll("state");
  if (values.length > 1) return { ok: false, response: invalidQuery() };
  const value = values[0];
  return { ok: true, ...(value === undefined ? {} : { value }) };
}

function invalidQuery(): ApiResponse {
  return {
    status: 400,
    body: {
      code: "payload_invalid",
      message: "query parameters are invalid",
      retryable: false,
    },
  };
}

function notFound(): ApiResponse {
  return {
    status: 404,
    body: { code: "not_found", message: "registration not found", retryable: false },
  };
}

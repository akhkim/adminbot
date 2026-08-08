import { apiRoutes } from "@adminbot/api-contracts";
import type { AvailabilityActor, AvailabilityCommandResult } from "@adminbot/availability";
import type { AuthenticatedHumanSession } from "@adminbot/identity";
import type { ApiRouteHandler } from "./route-handler.js";
import type { SessionAuthenticator } from "./registration-review-routes.js";

export interface AvailabilityApplication {
  get(actor: AvailabilityActor | undefined): Promise<AvailabilityCommandResult>;
  replace(actor: AvailabilityActor | undefined, input: unknown): Promise<AvailabilityCommandResult>;
}

export function createAvailabilityRoutes(sessions: SessionAuthenticator, availability: AvailabilityApplication): readonly ApiRouteHandler[] {
  return Object.freeze([
    {
      route: apiRoutes.getAvailabilityWorkspace,
      body: "none",
      handle: async (context) => availability.get(toActor(await sessions.authenticate(context.sessionToken))),
    },
    {
      route: apiRoutes.replaceAvailabilityPlan,
      body: "json",
      maximumBodyBytes: 512 * 1_024,
      handle: async (context) => availability.replace(toActor(await sessions.authenticate(context.sessionToken)), context.body),
    },
  ] satisfies readonly ApiRouteHandler[]);
}

function toActor(session: AuthenticatedHumanSession | undefined): AvailabilityActor | undefined {
  return session === undefined ? undefined : {
    accountId: session.accountId, organizationId: session.organizationId,
    personId: session.personId, roles: session.roles,
  };
}

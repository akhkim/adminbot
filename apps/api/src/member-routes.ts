import { apiRoutes } from "@adminbot/api-contracts";
import type { AuthenticatedHumanSession } from "@adminbot/identity";
import type { MemberActor, MemberCommandResult } from "@adminbot/members";
import type { ApiResponse, ApiRouteHandler } from "./route-handler.js";
import type { SessionAuthenticator } from "./registration-review-routes.js";

export interface MemberApplication {
  list(actor: MemberActor | undefined): Promise<MemberCommandResult>;
  updateOwnProfile(actor: MemberActor | undefined, input: unknown): Promise<MemberCommandResult>;
  updateGovernance(actor: MemberActor | undefined, personId: string, input: unknown): Promise<MemberCommandResult>;
}

export function createMemberRoutes(
  sessions: SessionAuthenticator,
  members: MemberApplication,
): readonly ApiRouteHandler[] {
  return Object.freeze([
    {
      route: apiRoutes.listMembers,
      body: "none",
      handle: async (context) => members.list(toActor(await sessions.authenticate(context.sessionToken))),
    },
    {
      route: apiRoutes.updateOwnMemberProfile,
      body: "json",
      handle: async (context) => members.updateOwnProfile(
        toActor(await sessions.authenticate(context.sessionToken)),
        context.body,
      ),
    },
    {
      route: apiRoutes.updateMemberGovernance,
      body: "json",
      handle: async (context): Promise<ApiResponse> => {
        const parameters = apiRoutes.updateMemberGovernance.match(context.pathname);
        if (parameters === undefined) {
          return { status: 404, body: { code: "not_found", message: "member not found", retryable: false } };
        }
        return members.updateGovernance(
          toActor(await sessions.authenticate(context.sessionToken)),
          parameters.personId,
          context.body,
        );
      },
    },
  ] satisfies readonly ApiRouteHandler[]);
}

function toActor(session: AuthenticatedHumanSession | undefined): MemberActor | undefined {
  return session === undefined ? undefined : {
    accountId: session.accountId,
    organizationId: session.organizationId,
    personId: session.personId,
    roles: session.roles,
    authenticationLevel: session.authenticationLevel,
  };
}

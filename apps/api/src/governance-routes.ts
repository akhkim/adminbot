import { apiRoutes } from "@adminbot/api-contracts";
import type { GovernanceActor, GovernanceResult } from "@adminbot/governance";
import type { AuthenticatedHumanSession } from "@adminbot/identity";
import type { ApiResponse, ApiRouteHandler } from "./route-handler.js";
import type { SessionAuthenticator } from "./registration-review-routes.js";

export interface GovernanceApplication {
  getPolicy(actor: GovernanceActor | undefined): Promise<GovernanceResult>;
  replacePolicy(actor: GovernanceActor | undefined, input: unknown): Promise<GovernanceResult>;
  proposeReimbursement(actor: GovernanceActor | undefined, input: unknown): Promise<GovernanceResult>;
  listActions(actor: GovernanceActor | undefined): Promise<GovernanceResult>;
  decide(actor: GovernanceActor | undefined, actionId: string, input: unknown): Promise<GovernanceResult>;
  execute(actor: GovernanceActor | undefined, actionId: string, input: unknown): Promise<GovernanceResult>;
}

export function createGovernanceRoutes(sessions: SessionAuthenticator, governance: GovernanceApplication): readonly ApiRouteHandler[] {
  const actor = async (token: string | undefined) => toActor(await sessions.authenticate(token));
  return Object.freeze([
    { route: apiRoutes.getPolicySettings, body: "none", handle: async (context) => toResponse(await governance.getPolicy(await actor(context.sessionToken))) },
    { route: apiRoutes.replacePolicySettings, body: "json", handle: async (context) => toResponse(await governance.replacePolicy(await actor(context.sessionToken), context.body)) },
    { route: apiRoutes.proposeReimbursementSubmission, body: "json", maximumBodyBytes: 512 * 1_024, handle: async (context) => toResponse(await governance.proposeReimbursement(await actor(context.sessionToken), context.body)) },
    { route: apiRoutes.listGovernedActions, body: "none", handle: async (context) => toResponse(await governance.listActions(await actor(context.sessionToken))) },
    { route: apiRoutes.decideGovernedAction, body: "json", handle: async (context) => toResponse(await governance.decide(await actor(context.sessionToken), requiredActionId(apiRoutes.decideGovernedAction.match(context.pathname)), context.body)) },
    { route: apiRoutes.executeGovernedAction, body: "json", handle: async (context) => toResponse(await governance.execute(await actor(context.sessionToken), requiredActionId(apiRoutes.executeGovernedAction.match(context.pathname)), context.body)) },
  ] satisfies readonly ApiRouteHandler[]);
}

function toActor(session: AuthenticatedHumanSession | undefined): GovernanceActor | undefined {
  return session === undefined ? undefined : { accountId: session.accountId, organizationId: session.organizationId, personId: session.personId, displayName: session.view.person.displayName, roles: session.roles, authenticationLevel: session.authenticationLevel };
}
function requiredActionId(parameters: { readonly actionId: string } | undefined): string { if (parameters === undefined) throw new Error("matched governance route did not expose actionId"); return parameters.actionId; }
function toResponse(result: GovernanceResult): ApiResponse { return { status: result.status, body: result.body }; }

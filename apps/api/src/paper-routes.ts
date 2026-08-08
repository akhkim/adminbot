import { apiRoutes } from "@adminbot/api-contracts";
import type { AuthenticatedHumanSession } from "@adminbot/identity";
import type { PaperActor, PaperCommandResult } from "@adminbot/papers";
import type { ApiResponse, ApiRouteHandler } from "./route-handler.js";
import type { SessionAuthenticator } from "./registration-review-routes.js";

export interface PaperApplication {
  list(actor: PaperActor | undefined): Promise<PaperCommandResult>;
  create(actor: PaperActor | undefined, input: unknown): Promise<PaperCommandResult>;
  update(actor: PaperActor | undefined, paperId: string, input: unknown): Promise<PaperCommandResult>;
  delete(actor: PaperActor | undefined, paperId: string, input: unknown): Promise<PaperCommandResult>;
}

export function createPaperRoutes(
  sessions: SessionAuthenticator,
  papers: PaperApplication,
): readonly ApiRouteHandler[] {
  return Object.freeze([
    {
      route: apiRoutes.listPapers,
      body: "none",
      handle: async (context) => papers.list(toActor(await sessions.authenticate(context.sessionToken))),
    },
    {
      route: apiRoutes.createPaper,
      body: "json",
      handle: async (context) =>
        papers.create(toActor(await sessions.authenticate(context.sessionToken)), context.body),
    },
    {
      route: apiRoutes.updatePaper,
      body: "json",
      handle: async (context) => {
        const parameters = apiRoutes.updatePaper.match(context.pathname);
        if (parameters === undefined) return notFound();
        return papers.update(
          toActor(await sessions.authenticate(context.sessionToken)),
          parameters.paperId,
          context.body,
        );
      },
    },
    {
      route: apiRoutes.deletePaper,
      body: "json",
      handle: async (context) => {
        const parameters = apiRoutes.deletePaper.match(context.pathname);
        if (parameters === undefined) return notFound();
        return papers.delete(
          toActor(await sessions.authenticate(context.sessionToken)),
          parameters.paperId,
          context.body,
        );
      },
    },
  ] satisfies readonly ApiRouteHandler[]);
}

function toActor(session: AuthenticatedHumanSession | undefined): PaperActor | undefined {
  return session === undefined
    ? undefined
    : {
        accountId: session.accountId,
        organizationId: session.organizationId,
        personId: session.personId,
        roles: session.roles,
        authenticationLevel: session.authenticationLevel,
      };
}

function notFound(): ApiResponse {
  return {
    status: 404,
    body: { code: "not_found", message: "paper not found", retryable: false },
  };
}

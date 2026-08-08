import { apiRoutes } from "@adminbot/api-contracts";
import type {
  CurrentSessionResult,
  SessionLoginResult,
  SessionRequestContext,
} from "@adminbot/identity";
import type { ApiResponse, ApiRouteHandler } from "./route-handler.js";
import {
  clearSessionCookie,
  createSessionCookie,
  type SessionCookieOptions,
} from "./session-cookie.js";

export interface SessionApplication {
  login(input: unknown, context?: SessionRequestContext): Promise<SessionLoginResult>;
  current(rawToken: string | undefined): Promise<CurrentSessionResult>;
  logout(rawToken: string | undefined): Promise<void>;
}

export function createSessionRoutes(
  application: SessionApplication,
  cookieOptions: SessionCookieOptions,
): readonly ApiRouteHandler[] {
  return Object.freeze([
    {
      route: apiRoutes.createSession,
      body: "json",
      handle: async (context) => {
        const result = await application.login(context.body, {
          ...(context.remoteAddress === undefined
            ? {}
            : { remoteAddress: context.remoteAddress }),
        });
        return result.ok
          ? {
              status: result.status,
              body: result.body,
              headers: {
                "set-cookie": createSessionCookie(
                  result.credential.token,
                  result.credential.maximumAgeSeconds,
                  cookieOptions,
                ),
              },
            }
          : errorResponse(result);
      },
    },
    {
      route: apiRoutes.getCurrentSession,
      body: "none",
      handle: async (context) => application.current(context.sessionToken),
    },
    {
      route: apiRoutes.deleteCurrentSession,
      body: "none",
      handle: async (context) => {
        await application.logout(context.sessionToken);
        return {
          status: 204,
          headers: { "set-cookie": clearSessionCookie(cookieOptions) },
        };
      },
    },
  ] satisfies readonly ApiRouteHandler[]);
}

function errorResponse(result: Extract<SessionLoginResult, { readonly ok: false }>): ApiResponse {
  return {
    status: result.status,
    body: result.body,
    ...(result.retryAfterSeconds === undefined
      ? {}
      : { headers: { "retry-after": String(result.retryAfterSeconds) } }),
  };
}

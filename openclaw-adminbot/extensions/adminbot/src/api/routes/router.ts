// The authenticated route table's shape: one entry per method and path, each carrying its own
// authorization as a decorator (see guards.ts) rather than as the first lines of its body.
//
// Order is meaningful. The first entry whose method and path both match handles the request, so a
// literal path such as `/lab/members/requests` must come before a pattern such as
// `/lab/members/:id` that would also accept it. Each zone module keeps its routes in that order,
// and server.ts concatenates the zones; no path is claimed by two zones.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminBotPrincipal, AdminBotRouteContext } from "./context.js";

export type RouteMethod = "GET" | "POST" | "PUT" | "DELETE";

export type RouteRequest<P extends AdminBotPrincipal = AdminBotPrincipal> = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  ctx: AdminBotRouteContext;
  principal: P;
  /** What the path matcher captured. `[0]` is the whole pathname, `[1]…` the pattern's groups. */
  params: readonly string[];
};

export type RouteHandler<P extends AdminBotPrincipal = AdminBotPrincipal> = (
  request: RouteRequest<P>,
) => Promise<void> | void;

/** Returns the captures when the pathname belongs to this route, otherwise null. */
export type PathMatcher = (pathname: string) => readonly string[] | null;

export type Route = {
  /** `"*"` accepts every method, for the routes that answer a wrong method themselves. */
  methods: readonly RouteMethod[] | "*";
  match: PathMatcher;
  handle: RouteHandler;
};

function toMatcher(path: string | RegExp | PathMatcher): PathMatcher {
  if (typeof path === "function") {
    return path;
  }
  if (typeof path === "string") {
    return (pathname) => (pathname === path ? [pathname] : null);
  }
  return (pathname) => path.exec(pathname);
}

export function route(
  methods: readonly RouteMethod[] | "*",
  path: string | RegExp | PathMatcher,
  handle: RouteHandler,
): Route {
  return { methods, match: toMatcher(path), handle };
}

export const get = (path: string | RegExp | PathMatcher, handle: RouteHandler) =>
  route(["GET"], path, handle);
export const post = (path: string | RegExp | PathMatcher, handle: RouteHandler) =>
  route(["POST"], path, handle);
export const put = (path: string | RegExp | PathMatcher, handle: RouteHandler) =>
  route(["PUT"], path, handle);
export const del = (path: string | RegExp | PathMatcher, handle: RouteHandler) =>
  route(["DELETE"], path, handle);

/** Paths that begin with `base` -- a sub-router that dispatches the rest itself. */
export function startingWith(base: string): PathMatcher {
  return (pathname) => (pathname.startsWith(base) ? [pathname] : null);
}

/** `base` itself or anything below it, without also claiming `base-something`. */
export function under(base: string): PathMatcher {
  return (pathname) => (pathname === base || pathname.startsWith(`${base}/`) ? [pathname] : null);
}

/** Runs the first matching route. Returns false when none matched, so the caller can 404. */
export async function dispatchRoute(
  routes: readonly Route[],
  request: Omit<RouteRequest, "params">,
): Promise<boolean> {
  const method = request.req.method;
  for (const entry of routes) {
    if (entry.methods !== "*" && !entry.methods.includes(method as RouteMethod)) {
      continue;
    }
    const params = entry.match(request.url.pathname);
    if (!params) {
      continue;
    }
    await entry.handle({ ...request, params });
    return true;
  }
  return false;
}

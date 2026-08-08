export const API_VERSION = "v0alpha" as const;
export const API_BASE_PATH = `/${API_VERSION}` as const;

export type HttpMethod = "DELETE" | "GET" | "POST";

export interface StaticApiRoute<
  Method extends HttpMethod = HttpMethod,
  OperationId extends string = string,
  Template extends string = string,
> {
  readonly method: Method;
  readonly operationId: OperationId;
  readonly template: Template;
  build(): Template;
  matches(pathname: string): boolean;
}

export interface RegistrationDecisionRoute {
  readonly method: "POST";
  readonly operationId: "AuthenticationApi.decideRegistration";
  readonly template: `${typeof API_BASE_PATH}/auth/registrations/{registrationId}/decision`;
  build(parameters: { readonly registrationId: string }): string;
  matches(pathname: string): boolean;
  match(pathname: string): { readonly registrationId: string } | undefined;
}

export type ApiRoute = StaticApiRoute | RegistrationDecisionRoute;

export const apiRoutes = Object.freeze({
  listClaimablePeople: staticRoute(
    "GET",
    "AuthenticationApi.listClaimablePeople",
    "/auth/roster",
  ),
  submitClaim: staticRoute(
    "POST",
    "AuthenticationApi.submitClaim",
    "/auth/registrations/claims",
  ),
  submitSignup: staticRoute(
    "POST",
    "AuthenticationApi.submitSignup",
    "/auth/registrations/signups",
  ),
  listRegistrations: staticRoute(
    "GET",
    "AuthenticationApi.listRegistrations",
    "/auth/registrations",
  ),
  decideRegistration: registrationDecisionRoute(),
  createSession: staticRoute(
    "POST",
    "AuthenticationApi.createSession",
    "/auth/sessions",
  ),
  getCurrentSession: staticRoute(
    "GET",
    "AuthenticationApi.getCurrentSession",
    "/auth/sessions/current",
  ),
  deleteCurrentSession: staticRoute(
    "DELETE",
    "AuthenticationApi.deleteCurrentSession",
    "/auth/sessions/current",
  ),
  changePassword: staticRoute(
    "POST",
    "AuthenticationApi.changePassword",
    "/auth/password",
  ),
  changeEmail: staticRoute(
    "POST",
    "AuthenticationApi.changeEmail",
    "/auth/email",
  ),
  issueDeviceCredential: staticRoute(
    "POST",
    "AuthenticationApi.issueDeviceCredential",
    "/auth/device-credentials",
  ),
  getCurrentPrincipal: staticRoute(
    "GET",
    "CurrentPrincipalApi.getCurrentPrincipal",
    "/me",
  ),
});

export function createApiUrl(serviceOrigin: string, path: string): URL {
  const origin = new URL(serviceOrigin);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("AdminBot API origin must use http or https");
  }
  if (!path.startsWith(`${API_BASE_PATH}/`) && path !== API_BASE_PATH) {
    throw new Error(`AdminBot API paths must be rooted at ${API_BASE_PATH}`);
  }
  return new URL(path, origin);
}

function staticRoute<
  const Method extends HttpMethod,
  const OperationId extends string,
  const RelativePath extends `/${string}`,
>(
  method: Method,
  operationId: OperationId,
  relativePath: RelativePath,
): StaticApiRoute<Method, OperationId, `${typeof API_BASE_PATH}${RelativePath}`> {
  const template = `${API_BASE_PATH}${relativePath}` as `${typeof API_BASE_PATH}${RelativePath}`;
  return Object.freeze({
    method,
    operationId,
    template,
    build: () => template,
    matches: (pathname: string) => pathname === template,
  });
}

function registrationDecisionRoute(): RegistrationDecisionRoute {
  const template = `${API_BASE_PATH}/auth/registrations/{registrationId}/decision` as const;
  const prefix = `${API_BASE_PATH}/auth/registrations/`;
  const suffix = "/decision";
  return Object.freeze({
    method: "POST",
    operationId: "AuthenticationApi.decideRegistration",
    template,
    build: ({ registrationId }: { readonly registrationId: string }) => {
      if (registrationId.length === 0) throw new Error("registrationId is required");
      return `${prefix}${encodeURIComponent(registrationId)}${suffix}`;
    },
    matches: (pathname: string) => matchRegistrationDecisionPath(pathname, prefix, suffix) !== undefined,
    match: (pathname: string) => {
      const registrationId = matchRegistrationDecisionPath(pathname, prefix, suffix);
      return registrationId === undefined ? undefined : { registrationId };
    },
  });
}

function matchRegistrationDecisionPath(
  pathname: string,
  prefix: string,
  suffix: string,
): string | undefined {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  const encoded = pathname.slice(prefix.length, -suffix.length);
  if (encoded.length === 0 || encoded.includes("/")) return undefined;
  try {
    const registrationId = decodeURIComponent(encoded);
    return registrationId.length === 0 ? undefined : registrationId;
  } catch {
    return undefined;
  }
}

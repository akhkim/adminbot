export const API_VERSION = "v0alpha" as const;
export const API_BASE_PATH = `/${API_VERSION}` as const;

export type HttpMethod = "DELETE" | "GET" | "POST";

export interface PaperRoute {
  readonly method: "POST";
  readonly operationId: "PapersApi.updatePaper" | "PapersApi.deletePaper";
  readonly template: string;
  build(parameters: { readonly paperId: string }): string;
  match(pathname: string): { readonly paperId: string } | undefined;
  matches(pathname: string): boolean;
}

export interface MemberTargetRoute {
  readonly method: "POST";
  readonly operationId:
    | "MembersApi.updateGovernance"
    | "MembersApi.replaceRoles"
    | "MembersApi.replaceVisibility";
  readonly template: string;
  build(parameters: { readonly personId: string }): string;
  match(pathname: string): { readonly personId: string } | undefined;
  matches(pathname: string): boolean;
}

export interface GovernedActionRoute {
  readonly method: "POST";
  readonly operationId: "ActionsApi.decideAction" | "ActionsApi.executeAction";
  readonly template: string;
  build(parameters: { readonly actionId: string }): string;
  match(pathname: string): { readonly actionId: string } | undefined;
  matches(pathname: string): boolean;
}

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

export type ApiRoute = StaticApiRoute | RegistrationDecisionRoute | PaperRoute | MemberTargetRoute | GovernedActionRoute;

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
  listMembers: staticRoute("GET", "MembersApi.list", "/members"),
  updateOwnMemberProfile: staticRoute("POST", "MembersApi.updateOwnProfile", "/members/profile"),
  updateMemberGovernance: memberTargetRoute("MembersApi.updateGovernance", "/governance"),
  replaceMemberRoles: memberTargetRoute("MembersApi.replaceRoles", "/roles"),
  replaceMemberVisibility: memberTargetRoute("MembersApi.replaceVisibility", "/visibility"),
  converseReimbursement: staticRoute(
    "POST",
    "ReimbursementsApi.converse",
    "/reimbursements/conversation",
  ),
  generateReimbursementPacket: staticRoute(
    "POST",
    "ReimbursementsApi.generatePacket",
    "/reimbursements/packet",
  ),
  proposeReimbursementSubmission: staticRoute("POST", "ReimbursementsApi.proposeSubmission", "/reimbursements/submissions"),
  getPolicySettings: staticRoute("GET", "PolicySettingsApi.get", "/policy/settings"),
  replacePolicySettings: staticRoute("POST", "PolicySettingsApi.replace", "/policy/settings"),
  listGovernedActions: staticRoute("GET", "ActionsApi.listActions", "/actions"),
  decideGovernedAction: governedActionRoute("ActionsApi.decideAction", "/decisions"),
  executeGovernedAction: governedActionRoute("ActionsApi.executeAction", "/executions"),
  listPapers: staticRoute("GET", "PapersApi.listPapers", "/papers"),
  createPaper: staticRoute("POST", "PapersApi.createPaper", "/papers"),
  updatePaper: paperRoute("PapersApi.updatePaper", ""),
  deletePaper: paperRoute("PapersApi.deletePaper", "/deletion"),
  getAvailabilityWorkspace: staticRoute("GET", "AvailabilityApi.getAvailabilityWorkspace", "/availability"),
  replaceAvailabilityPlan: staticRoute("POST", "AvailabilityApi.replaceAvailabilityPlan", "/availability"),
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

function paperRoute(
  operationId: PaperRoute["operationId"],
  suffix: "" | "/deletion",
): PaperRoute {
  const prefix = `${API_BASE_PATH}/papers/`;
  const template = `${prefix}{paperId}${suffix}`;
  const match = (pathname: string) => {
    if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
    const encoded = pathname.slice(prefix.length, suffix.length === 0 ? undefined : -suffix.length);
    if (encoded.length === 0 || encoded.includes("/")) return undefined;
    try {
      const paperId = decodeURIComponent(encoded);
      return paperId.length === 0 ? undefined : { paperId };
    } catch {
      return undefined;
    }
  };
  return Object.freeze({
    method: "POST" as const,
    operationId,
    template,
    build: ({ paperId }: { readonly paperId: string }) => {
      if (paperId.length === 0) throw new Error("paperId is required");
      return `${prefix}${encodeURIComponent(paperId)}${suffix}`;
    },
    match,
    matches: (pathname: string) => match(pathname) !== undefined,
  });
}

function memberTargetRoute(
  operationId: MemberTargetRoute["operationId"],
  suffix: "/governance" | "/roles" | "/visibility",
): MemberTargetRoute {
  const prefix = `${API_BASE_PATH}/members/`;
  const template = `${prefix}{personId}${suffix}`;
  const match = (pathname: string): { readonly personId: string } | undefined => {
    const parameters = matchSingleSegmentPath(pathname, prefix, suffix, "personId");
    return parameters?.personId === undefined ? undefined : { personId: parameters.personId };
  };
  return Object.freeze({
    method: "POST",
    operationId,
    template,
    build: ({ personId }: { readonly personId: string }) => {
      if (personId.length === 0) throw new Error("personId is required");
      return `${prefix}${encodeURIComponent(personId)}${suffix}`;
    },
    match,
    matches: (pathname: string) => match(pathname) !== undefined,
  });
}

function governedActionRoute(
  operationId: GovernedActionRoute["operationId"],
  suffix: "/decisions" | "/executions",
): GovernedActionRoute {
  const prefix = `${API_BASE_PATH}/actions/`;
  const template = `${prefix}{actionId}${suffix}`;
  const match = (pathname: string) => {
    const parameters = matchSingleSegmentPath(pathname, prefix, suffix, "actionId");
    return parameters?.actionId === undefined ? undefined : { actionId: parameters.actionId };
  };
  return Object.freeze({
    method: "POST",
    operationId,
    template,
    build: ({ actionId }: { readonly actionId: string }) => {
      if (actionId.length === 0) throw new Error("actionId is required");
      return `${prefix}${encodeURIComponent(actionId)}${suffix}`;
    },
    match,
    matches: (pathname: string) => match(pathname) !== undefined,
  });
}

function matchSingleSegmentPath(
  pathname: string,
  prefix: string,
  suffix: string,
  parameter: string,
): Record<string, string> | undefined {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  const encoded = pathname.slice(prefix.length, pathname.length - suffix.length);
  if (encoded.length === 0 || encoded.includes("/")) return undefined;
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length === 0 ? undefined : { [parameter]: decoded };
  } catch {
    return undefined;
  }
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

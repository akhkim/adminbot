import { apiRoutes, createApiUrl, type AdministratorPolicySettings, type DecideGovernedActionCommand, type ErrorResponse, type ExecuteGovernedActionCommand, type GovernedActionProjection, type GovernanceWorkspaceProjection, type ReplaceAdministratorPolicySettingsCommand } from "@adminbot/api-contracts";

export class GovernanceApiError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "GovernanceApiError"; } }
export interface GovernanceClient {
  getPolicy(): Promise<AdministratorPolicySettings>;
  replacePolicy(input: ReplaceAdministratorPolicySettingsCommand): Promise<AdministratorPolicySettings>;
  listActions(): Promise<GovernanceWorkspaceProjection>;
  decide(actionId: string, input: DecideGovernedActionCommand): Promise<GovernedActionProjection>;
  execute(actionId: string, input: ExecuteGovernedActionCommand): Promise<GovernedActionProjection>;
}
export class GovernanceApiClient implements GovernanceClient {
  private readonly fetch: typeof globalThis.fetch;
  constructor(private readonly origin: string, fetch?: typeof globalThis.fetch) { this.fetch = fetch ?? globalThis.fetch.bind(globalThis); }
  getPolicy(): Promise<AdministratorPolicySettings> { return this.request(apiRoutes.getPolicySettings.build(), { method: "GET" }); }
  replacePolicy(input: ReplaceAdministratorPolicySettingsCommand): Promise<AdministratorPolicySettings> { return this.request(apiRoutes.replacePolicySettings.build(), json(input)); }
  listActions(): Promise<GovernanceWorkspaceProjection> { return this.request(apiRoutes.listGovernedActions.build(), { method: "GET" }); }
  decide(actionId: string, input: DecideGovernedActionCommand): Promise<GovernedActionProjection> { return this.request(apiRoutes.decideGovernedAction.build({ actionId }), json(input)); }
  execute(actionId: string, input: ExecuteGovernedActionCommand): Promise<GovernedActionProjection> { return this.request(apiRoutes.executeGovernedAction.build({ actionId }), json(input)); }
  private async request<Result>(path: string, init: RequestInit): Promise<Result> {
    const response = await this.fetch(createApiUrl(this.origin, path), { ...init, credentials: "include", headers: { accept: "application/json", ...init.headers } });
    const body = await response.json().catch(() => undefined) as Result | ErrorResponse | undefined;
    if (!response.ok) { const error = body as ErrorResponse | undefined; throw new GovernanceApiError(response.status, error?.code ?? "internal_error", error?.message ?? "Governance request failed"); }
    if (body === undefined) throw new GovernanceApiError(502, "dependency_unavailable", "AdminBot returned an invalid response");
    return body as Result;
  }
}
function json(body: unknown): RequestInit { return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }; }

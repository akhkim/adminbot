import { apiRoutes, createApiUrl, type AvailabilityWorkspaceProjection, type ErrorResponse, type ReplaceAvailabilityPlanCommand } from "@adminbot/api-contracts";

export class AvailabilityApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "AvailabilityApiError"; }
}
export interface AvailabilityClient {
  get(): Promise<AvailabilityWorkspaceProjection>;
  replace(input: ReplaceAvailabilityPlanCommand): Promise<AvailabilityWorkspaceProjection>;
}
export class AvailabilityApiClient implements AvailabilityClient {
  private readonly fetch: typeof globalThis.fetch;
  constructor(private readonly origin: string, fetch?: typeof globalThis.fetch) { this.fetch = fetch ?? globalThis.fetch.bind(globalThis); }
  get(): Promise<AvailabilityWorkspaceProjection> { return this.request(apiRoutes.getAvailabilityWorkspace.build(), { method: "GET" }); }
  replace(input: ReplaceAvailabilityPlanCommand): Promise<AvailabilityWorkspaceProjection> { return this.request(apiRoutes.replaceAvailabilityPlan.build(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); }
  private async request(path: string, init: RequestInit): Promise<AvailabilityWorkspaceProjection> {
    const response = await this.fetch(createApiUrl(this.origin, path), { ...init, credentials: "include", headers: { accept: "application/json", ...init.headers } });
    const body = await response.json().catch(() => undefined) as AvailabilityWorkspaceProjection | ErrorResponse | undefined;
    if (!response.ok) { const error = body as ErrorResponse | undefined; throw new AvailabilityApiError(response.status, error?.code ?? "internal_error", error?.message ?? "Availability request failed"); }
    if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json" || body === undefined) throw new AvailabilityApiError(502, "dependency_unavailable", "AdminBot returned an invalid response");
    return body as AvailabilityWorkspaceProjection;
  }
}

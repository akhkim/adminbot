import {
  apiRoutes,
  createApiUrl,
  type ErrorResponse,
  type MemberRosterProjection,
  type ReplaceMemberRolesInput,
  type ReplaceMemberVisibilityInput,
  type UpdateMemberGovernanceInput,
  type UpdateOwnMemberProfileInput,
} from "@adminbot/api-contracts";

export class MemberApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "MemberApiError";
  }
}

export interface MemberClient {
  list(): Promise<MemberRosterProjection>;
  updateOwn(input: UpdateOwnMemberProfileInput): Promise<MemberRosterProjection>;
  updateGovernance(personId: string, input: UpdateMemberGovernanceInput): Promise<MemberRosterProjection>;
  replaceRoles(personId: string, input: ReplaceMemberRolesInput): Promise<MemberRosterProjection>;
  replaceVisibility(personId: string, input: ReplaceMemberVisibilityInput): Promise<MemberRosterProjection>;
}

export class MemberApiClient implements MemberClient {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly serviceOrigin: string, fetch?: typeof globalThis.fetch) {
    this.fetch = fetch ?? globalThis.fetch.bind(globalThis);
  }

  list(): Promise<MemberRosterProjection> {
    return this.json(apiRoutes.listMembers.build(), { method: "GET" }) as Promise<MemberRosterProjection>;
  }

  updateOwn(input: UpdateOwnMemberProfileInput): Promise<MemberRosterProjection> {
    return this.json(apiRoutes.updateOwnMemberProfile.build(), post(input)) as Promise<MemberRosterProjection>;
  }

  updateGovernance(personId: string, input: UpdateMemberGovernanceInput): Promise<MemberRosterProjection> {
    return this.json(apiRoutes.updateMemberGovernance.build({ personId }), post(input)) as Promise<MemberRosterProjection>;
  }

  replaceRoles(personId: string, input: ReplaceMemberRolesInput): Promise<MemberRosterProjection> {
    return this.json(apiRoutes.replaceMemberRoles.build({ personId }), post(input)) as Promise<MemberRosterProjection>;
  }

  replaceVisibility(personId: string, input: ReplaceMemberVisibilityInput): Promise<MemberRosterProjection> {
    return this.json(apiRoutes.replaceMemberVisibility.build({ personId }), post(input)) as Promise<MemberRosterProjection>;
  }

  private async json(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetch(createApiUrl(this.serviceOrigin, path), {
      ...init,
      credentials: "include",
      headers: { accept: "application/json", ...init.headers },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as ErrorResponse | undefined;
      throw new MemberApiError(response.status, body?.code ?? "internal_error", body?.message ?? "Member request failed");
    }
    if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
      throw new MemberApiError(502, "dependency_unavailable", "AdminBot returned an invalid response");
    }
    return response.json();
  }
}

function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

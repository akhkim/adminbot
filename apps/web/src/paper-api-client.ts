import {
  apiRoutes,
  createApiUrl,
  type CreatePaperCommand,
  type DeletePaperCommand,
  type ErrorResponse,
  type PaperProjection,
  type PaperWorkspaceProjection,
  type UpdatePaperCommand,
} from "@adminbot/api-contracts";

export class PaperApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "PaperApiError";
  }
}

export interface PaperClient {
  list(): Promise<PaperWorkspaceProjection>;
  create(input: CreatePaperCommand): Promise<PaperProjection>;
  update(paperId: string, input: UpdatePaperCommand): Promise<PaperProjection>;
  delete(paperId: string, input: DeletePaperCommand): Promise<void>;
}

export class PaperApiClient implements PaperClient {
  private readonly fetch: typeof globalThis.fetch;
  constructor(private readonly serviceOrigin: string, fetch?: typeof globalThis.fetch) {
    this.fetch = fetch ?? globalThis.fetch.bind(globalThis);
  }
  async list(): Promise<PaperWorkspaceProjection> {
    return this.json(apiRoutes.listPapers.build(), { method: apiRoutes.listPapers.method }) as Promise<PaperWorkspaceProjection>;
  }
  async create(input: CreatePaperCommand): Promise<PaperProjection> {
    return this.json(apiRoutes.createPaper.build(), request(apiRoutes.createPaper.method, input)) as Promise<PaperProjection>;
  }
  async update(paperId: string, input: UpdatePaperCommand): Promise<PaperProjection> {
    return this.json(apiRoutes.updatePaper.build({ paperId }), request(apiRoutes.updatePaper.method, input)) as Promise<PaperProjection>;
  }
  async delete(paperId: string, input: DeletePaperCommand): Promise<void> {
    await this.json(apiRoutes.deletePaper.build({ paperId }), request(apiRoutes.deletePaper.method, input), true);
  }
  private async json(path: string, init: RequestInit, empty = false): Promise<unknown> {
    const response = await this.fetch(createApiUrl(this.serviceOrigin, path), {
      ...init,
      credentials: "include",
      headers: { accept: "application/json", ...init.headers },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as ErrorResponse | undefined;
      throw new PaperApiError(response.status, body?.code ?? "internal_error", body?.message ?? "Paper request failed");
    }
    if (empty || response.status === 204) return undefined;
    const type = response.headers.get("content-type")?.split(";", 1)[0];
    if (type !== "application/json") throw new PaperApiError(502, "dependency_unavailable", "AdminBot returned an invalid response");
    return response.json();
  }
}

function request(method: "POST", body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

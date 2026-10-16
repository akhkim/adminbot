import type {
  DeadlineRecommendationDirectory,
  DeadlineRecommendationQuery,
  DeadlineRecommendationInput,
  DeadlineRecommendationPreview,
} from "../../../../../extensions/adminbot/src/contracts/deadline-recommendations.js";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import { readApiJson } from "./api-json.ts";
export type {
  DeadlineRecommendationDirectory,
  DeadlineRecommendationQuery,
  DeadlineRecommendationInput,
  DeadlineRecommendationPreview,
};
export interface DeadlineRecommendationStore {
  list(query?: DeadlineRecommendationQuery): Promise<DeadlineRecommendationDirectory>;
  preview(input: DeadlineRecommendationInput): Promise<DeadlineRecommendationPreview>;
  send(preview: DeadlineRecommendationPreview): Promise<DeadlineRecommendationPreview>;
}
export class AdminBotDeadlineRecommendationStore implements DeadlineRecommendationStore {
  constructor(
    private readonly baseUrl = resolveAdminBotBaseUrl(),
    private readonly token = () => loadStoredMemberSession()?.sessionToken,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  async list(query: DeadlineRecommendationQuery = {}): Promise<DeadlineRecommendationDirectory> {
    const params = new URLSearchParams();
    for (const key of ["mode", "q", "offset", "recipient"] as const) {
      if (query[key] !== undefined) {
        params.set(key, String(query[key]));
      }
    }
    for (const id of query.deadlineIds?.length === 0 ? [""] : (query.deadlineIds ?? [])) {
      params.append("deadline", id);
    }
    return this.request(`?${params}`);
  }
  async preview(input: DeadlineRecommendationInput): Promise<DeadlineRecommendationPreview> {
    return this.request("/preview", input);
  }
  async send(preview: DeadlineRecommendationPreview): Promise<DeadlineRecommendationPreview> {
    return this.request(`/${encodeURIComponent(preview.id)}/send`, {
      payload_hash: preview.payload_hash,
    });
  }
  private async request<T>(suffix: string, body?: unknown): Promise<T> {
    const token = this.token();
    if (!token) {
      throw new Error("Sign in to recommend a deadline.");
    }
    const response = await this.fetchImpl(`${this.baseUrl}/deadline-recommendations${suffix}`, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 404 && body === undefined) {
      throw new Error("Deadline recommendations are unavailable. Please try again later.");
    }
    const result = (await readApiJson(response)) as { error?: { message?: string } } | null;
    if (!response.ok || !result) {
      throw new Error(result?.error?.message ?? "Could not load recommendations.");
    }
    return result as T;
  }
}

import type { ApiRoute } from "@adminbot/api-contracts";

export interface ApiRequestContext {
  readonly body?: unknown;
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly remoteAddress?: string;
  readonly sessionToken?: string;
}

export interface ApiResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ApiRouteHandler {
  readonly route: ApiRoute;
  readonly body: "json" | "none";
  readonly maximumBodyBytes?: number;
  handle(context: ApiRequestContext): Promise<ApiResponse>;
}

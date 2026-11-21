// Who uses the AdminBot API, through what, and how it went.
//
// One row per authenticated request, kept for `adminBotApiUsageRetentionDays`, plus a daily rollup
// the admin page reads so the summary stays fast however busy the API gets.
//
// What is deliberately absent: request and response bodies, query strings, raw paths (a path like
// /lab/members/{id} names a person, so only its OpenAPI template is kept), IP addresses (the token
// row already keeps the last one), token values and session ids. A token is named by its public
// `tok_…` id, which is what the owner sees on their tokens page.

export const adminBotApiUsageRetentionDays = 90;

/** How the request proved who it was. */
export type AdminBotApiUsageAuth = "session" | "api_token" | "service";

/**
 * What sent the request.
 *
 *   cli      the adminbot CLI, which sends `User-Agent: adminbot-cli/<version>`
 *   website  the Control UI in a browser
 *   other    anything else holding a token: curl, a script, the cron service
 */
export type AdminBotApiUsageClient = "cli" | "website" | "other";

export type AdminBotApiUsageEntry = {
  at: string;
  /** The person acting: the admin behind a "view as" session, not the member being viewed. */
  member_id?: string;
  auth: AdminBotApiUsageAuth;
  token_id?: string;
  client: AdminBotApiUsageClient;
  client_version?: string;
  /** The OpenAPI operationId, or `unmatched` for a path outside the published contract. */
  operation: string;
  method: string;
  status: number;
  duration_ms: number;
  /**
   * What an automation request did, counted by the service while it ran: `nudges_sent.<domain>`
   * and the like. Only on service-token requests that counted something. See kernel/run-metrics.ts.
   */
  metrics?: Record<string, number>;
};

export type AdminBotApiUsageCount = {
  requests: number;
  client_errors: number;
  server_errors: number;
  avg_ms: number;
  max_ms: number;
};

export type AdminBotApiUsageSummary = {
  from: string;
  days: number;
  totals: AdminBotApiUsageCount & { members: number };
  by_day: Array<AdminBotApiUsageCount & { day: string }>;
  by_member: Array<
    AdminBotApiUsageCount & {
      member_id: string;
      last_at: string;
      cli_requests: number;
      token_requests: number;
    }
  >;
  by_operation: Array<AdminBotApiUsageCount & { operation: string; method: string }>;
  by_client: Array<AdminBotApiUsageCount & { client: string; client_version?: string }>;
  by_auth: Array<AdminBotApiUsageCount & { auth: AdminBotApiUsageAuth }>;
};

const CLI_AGENT = /^adminbot-cli\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,32})?)(?:\s|$)/u;

/**
 * Which client sent a request, from its User-Agent and whether it rode a browser cookie.
 *
 * The version is taken only when it parses as semver, so the column cannot become a place a caller
 * writes arbitrary text into an admin's page.
 */
export function adminBotApiUsageClient(
  userAgent: string | undefined,
  viaCookie: boolean,
): { client: AdminBotApiUsageClient; version?: string } {
  const cli = CLI_AGENT.exec(userAgent ?? "");
  if (cli) {
    return { client: "cli", version: cli[1] };
  }
  return { client: viaCookie ? "website" : "other" };
}

export function adminBotApiUsageDays(raw: string | null | undefined, fallback = 30): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(Math.trunc(parsed), adminBotApiUsageRetentionDays);
}

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
 *   website  a member session that is not the CLI: the Control UI, which sends its session as
 *            `Authorization: Bearer` with credentials omitted, or a cookie
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

/** The whole User-Agent, as cli/client.mjs sends it: nothing before it and nothing after. */
const CLI_AGENT =
  /^adminbot-cli\/(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})([-+][0-9A-Za-z.-]{1,32})?$/u;
const CLI_AGENT_MAX_LENGTH = 64;

/**
 * Which client sent a request, from its User-Agent and how it authenticated.
 *
 * The Control UI never sends a cookie: it holds the member session and sends it as a bearer
 * token with `credentials: "omit"` (ui/src/ui/adminbot/auth/session.ts). So a member session that
 * is not the CLI is the website, and an API token that is not the CLI is something else.
 *
 * The User-Agent must be exactly `adminbot-cli/<version>`, at most 64 characters. The version is
 * kept only as `major.minor.patch`, each part a number of at most three digits with no leading
 * zero, plus `-pre` for any prerelease or build suffix, whose text is never kept. That keeps the
 * column from becoming a place a caller writes arbitrary text into an admin's page, and keeps one
 * caller from growing the daily rollup by inventing a new version on every request.
 */
export function adminBotApiUsageClient(
  userAgent: string | undefined,
  viaSession: boolean,
): { client: AdminBotApiUsageClient; version?: string } {
  const agent = userAgent ?? "";
  const cli = agent.length <= CLI_AGENT_MAX_LENGTH ? CLI_AGENT.exec(agent) : null;
  if (cli) {
    const core = `${cli[1]}.${cli[2]}.${cli[3]}`;
    return { client: "cli", version: cli[4] ? `${core}-pre` : core };
  }
  return { client: viaSession ? "website" : "other" };
}

export function adminBotApiUsageDays(raw: string | null | undefined, fallback = 30): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(Math.trunc(parsed), adminBotApiUsageRetentionDays);
}

/**
 * CLI adoption and power users, for the admin usage page.
 *
 * First and last CLI use come from a one-row-per-member table that outlives the 90-day request
 * log, so "first used" stays true after the request rows are gone. It holds two timestamps per
 * member and client and nothing else.
 */
export type AdminBotApiUsageAdoption = {
  from: string;
  days: number;
  /** Members who stopped: used the CLI before, but not in this many days. */
  dropped_after_days: number;
  totals: {
    /** Members holding at least one live (unrevoked, unexpired) API token. */
    token_holders: number;
    /** Token holders who have used the CLI at least once. */
    token_holders_using_cli: number;
    cli_users_ever: number;
    cli_users_in_window: number;
  };
  /** Everyone with a live token or any CLI use, newest first use first. */
  members: Array<{
    member_id: string;
    live_tokens: number;
    first_cli_at?: string;
    last_cli_at?: string;
  }>;
  /** Distinct CLI users per week (weeks start Monday, UTC), oldest first, over the retained log. */
  weekly_cli_users: Array<{ week: string; users: number }>;
  /** Ranked by calls, then active days, then distinct operations, within the window. */
  power_users: Array<{
    member_id: string;
    requests: number;
    active_days: number;
    operations: number;
    cli_requests: number;
    website_requests: number;
    other_requests: number;
    last_at: string;
    top_operations: Array<{ operation: string; method: string; requests: number }>;
  }>;
  dropped_off: Array<{ member_id: string; first_cli_at: string; last_cli_at: string }>;
};

/** What one sweep endpoint did over a window: the service-token POSTs the cron scripts make. */
export type AdminBotAutomationSweep = {
  operation: string;
  method: string;
  runs: number;
  failures: number;
  avg_ms?: number;
  max_ms?: number;
  last_at?: string;
  last_ok_at?: string;
  /** Summed over the window, for the counters the runs reported. */
  metrics: Record<string, number>;
};

/**
 * Service-token requests that are not sweeps. A GET is somebody reading. The heartbeat is the cron
 * wrapper reporting its run, which already has a row of its own under `jobs`; counting it again as
 * a sweep would list every cron run twice.
 */
export const adminBotNotASweepOperations: readonly string[] = ["post-automation-health-heartbeat"];

export function adminBotIsSweep(run: { method: string; operation: string }): boolean {
  return run.method !== "GET" && !adminBotNotASweepOperations.includes(run.operation);
}

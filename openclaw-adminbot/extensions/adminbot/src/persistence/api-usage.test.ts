import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  adminBotApiUsageClient,
  adminBotApiUsageDays,
  type AdminBotApiUsageEntry,
} from "../contracts/api-usage.js";
import { countNudgeLedgerWrite, countRunMetric, withRunMetrics } from "../kernel/run-metrics.js";
import { cleanRunMetrics } from "../kernel/run-metrics.js";
import {
  createApiUsageLogFromDatabase,
  createMemoryApiUsageLog,
  type ApiUsageLog,
} from "./api-usage.js";

function entry(overrides: Partial<AdminBotApiUsageEntry> = {}): AdminBotApiUsageEntry {
  return {
    at: "2026-11-20T10:00:00.000Z",
    member_id: "ada",
    auth: "session",
    client: "website",
    operation: "listPapers",
    method: "GET",
    status: 200,
    duration_ms: 12,
    ...overrides,
  };
}

const NOW = new Date("2026-11-21T12:00:00.000Z");

const stores: Array<[string, () => ApiUsageLog]> = [
  ["memory", () => createMemoryApiUsageLog()],
  ["sqlite", () => createApiUsageLogFromDatabase(new DatabaseSync(":memory:"))],
];

describe.each(stores)("api usage log (%s)", (_name, make) => {
  it("holds nothing back from the summary once flushed, and nothing before", () => {
    const log = make();
    log.record(entry());
    expect(log.summary({ now: NOW }).totals.requests).toBe(0);
    log.flush(NOW);
    expect(log.summary({ now: NOW }).totals.requests).toBe(1);
  });

  it("rolls requests up by member, operation, client and day", () => {
    const log = make();
    log.record(entry());
    log.record(entry({ duration_ms: 30, status: 404 }));
    log.record(
      entry({
        member_id: "grace",
        auth: "api_token",
        token_id: "tok_abc",
        client: "cli",
        client_version: "0.1.0",
        operation: "createPaper",
        method: "POST",
        status: 500,
        duration_ms: 900,
        at: "2026-11-21T09:00:00.000Z",
      }),
    );
    log.flush(NOW);
    const summary = log.summary({ now: NOW, days: 7 });
    expect(summary.totals).toEqual({
      requests: 3,
      client_errors: 1,
      server_errors: 1,
      avg_ms: 314,
      max_ms: 900,
      members: 2,
    });
    expect(summary.by_day.map((row) => [row.day, row.requests])).toEqual([
      ["2026-11-20", 2],
      ["2026-11-21", 1],
    ]);
    const grace = summary.by_member.find((row) => row.member_id === "grace");
    expect(grace).toMatchObject({ requests: 1, cli_requests: 1, token_requests: 1 });
    expect(summary.by_operation[0]).toMatchObject({ operation: "listPapers", requests: 2 });
    expect(summary.by_client).toContainEqual(
      expect.objectContaining({ client: "cli", client_version: "0.1.0", requests: 1 }),
    );
    expect(summary.by_auth.map((row) => row.auth).toSorted()).toEqual(["api_token", "session"]);
  });

  it("leaves days outside the window out of the summary", () => {
    const log = make();
    log.record(entry({ at: "2026-10-01T00:00:00.000Z" }));
    log.record(entry());
    log.flush(NOW);
    expect(log.summary({ now: NOW, days: 7 }).totals.requests).toBe(1);
  });

  it("lists recent requests newest first, optionally for one member", () => {
    const log = make();
    log.record(entry({ at: "2026-11-20T01:00:00.000Z" }));
    log.record(entry({ at: "2026-11-20T02:00:00.000Z", member_id: "grace" }));
    log.flush(NOW);
    expect(log.recent().map((row) => row.at)).toEqual([
      "2026-11-20T02:00:00.000Z",
      "2026-11-20T01:00:00.000Z",
    ]);
    expect(log.recent({ memberId: "ada" })).toHaveLength(1);
  });

  it("keeps a service run's counters and hands service runs to the automation report", () => {
    const log = make();
    log.record(
      entry({
        member_id: undefined,
        auth: "service",
        client: "other",
        operation: "runPaperflowStages",
        method: "POST",
        metrics: { "nudges_sent.paperflow": 3 },
      }),
    );
    log.record(entry());
    log.flush(NOW);
    expect(log.serviceRuns("2026-11-01T00:00:00.000Z")).toEqual([
      expect.objectContaining({
        operation: "runPaperflowStages",
        metrics: { "nudges_sent.paperflow": 3 },
      }),
    ]);
  });

  it("reports CLI adoption, power users and who stopped", () => {
    const log = make();
    // ada: CLI since September, still active. bo: CLI in August, then only the website.
    log.record(entry({ at: "2026-09-02T09:00:00.000Z", client: "cli", auth: "api_token" }));
    log.record(entry({ at: "2026-11-20T09:00:00.000Z", client: "cli", auth: "api_token" }));
    log.record(entry({ at: "2026-11-19T09:00:00.000Z", client: "cli", operation: "getPaper" }));
    log.record(entry({ at: "2026-11-19T10:00:00.000Z", client: "website" }));
    log.record(entry({ member_id: "bo", at: "2026-08-30T09:00:00.000Z", client: "cli" }));
    log.record(entry({ member_id: "bo", at: "2026-11-18T09:00:00.000Z" }));
    log.record(entry({ member_id: undefined, auth: "service", client: "other" }));
    log.flush(NOW);

    const report = log.adoption({
      now: NOW,
      days: 7,
      liveTokens: new Map([
        ["ada", 1],
        ["cy", 2],
      ]),
    });
    expect(report.totals).toEqual({
      token_holders: 2,
      token_holders_using_cli: 1,
      cli_users_ever: 2,
      cli_users_in_window: 1,
    });
    expect(report.members.map((row) => row.member_id)).toEqual(["ada", "bo", "cy"]);
    expect(report.members[0]).toMatchObject({
      live_tokens: 1,
      first_cli_at: "2026-09-02T09:00:00.000Z",
      last_cli_at: "2026-11-20T09:00:00.000Z",
    });
    // bo has not used the CLI in the last 30 days.
    expect(report.dropped_off).toEqual([
      {
        member_id: "bo",
        first_cli_at: "2026-08-30T09:00:00.000Z",
        last_cli_at: "2026-08-30T09:00:00.000Z",
      },
    ]);
    expect(report.weekly_cli_users).toEqual([
      { week: "2026-08-24", users: 1 },
      { week: "2026-08-31", users: 1 },
      { week: "2026-11-16", users: 1 },
    ]);
    expect(report.power_users.map((row) => row.member_id)).toEqual(["ada", "bo"]);
    expect(report.power_users[0]).toMatchObject({
      requests: 3,
      active_days: 2,
      operations: 2,
      cli_requests: 2,
      website_requests: 1,
      top_operations: [
        { operation: "listPapers", method: "GET", requests: 2 },
        { operation: "getPaper", method: "GET", requests: 1 },
      ],
    });
  });
});

describe("api usage log (sqlite) retention", () => {
  it("prunes rows older than the retention window on a write", () => {
    const db = new DatabaseSync(":memory:");
    const log = createApiUsageLogFromDatabase(db);
    log.record(entry({ at: "2026-07-01T00:00:00.000Z" }));
    log.record(entry());
    log.flush(NOW);
    const raw = db.prepare("SELECT COUNT(*) AS n FROM adminbot_api_usage").get() as { n: number };
    const daily = db.prepare("SELECT COUNT(*) AS n FROM adminbot_api_usage_daily").get() as {
      n: number;
    };
    expect(raw.n).toBe(1);
    expect(daily.n).toBe(1);
    // First use outlives the request rows it came from.
    expect(db.prepare("SELECT member_id, first_at FROM adminbot_api_usage_members").all()).toEqual([
      { member_id: "ada", first_at: "2026-07-01T00:00:00.000Z" },
    ]);
  });

  it("stores no column a body, query string or token value could land in", () => {
    const db = new DatabaseSync(":memory:");
    createApiUsageLogFromDatabase(db);
    const columns = (
      db.prepare("PRAGMA table_info(adminbot_api_usage)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toEqual([
      "id",
      "at",
      "member_id",
      "auth",
      "token_id",
      "client",
      "client_version",
      "operation",
      "method",
      "status",
      "duration_ms",
      "metrics_json",
    ]);
  });
});

describe("adminBotApiUsageClient", () => {
  it("reads the CLI and its version from the User-Agent", () => {
    expect(adminBotApiUsageClient("adminbot-cli/0.1.0", false)).toEqual({
      client: "cli",
      version: "0.1.0",
    });
    expect(adminBotApiUsageClient("adminbot-cli/1.2.3-beta.1 node/22", false)).toEqual({
      client: "cli",
      version: "1.2.3-beta.1",
    });
  });

  it("does not take free text as a version", () => {
    expect(adminBotApiUsageClient("adminbot-cli/<script>", false)).toEqual({ client: "other" });
  });

  it("calls a cookie request the website and anything else other", () => {
    expect(adminBotApiUsageClient("Mozilla/5.0", true)).toEqual({ client: "website" });
    expect(adminBotApiUsageClient("curl/8.0", false)).toEqual({ client: "other" });
    expect(adminBotApiUsageClient(undefined, false)).toEqual({ client: "other" });
  });
});

describe("adminBotApiUsageDays", () => {
  it("falls back, truncates and caps at the retention window", () => {
    expect(adminBotApiUsageDays(null)).toBe(30);
    expect(adminBotApiUsageDays("abc")).toBe(30);
    expect(adminBotApiUsageDays("7.9")).toBe(7);
    expect(adminBotApiUsageDays("365")).toBe(90);
  });
});

describe("run metrics", () => {
  it("counts inside a run and nowhere else", async () => {
    countRunMetric("outside");
    const run = withRunMetrics(async () => {
      countRunMetric("nudges_sent.paperflow");
      await Promise.resolve();
      countRunMetric("nudges_sent.paperflow", 2);
      countRunMetric("Not A Name");
      countRunMetric("negative", -1);
    });
    await run.result;
    expect(run.metrics()).toEqual({ "nudges_sent.paperflow": 3 });
  });

  it("counts a ledger write as a send only when the count went up", () => {
    const run = withRunMetrics(() => {
      countNudgeLedgerWrite(undefined, { domain: "paperflow", nudge_count: 1 });
      countNudgeLedgerWrite(1, { domain: "paperflow", nudge_count: 2 });
      // A snooze writes the row with the count unchanged.
      countNudgeLedgerWrite(2, { domain: "paperflow", nudge_count: 2 });
    });
    expect(run.metrics()).toEqual({ "nudges_sent.paperflow": 2 });
  });

  it("keeps only counters from a heartbeat's metrics", () => {
    expect(
      cleanRunMetrics({
        "emails.reimbursement": 2,
        needs_review: 1,
        "bad name": 3,
        fraction: 1.5,
        negative: -1,
        text: "hello",
      }),
    ).toEqual({ "emails.reimbursement": 2, needs_review: 1 });
    expect(cleanRunMetrics(["x"])).toBeUndefined();
    expect(cleanRunMetrics({})).toBeUndefined();
  });
});

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  adminBotApiUsageClient,
  adminBotApiUsageDays,
  type AdminBotApiUsageEntry,
} from "../contracts/api-usage.js";
import { automationRunReport } from "../kernel/automation-runs.js";
import { countNudgeLedgerWrite, countRunMetric, withRunMetrics } from "../kernel/run-metrics.js";
import { cleanRunMetrics } from "../kernel/run-metrics.js";
import {
  createApiUsageLogFromDatabase,
  createMemoryApiUsageLog,
  type ApiUsageLog,
} from "./api-usage.js";
import { AdminBotSqliteStore } from "./sqlite.js";

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

  it("adds up each sweep's runs and counters, and leaves the heartbeat and reads out", () => {
    const log = make();
    const service = { member_id: undefined, auth: "service" as const, client: "other" as const };
    const sweep = { ...service, operation: "runPaperflowStages", method: "POST" };
    log.record(
      entry({
        ...sweep,
        at: "2026-11-20T10:00:00.000Z",
        duration_ms: 10,
        metrics: { "nudges_sent.paperflow": 3 },
      }),
    );
    log.record(
      entry({
        ...sweep,
        at: "2026-11-20T11:00:00.000Z",
        duration_ms: 21,
        metrics: { "nudges_sent.paperflow": 2, errors: 1 },
      }),
    );
    log.record(entry({ ...sweep, at: "2026-11-20T12:00:00.000Z", duration_ms: 30, status: 500 }));
    // The cron wrapper's own report of the run: already a job, not a second sweep.
    log.record(
      entry({
        ...service,
        operation: "post-automation-health-heartbeat",
        method: "POST",
        metrics: { errors: 9 },
      }),
    );
    log.record(entry({ ...service, operation: "listPapers", method: "GET" }));
    log.record(entry({ ...sweep, at: "2026-10-01T00:00:00.000Z" }));
    log.record(entry());
    log.flush(NOW);
    expect(log.sweeps("2026-11-01T00:00:00.000Z")).toEqual([
      {
        operation: "runPaperflowStages",
        method: "POST",
        runs: 3,
        failures: 1,
        avg_ms: 20,
        max_ms: 30,
        last_at: "2026-11-20T12:00:00.000Z",
        last_ok_at: "2026-11-20T11:00:00.000Z",
        metrics: { "nudges_sent.paperflow": 5, errors: 1 },
      },
    ]);
  });

  it("counts weekly CLI users only over whole weeks", () => {
    const log = make();
    // 90 days before Wednesday 25 November is Thursday 27 August: the week of 24 August is only
    // partly retained, so it is left out rather than shown as a dip.
    const now = new Date("2026-11-25T12:00:00.000Z");
    log.record(entry({ at: "2026-08-28T09:00:00.000Z", client: "cli" }));
    log.record(entry({ member_id: "bo", at: "2026-09-01T09:00:00.000Z", client: "cli" }));
    log.record(entry({ at: "2026-09-06T23:00:00.000Z", client: "cli" }));
    log.flush(now);
    expect(log.adoption({ now, days: 90, liveTokens: new Map() }).weekly_cli_users).toEqual([
      { week: "2026-08-31", users: 2 },
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
    // Any prerelease or build suffix folds into one `-pre`, so a caller cannot grow the rollup
    // with a new version string on every request.
    expect(adminBotApiUsageClient("adminbot-cli/1.2.3-beta.1", false)).toEqual({
      client: "cli",
      version: "1.2.3-pre",
    });
    expect(adminBotApiUsageClient("adminbot-cli/1.2.3+build.7", false)).toEqual({
      client: "cli",
      version: "1.2.3-pre",
    });
  });

  it("does not take free text or oversized parts as a version", () => {
    expect(adminBotApiUsageClient("adminbot-cli/<script>", false)).toEqual({ client: "other" });
    expect(adminBotApiUsageClient("adminbot-cli/1234.0.0", false)).toEqual({ client: "other" });
    expect(adminBotApiUsageClient(`adminbot-cli/1.0.0-${"x".repeat(40)}`, false)).toEqual({
      client: "other",
    });
    // Leading zeros, anything around the token, and a suffix past 32 characters are not the CLI.
    expect(adminBotApiUsageClient("adminbot-cli/01.2.3", false)).toEqual({ client: "other" });
    expect(adminBotApiUsageClient("adminbot-cli/1.2.3 extra", false)).toEqual({ client: "other" });
    expect(adminBotApiUsageClient("adminbot-cli/1.2.3-beta.1 node/22", false)).toEqual({
      client: "other",
    });
    expect(adminBotApiUsageClient("x adminbot-cli/1.2.3", false)).toEqual({ client: "other" });
    expect(adminBotApiUsageClient(`adminbot-cli/1.2.3-${"a".repeat(32)}`, false)).toEqual({
      client: "cli",
      version: "1.2.3-pre",
    });
    expect(adminBotApiUsageClient(`adminbot-cli/1.2.3-${"a".repeat(33)}`, false)).toEqual({
      client: "other",
    });
    // A session whose agent is not the CLI is the website, whatever version it claims.
    expect(adminBotApiUsageClient("adminbot-cli/1234.0.0", true)).toEqual({ client: "website" });
  });

  it("calls a member session the website and anything else other", () => {
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

describe("api usage across member merge and delete", () => {
  function seed(store: AdminBotSqliteStore) {
    const log = store.apiUsageLog();
    // Same day, operation and client for both: the cells collide on merge.
    log.record(entry({ member_id: "ada", duration_ms: 10, at: "2026-11-20T09:00:00.000Z" }));
    log.record(
      entry({ member_id: "ada-dup", duration_ms: 40, status: 500, at: "2026-11-20T11:00:00.000Z" }),
    );
    log.record(entry({ member_id: "ada-dup", duration_ms: 20, at: "2026-11-20T10:00:00.000Z" }));
    log.record(entry({ member_id: "ada-dup", client: "cli", at: "2026-09-01T09:00:00.000Z" }));
    log.record(entry({ member_id: "ada", client: "cli", at: "2026-11-01T09:00:00.000Z" }));
    log.flush(NOW);
    return log;
  }

  it("adds a merged member's colliding rollup cells into the survivor", () => {
    const store = new AdminBotSqliteStore(":memory:");
    const log = seed(store);
    // Read once first: the merge must not be hidden behind a cached answer.
    expect(log.summary({ now: NOW, days: 90 }).by_member).toHaveLength(2);
    store.reassignMemberReferences("ada-dup", "ada");
    const ada = log.summary({ now: NOW, days: 90 }).by_member;
    expect(ada).toEqual([
      expect.objectContaining({
        member_id: "ada",
        requests: 5,
        server_errors: 1,
        max_ms: 40,
        last_at: "2026-11-20T11:00:00.000Z",
        cli_requests: 2,
      }),
    ]);
    // The website cell: 10 + 20 + 40 over three requests.
    const website = log.summary({ now: NOW, days: 7 }).by_member[0];
    expect(website).toMatchObject({ requests: 3, avg_ms: 23 });
    // First CLI use is the duplicate's earlier one, last is the survivor's later one.
    expect(log.adoption({ now: NOW, liveTokens: new Map() }).members).toEqual([
      {
        member_id: "ada",
        live_tokens: 0,
        first_cli_at: "2026-09-01T09:00:00.000Z",
        last_cli_at: "2026-11-01T09:00:00.000Z",
      },
    ]);
    store.close();
  });

  // Rows still in the write buffer when a member goes must not bring them back on the next flush.
  function buffered(store: AdminBotSqliteStore) {
    const log = seed(store);
    log.record(entry({ member_id: "ada-dup", client: "cli", at: "2026-11-20T12:00:00.000Z" }));
    return log;
  }

  it("does not let buffered rows bring back a purged member", () => {
    const store = new AdminBotSqliteStore(":memory:");
    const log = buffered(store);
    store.purgeMemberReferences("ada-dup");
    log.flush(NOW);
    expect(log.recent({ memberId: "ada-dup" })).toEqual([]);
    expect(log.summary({ now: NOW, days: 90 }).by_member.map((row) => row.member_id)).toEqual([
      "ada",
    ]);
    store.close();
  });

  it("does not let buffered rows bring back a merged duplicate", () => {
    const store = new AdminBotSqliteStore(":memory:");
    const log = buffered(store);
    store.reassignMemberReferences("ada-dup", "ada");
    log.flush(NOW);
    const members = log.summary({ now: NOW, days: 90 }).by_member;
    expect(members.map((row) => row.member_id)).toEqual(["ada"]);
    expect(members[0]).toMatchObject({ requests: 6, cli_requests: 3 });
    expect(
      log.adoption({ now: NOW, liveTokens: new Map() }).members.map((row) => row.member_id),
    ).toEqual(["ada"]);
    store.close();
  });

  it("renames buffered rows along with the rest", () => {
    const store = new AdminBotSqliteStore(":memory:");
    const log = buffered(store);
    store.renameMemberId("ada-dup", "ada-new");
    log.flush(NOW);
    expect(log.recent({ memberId: "ada-dup" })).toEqual([]);
    expect(log.recent({ memberId: "ada-new" })).toHaveLength(4);
    expect(
      log
        .summary({ now: NOW, days: 90 })
        .by_member.map((row) => row.member_id)
        .toSorted(),
    ).toEqual(["ada", "ada-new"]);
    store.close();
  });

  it("purges a deleted member's usage, including first and last use", () => {
    const store = new AdminBotSqliteStore(":memory:");
    const log = seed(store);
    store.purgeMemberReferences("ada-dup");
    expect(log.summary({ now: NOW, days: 90 }).by_member.map((row) => row.member_id)).toEqual([
      "ada",
    ]);
    expect(log.recent({ memberId: "ada-dup" })).toEqual([]);
    expect(
      log.adoption({ now: NOW, liveTokens: new Map() }).members.map((row) => row.member_id),
    ).toEqual(["ada"]);
    store.close();
  });
});

describe("api usage write failures", () => {
  it("says how many rows it dropped and why, and never what they were", () => {
    const db = new DatabaseSync(":memory:");
    const log = createApiUsageLogFromDatabase(db);
    db.exec("DROP TABLE adminbot_api_usage");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      log.record(entry({ member_id: "ada-secret-id", token_id: "tok_visible" }));
      log.record(entry({ member_id: "ada-secret-id" }));
      expect(() => log.flush(NOW)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toMatch(/^AdminBot API usage: dropped 2 request rows: .*adminbot_api_usage/u);
      expect(message).not.toContain("ada-secret-id");
      expect(message).not.toContain("tok_visible");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("api usage page latency", () => {
  // The supported ceiling, written down in docs/adminbot/usage-telemetry.md: 324k rollup cells
  // (60 members x 60 operations x 90 days, far busier than the lab), 50k service runs and an audit
  // log of 200k events, 26k of them cron heartbeats.
  it("answers the page's three reads within the budget at the supported ceiling", () => {
    const store = new AdminBotSqliteStore(":memory:");
    const db = (store as unknown as { db: DatabaseSync }).db;
    const log = store.apiUsageLog();
    // Seeded in SQL: the write path is not what is being timed.
    db.exec("BEGIN");
    const cell = db.prepare(`INSERT INTO adminbot_api_usage_daily
      (day, member_id, auth, token_id, client, client_version, operation, method,
       requests, client_errors, server_errors, total_ms, max_ms, last_at)
      VALUES (?, ?, 'api_token', 'tok', ?, '', ?, 'GET', 3, 0, 0, 30, 15, ?)`);
    for (let d = 0; d < 90; d += 1) {
      const day = new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10);
      for (let m = 0; m < 60; m += 1) {
        for (let o = 0; o < 60; o += 1) {
          cell.run(day, `m${m}`, o % 2 ? "cli" : "website", `op${o}`, `${day}T10:00:00.000Z`);
        }
      }
    }
    const run = db.prepare(`INSERT INTO adminbot_api_usage
      (at, auth, client, operation, method, status, duration_ms, metrics_json)
      VALUES (?, 'service', 'other', ?, 'POST', 200, 50, '{"errors":1}')`);
    for (let i = 0; i < 50_000; i += 1) {
      run.run(new Date(NOW.getTime() - (i % 90) * 86_400_000).toISOString(), `sweep${i % 12}`);
    }
    const audit = db.prepare(`INSERT INTO adminbot_audit_events
      (id, action_id, event_type, timestamp, actor, event_json) VALUES (?, NULL, ?, ?, 'system', ?)`);
    for (let i = 0; i < 200_000; i += 1) {
      // A heartbeat every 5 minutes across 12 jobs for 90 days, the rest ordinary events spread
      // over the year the audit log keeps.
      const heartbeat = i < 26_000;
      const at = new Date(
        NOW.getTime() - (heartbeat ? i * 300_000 : (i % 365) * 86_400_000 + i),
      ).toISOString();
      const type = heartbeat ? "automation_health.heartbeat" : "member.updated";
      const event = {
        id: `ev${i}`,
        type,
        timestamp: at,
        actor: "system",
        details: heartbeat
          ? { job: `job${i % 12}`, ok: i % 50 !== 0, duration_ms: 1000, metrics: { errors: 0 } }
          : { member_id: `m${i % 60}` },
      };
      audit.run(event.id, type, at, JSON.stringify(event));
    }
    db.exec("COMMIT");

    const fromIso = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    const page = () => ({
      summary: log.summary({ now: NOW, days: 90 }),
      adoption: log.adoption({ now: NOW, days: 90, liveTokens: new Map() }),
      automation: automationRunReport({
        events: store.listAuditEventsSince("automation_health.heartbeat", fromIso),
        sweeps: log.sweeps(fromIso),
        from: fromIso,
        days: 90,
      }),
    });
    // Best of three cold loads, each after a write so no cached answer is reused: one slow
    // attempt on a busy CI machine is noise, three in a row is a regression.
    const timings: number[] = [];
    let result: ReturnType<typeof page> | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      log.record(entry({ at: NOW.toISOString(), member_id: "m0" }));
      log.flush(NOW);
      const started = performance.now();
      result = page();
      timings.push(performance.now() - started);
    }

    expect(result!.summary.by_member).toHaveLength(60);
    expect(result!.adoption.power_users[0]?.top_operations).toHaveLength(3);
    expect(result!.automation.sweeps).toHaveLength(12);
    expect(result!.automation.jobs).toHaveLength(12);
    expect(Math.min(...timings)).toBeLessThan(1000);
    store.close();
  }, 120_000);
});

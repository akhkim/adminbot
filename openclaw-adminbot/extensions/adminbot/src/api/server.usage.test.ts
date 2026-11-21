// API usage telemetry over HTTP: which requests become rows, what a row says, and who may read them.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryApiUsageLog } from "../persistence/api-usage.js";
import type { AdminBotSqliteStore } from "../persistence/sqlite.js";
import { hashPassword } from "../workflows/identity/auth.js";
import { noteUsagePrincipal, trackApiUsage } from "./routes/usage.js";
import { createAdminBotMockService } from "./server.js";

const PASSWORD = "synthetic-password-1";
const PASSWORD_HASH = hashPassword(PASSWORD);
const SERVICE = "test-usage-service-token";
const running: Array<ReturnType<typeof createAdminBotMockService>> = [];

afterEach(async () => {
  for (const mock of running.splice(0)) {
    await new Promise<void>((resolve) => {
      mock.server.close(() => resolve());
    });
    mock.close();
  }
});

async function start(options: { plainCliRole?: "power_user" } = {}) {
  const mock = createAdminBotMockService({ serviceToken: SERVICE });
  running.push(mock);
  await new Promise<void>((resolve) => {
    mock.server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = mock.server.address() as { port: number };
  for (const [id, level] of [
    ["admin-a", "admin"],
    ["plain-c", "member"],
  ] as const) {
    mock.store.saveLabMember({
      id,
      name: `Test ${id}`,
      email: `${id}@example.invalid`,
      privilege_level: level,
      ...(id === "plain-c" && options.plainCliRole ? { cli_role: options.plainCliRole } : {}),
      access: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    mock.store.saveCredential({
      member_id: id,
      email: `${id}@example.invalid`,
      password_scrypt: PASSWORD_HASH,
      claimed_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  }
  return { mock, baseUrl: `http://127.0.0.1:${port}` };
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  options: {
    bearer?: string;
    agent?: string;
    body?: unknown;
    headers?: Record<string, string>;
    credentials?: RequestCredentials;
  } = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.bearer) {
    headers.Authorization = `Bearer ${options.bearer}`;
  }
  if (options.agent) {
    headers["User-Agent"] = options.agent;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  // The row is written when the server sees the response close, a tick after the client has it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function signIn(baseUrl: string, id: string): Promise<string> {
  const login = await call(baseUrl, "POST", "/auth/login", {
    body: { email: `${id}@example.invalid`, password: PASSWORD },
  });
  expect(login.status).toBe(200);
  return login.body.session_token as string;
}

describe("API usage telemetry", () => {
  it("records who called what, through which client, and how it went", async () => {
    const { baseUrl } = await start();
    const session = await signIn(baseUrl, "plain-c");
    expect(
      (
        await call(baseUrl, "GET", "/auth/session", {
          bearer: session,
          agent: "adminbot-cli/0.1.0",
        })
      ).status,
    ).toBe(200);
    // Unauthenticated: nobody's usage, so no row.
    expect((await call(baseUrl, "GET", "/papers")).status).toBe(401);

    const recent = await call(baseUrl, "GET", "/usage/requests?member_id=plain-c", {
      bearer: SERVICE,
    });
    expect(recent.status).toBe(200);
    const row = recent.body.requests.find(
      (entry: { operation: string }) => entry.operation !== "unmatched",
    );
    expect(row).toMatchObject({
      member_id: "plain-c",
      auth: "session",
      client: "cli",
      client_version: "0.1.0",
      method: "GET",
      status: 200,
    });
    expect(typeof row.duration_ms).toBe("number");
    // Nothing that names a request's content or its credential.
    expect(JSON.stringify(recent.body)).not.toContain(session);

    const summary = await call(baseUrl, "GET", "/usage/summary?days=7", { bearer: SERVICE });
    expect(summary.status).toBe(200);
    expect(summary.body.days).toBe(7);
    const member = summary.body.by_member.find(
      (entry: { member_id: string }) => entry.member_id === "plain-c",
    );
    expect(member).toMatchObject({ name: "Test plain-c", cli_requests: 1 });
    expect(
      summary.body.by_member.some((entry: { member_id: string }) => entry.member_id === ""),
    ).toBe(false);
  });

  it("counts the Control UI as the website, from the headers it really sends", async () => {
    const { baseUrl } = await start();
    const session = await signIn(baseUrl, "plain-c");
    // ui/src/ui/adminbot/auth/session.ts: the session as a bearer, credentials omitted, no cookie.
    const page = await call(baseUrl, "GET", "/auth/session", {
      bearer: session,
      credentials: "omit",
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      },
    });
    expect(page.status).toBe(200);
    const recent = await call(baseUrl, "GET", "/usage/requests?member_id=plain-c", {
      bearer: SERVICE,
    });
    const row = recent.body.requests.find(
      (entry: { operation: string }) =>
        entry.operation !== "unmatched" && entry.operation !== "post-auth-login",
    );
    expect(row).toMatchObject({ auth: "session", client: "website", method: "GET", status: 200 });
    expect(row.client_version).toBeUndefined();
  });

  it("records 499 when the client hangs up after the headers went", async () => {
    const log = createMemoryApiUsageLog();
    const req = {
      method: "GET",
      url: "/auth/session",
      headers: { "user-agent": "adminbot-cli/0.3.0" },
    } as unknown as IncomingMessage;
    noteUsagePrincipal(req, { kind: "service" });
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headersSent: true,
      writableFinished: false,
    }) as unknown as ServerResponse;
    await trackApiUsage(req, res, log, async () => {});
    res.emit("close");
    log.flush();
    expect(log.recent()).toEqual([expect.objectContaining({ status: 499, auth: "service" })]);

    // The same request finishing normally keeps its real status.
    const done = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished: true,
    }) as unknown as ServerResponse;
    await trackApiUsage(req, done, log, async () => {});
    done.emit("close");
    log.flush();
    expect(
      log
        .recent()
        .map((entry) => entry.status)
        .sort(),
    ).toEqual([200, 499]);
  });

  it("keeps the true status of a bodiless answer on a real socket: HEAD, 204 and 304", async () => {
    const log = createMemoryApiUsageLog();
    const server = createServer((req, res) => {
      noteUsagePrincipal(req, { kind: "service" });
      void trackApiUsage(req, res, log, async () => {
        res.statusCode = req.method === "HEAD" ? 200 : req.url === "/a" ? 204 : 304;
        if (req.method === "HEAD") {
          res.setHeader("Content-Length", "12");
        }
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      for (const [method, path] of [
        ["HEAD", "/auth/session"],
        ["GET", "/a"],
        ["GET", "/b"],
      ] as const) {
        await new Promise<void>((resolve, reject) => {
          const sent = request({ host: "127.0.0.1", port, method, path }, (response) => {
            response.resume();
            response.on("end", resolve);
          });
          sent.on("error", reject);
          sent.end();
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      log.flush();
      expect(
        log
          .recent()
          .map((entry) => `${entry.method} ${entry.status}`)
          .toSorted(),
      ).toEqual(["GET 204", "GET 304", "HEAD 200"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("records a revalidated GET as 304", async () => {
    const { baseUrl } = await start();
    const session = await signIn(baseUrl, "plain-c");
    const first = await fetch(`${baseUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${session}` },
    });
    const etag = first.headers.get("etag");
    await first.text();
    expect(etag).toBeTruthy();
    const again = await call(baseUrl, "GET", "/auth/session", {
      bearer: session,
      headers: { "If-None-Match": etag! },
    });
    expect(again.status).toBe(304);
    const recent = await call(baseUrl, "GET", "/usage/requests?member_id=plain-c", {
      bearer: SERVICE,
    });
    const statuses = recent.body.requests
      .filter(
        (entry: { method: string; operation: string }) => entry.operation !== "post-auth-login",
      )
      .map((entry: { status: number }) => entry.status);
    expect(statuses.toSorted()).toEqual([200, 304]);
  });

  it("names a personal token by its id, never its value", async () => {
    const { baseUrl } = await start();
    const session = await signIn(baseUrl, "admin-a");
    const created = await call(baseUrl, "POST", "/auth/api-tokens", {
      bearer: session,
      body: { name: "agent", expires_in_days: 30 },
    });
    expect(created.status).toBe(201);
    const token = created.body.token as string;
    expect((await call(baseUrl, "GET", "/auth/session", { bearer: token })).status).toBe(200);
    const recent = await call(baseUrl, "GET", "/usage/requests?member_id=admin-a", {
      bearer: SERVICE,
    });
    const tokenRow = recent.body.requests.find(
      (entry: { auth: string }) => entry.auth === "api_token",
    );
    expect(tokenRow.token_id).toBe(created.body.api_token.id);
    expect(JSON.stringify(recent.body)).not.toContain(token);

    // The token makes admin-a a holder; a CLI call through it makes them a CLI user.
    await call(baseUrl, "GET", "/auth/session", { bearer: token, agent: "adminbot-cli/0.2.0" });
    const adoption = await call(baseUrl, "GET", "/usage/adoption?days=7", { bearer: SERVICE });
    expect(adoption.status).toBe(200);
    expect(adoption.body.totals).toMatchObject({ token_holders: 1, token_holders_using_cli: 1 });
    expect(adoption.body.power_users[0]).toMatchObject({
      member_id: "admin-a",
      name: "Test admin-a",
    });
    expect(JSON.stringify(adoption.body)).not.toContain(token);
  });

  it("is admin-only", async () => {
    const { baseUrl } = await start();
    const member = await signIn(baseUrl, "plain-c");
    const admin = await signIn(baseUrl, "admin-a");
    for (const path of [
      "/usage/summary",
      "/usage/requests",
      "/usage/automation",
      "/usage/adoption",
    ]) {
      expect((await call(baseUrl, "GET", path, { bearer: member })).status).toBe(403);
      expect((await call(baseUrl, "GET", path)).status).toBe(401);
      expect((await call(baseUrl, "GET", path, { bearer: admin })).status).toBe(200);
    }
  });

  it("refuses a non-admin power_user token", async () => {
    const { baseUrl } = await start({ plainCliRole: "power_user" });
    const session = await signIn(baseUrl, "plain-c");
    const created = await call(baseUrl, "POST", "/auth/api-tokens", {
      bearer: session,
      body: { name: "pilot", expires_in_days: 30 },
    });
    expect(created.status).toBe(201);
    const token = created.body.token as string;
    const whoami = await call(baseUrl, "GET", "/auth/session", { bearer: token });
    expect(whoami.body.token_role).toBe("power_user");
    for (const path of [
      "/usage/summary",
      "/usage/requests",
      "/usage/automation",
      "/usage/adoption",
    ]) {
      expect((await call(baseUrl, "GET", path, { bearer: token })).status).toBe(403);
    }
  });

  it("reports cron runs with their duration and counters", async () => {
    const { baseUrl } = await start();
    const beat = await call(baseUrl, "POST", "/automation/health/heartbeat", {
      bearer: SERVICE,
      body: {
        job: "adminbot-email",
        ok: true,
        cron: "0 * * * *",
        duration_ms: 4200,
        metrics: { "emails.reimbursement": 2, needs_review: 1, "not a counter": 5 },
      },
    });
    expect(beat.status).toBe(200);
    await call(baseUrl, "POST", "/automation/health/heartbeat", {
      bearer: SERVICE,
      body: { job: "adminbot-email", ok: false, duration_ms: 800, metrics: { errors: 1 } },
    });
    const report = await call(baseUrl, "GET", "/usage/automation?days=7", { bearer: SERVICE });
    expect(report.status).toBe(200);
    expect(report.body.jobs).toEqual([
      expect.objectContaining({
        job: "adminbot-email",
        runs: 2,
        failures: 1,
        avg_ms: 2500,
        max_ms: 4200,
        metrics: { "emails.reimbursement": 2, needs_review: 1, errors: 1 },
      }),
    ]);
    // The heartbeat is the cron wrapper reporting the run above, not a sweep of its own.
    expect(report.body.sweeps).toEqual([]);
  });
});

describe("api usage page latency", () => {
  // The supported ceiling, written down in docs/adminbot/usage-telemetry.md: 162k rollup cells
  // (40 members each calling 45 operations every day for 90 days, busier than the lab), 50k
  // service runs and an audit log of 200k events, 26k of them cron heartbeats (the 55 cron jobs
  // run about 310 times a day). Timed through the real authenticated routes the page calls,
  // against a SQLite store, so routing, auth and serialization are in the number.
  it("answers the page's three GETs within the budget at the supported ceiling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adminbot-usage-latency-"));
    const mock = createAdminBotMockService({
      serviceToken: SERVICE,
      databasePath: join(dir, "adminbot.sqlite"),
    });
    running.push(mock);
    try {
      await new Promise<void>((resolve) => {
        mock.server.listen(0, "127.0.0.1", resolve);
      });
      const { port } = mock.server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${port}`;
      const store = mock.store as AdminBotSqliteStore;
      const db = (store as unknown as { db: DatabaseSync }).db;
      const now = Date.now();
      // Seeded in SQL: the write path is not what is being timed.
      db.exec("BEGIN");
      const cell = db.prepare(`INSERT INTO adminbot_api_usage_daily
        (day, member_id, auth, token_id, client, client_version, operation, method,
         requests, client_errors, server_errors, total_ms, max_ms, last_at)
        VALUES (?, ?, 'api_token', 'tok', ?, '', ?, 'GET', 3, 0, 0, 30, 15, ?)`);
      for (let d = 0; d < 90; d += 1) {
        const day = new Date(now - d * 86_400_000).toISOString().slice(0, 10);
        for (let m = 0; m < 40; m += 1) {
          for (let o = 0; o < 45; o += 1) {
            cell.run(day, `m${m}`, o % 2 ? "cli" : "website", `op${o}`, `${day}T10:00:00.000Z`);
          }
        }
      }
      const run = db.prepare(`INSERT INTO adminbot_api_usage
        (at, auth, client, operation, method, status, duration_ms, metrics_json)
        VALUES (?, 'service', 'other', ?, 'POST', 200, 50, '{"errors":1}')`);
      for (let i = 0; i < 50_000; i += 1) {
        run.run(new Date(now - (i % 89) * 86_400_000 - 60_000).toISOString(), `sweep${i % 12}`);
      }
      const audit = db.prepare(`INSERT INTO adminbot_audit_events
        (id, action_id, event_type, timestamp, actor, event_json) VALUES (?, NULL, ?, ?, 'system', ?)`);
      for (let i = 0; i < 200_000; i += 1) {
        // A heartbeat every 5 minutes across 12 jobs for 90 days, the rest ordinary events spread
        // over the year the audit log keeps.
        const heartbeat = i < 26_000;
        const at = new Date(
          now - 60_000 - (heartbeat ? i * 300_000 : (i % 365) * 86_400_000 + i),
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

      const page = async () => {
        const [summary, adoption, automation] = await Promise.all(
          ["summary", "adoption", "automation"].map((name) =>
            call(baseUrl, "GET", `/usage/${name}?days=90`, { bearer: SERVICE }),
          ),
        );
        return { summary, adoption, automation };
      };
      // Best of five cold loads. Before each, the store writes something that is not usage, as
      // heartbeats and member edits do between two visits to the page, so no load reuses the
      // window the last one read. One slow attempt on a busy CI machine is noise; five in a row
      // is a regression.
      const unrelated = db.prepare(`INSERT INTO adminbot_audit_events
        (id, action_id, event_type, timestamp, actor, event_json)
        VALUES (?, NULL, 'member.updated', ?, 'system', '{}')`);
      const timings: number[] = [];
      let result: Awaited<ReturnType<typeof page>> | undefined;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        store.apiUsageLog().flush();
        unrelated.run(`between-loads-${attempt}`, new Date().toISOString());
        const started = performance.now();
        result = await page();
        timings.push(performance.now() - started);
      }

      for (const response of Object.values(result!)) {
        expect(response.status).toBe(200);
      }
      expect(result!.summary.body.by_member).toHaveLength(40);
      expect(result!.adoption.body.power_users[0]?.top_operations).toHaveLength(3);
      expect(result!.automation.body.sweeps).toHaveLength(12);
      expect(result!.automation.body.jobs).toHaveLength(12);
      expect(Math.min(...timings)).toBeLessThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

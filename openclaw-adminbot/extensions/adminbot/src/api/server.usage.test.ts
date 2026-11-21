// API usage telemetry over HTTP: which requests become rows, what a row says, and who may read them.
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryApiUsageLog } from "../persistence/api-usage.js";
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

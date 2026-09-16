import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { inferenceTestConfig } from "../inference/config.test-support.js";
import { createInferenceGate, type InferenceFetch } from "../inference/gate.js";
import { openInferenceTestDb } from "../inference/gate.test-support.js";
import { createAdminBotPrivacyBroker } from "../privacy/broker.js";
import { TaskRuntime } from "../tasks/runtime.js";
import { VisitorSessions } from "../tasks/visitors.js";
import { createAdminBotMockService } from "./server.js";
import { handleTaskRoute, submitHttpTask } from "./server.tasks.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});
async function serve(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("no address");
  }
  return `http://127.0.0.1:${address.port}`;
}
async function until<T>(fn: () => T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = fn();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("task did not settle");
}

describe("application task HTTP API", () => {
  it("sheds the whole privacy operation, waits without resubmission and returns its final local output", async () => {
    let calls = 0;
    const fetchImpl: InferenceFetch = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    calls === 1
                      ? JSON.stringify({
                          classification: "uncertain",
                          sanitized_task: "",
                          replacements: [],
                        })
                      : "Synthetic complete reasoning",
                },
              },
            ],
          }),
      };
    };
    const gate = createInferenceGate({
      db: openInferenceTestDb(),
      env: {},
      config: inferenceTestConfig({ capacity: 1 }),
      fetchImpl,
    });
    gate.pause("test");
    const privacyBroker = createAdminBotPrivacyBroker(undefined, { gate, fetchImpl, env: {} });
    const app = createAdminBotMockService({
      serviceToken: "synthetic-test-token",
      inferenceGate: gate,
      privacyBroker,
      calendarInviteRunner: async () => {},
      accountApprovedEmailRunner: async () => {},
      dcsFormRunner: async () => {},
    });
    gate.setShutdownGraceMs(0, "test");
    cleanups.push(() => app.close());
    const base = await serve(app.server);
    const headers = {
      Authorization: "Bearer synthetic-test-token",
      "Content-Type": "application/json",
      "Idempotency-Key": "original",
    };
    const submit = () =>
      fetch(`${base}/privacy/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({ task: "Write a synthetic greeting", privacy: "private" }),
      });
    const initial = await submit();
    expect(initial.status).toBe(409);
    const { task } = (await initial.json()) as { task: { id: string; status: string } };
    expect(task.status).toBe("shed");
    expect(calls).toBe(0);
    expect(((await (await submit()).json()) as { task: { id: string } }).task.id).toBe(task.id);
    expect((await fetch(`${base}/tasks/${task.id}`)).status).toBe(401);
    const waiting = await fetch(`${base}/tasks/${task.id}/wait`, { method: "POST", headers });
    expect(waiting.status).toBe(202);
    gate.resume("test");
    await until(() => app.taskRuntime.get(task.id)?.status === "completed");
    const result = await fetch(`${base}/tasks/${task.id}/result`, { headers });
    expect(await result.json()).toEqual({ route: "local", output: "Synthetic complete reasoning" });
    expect(calls).toBe(2);
    expect(await (await submit()).json()).toEqual({
      route: "local",
      output: "Synthetic complete reasoning",
    });
    expect(calls).toBe(2);
  });

  it("isolates anonymous cookies and header credentials without granting member or inference access", async () => {
    const gate = createInferenceGate({
      db: openInferenceTestDb(),
      env: {},
      config: inferenceTestConfig(),
    });
    gate.pause("test");
    const app = createAdminBotMockService({
      inferenceGate: gate,
      serviceToken: "synthetic-test-token",
      reimbursementWorkflow: {
        converse: async () => ({
          assistant_message: "synthetic",
          draft: {},
          missing_fields: [],
          ready: false,
        }),
        generate: async () => ({ artifacts: [] }),
      } as never,
      calendarInviteRunner: async () => {},
      accountApprovedEmailRunner: async () => {},
      dcsFormRunner: async () => {},
    });
    gate.setShutdownGraceMs(0, "test");
    cleanups.push(() => app.close());
    const base = await serve(app.server);
    const shared = app.taskRuntime.submit({
      kind: "workshop.match",
      owner: "system:workshop-match",
      input: {},
    });
    const serviceHeaders = { Authorization: "Bearer synthetic-test-token" };
    expect((await fetch(`${base}/tasks/${shared.id}`, { headers: serviceHeaders })).status).toBe(
      200,
    );
    expect(
      (
        await fetch(`${base}/tasks/${shared.id}/cancel`, {
          method: "POST",
          headers: serviceHeaders,
        })
      ).status,
    ).toBe(200);
    const initialTaskCount = app.taskRuntime.metrics().total;
    const bootstrap = await fetch(`${base}/tasks/visitor`, { method: "POST" });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get("cache-control")).toBe("no-store");
    const establishedVisitor = bootstrap.headers.get("x-adminbot-visitor")!;
    const establishedCookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
    expect(app.taskRuntime.metrics().total).toBe(initialTaskCount);
    for (const credential of [
      { Cookie: establishedCookie },
      { "X-AdminBot-Visitor": establishedVisitor },
    ]) {
      const again = await fetch(`${base}/tasks/visitor`, { method: "POST", headers: credential });
      expect(again.headers.get("x-adminbot-visitor")).toBe(establishedVisitor);
      expect(app.taskRuntime.metrics().total).toBe(initialTaskCount);
    }
    const lostResponseSubmission = () =>
      fetch(`${base}/reimbursements/converse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AdminBot-Visitor": establishedVisitor,
          "Idempotency-Key": "synthetic-first-turn",
        },
        body: JSON.stringify({ message: "Synthetic lost response", draft: {} }),
      });
    // Discard every response header/body: the credential was saved before this task existed.
    await (await lostResponseSubmission()).arrayBuffer();
    const retryAfterLoss = await lostResponseSubmission();
    expect(retryAfterLoss.status).toBe(409);
    expect(app.taskRuntime.metrics().total).toBe(initialTaskCount + 1);
    const restored = (await retryAfterLoss.json()) as { task: { id: string } };
    expect(app.taskRuntime.get(restored.task.id)?.owner).toMatch(/^visitor:/);
    const post = () =>
      fetch(`${base}/reimbursements/converse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [], draft: {} }),
      });
    const first = await post();
    const second = await post();
    const cookie = first.headers.get("set-cookie")!;
    const visitor = first.headers.get("x-adminbot-visitor")!;
    const otherVisitor = second.headers.get("x-adminbot-visitor")!;
    expect(cookie).toContain("HttpOnly; SameSite=Strict");
    expect(visitor).not.toBe(otherVisitor);
    const { task } = (await first.json()) as { task: { id: string } };
    const headers = { "X-AdminBot-Visitor": visitor };
    expect((await fetch(`${base}/tasks/${task.id}`, { headers })).status).toBe(200);
    expect(
      (await fetch(`${base}/tasks/${task.id}`, { headers: { Cookie: cookie.split(";")[0] } }))
        .status,
    ).toBe(200);
    expect(
      (await fetch(`${base}/tasks/${task.id}`, { headers: { "X-AdminBot-Visitor": otherVisitor } }))
        .status,
    ).toBe(404);
    for (const action of ["wait", "retry", "cancel"]) {
      expect(
        (
          await fetch(`${base}/tasks/${task.id}/${action}`, {
            method: "POST",
            headers: { "X-AdminBot-Visitor": otherVisitor },
          })
        ).status,
      ).toBe(404);
    }
    expect(
      (
        await fetch(`${base}/tasks/${task.id}`, {
          headers: { ...headers, Authorization: "Bearer synthetic-test-token" },
        })
      ).status,
    ).toBe(404);
    for (const route of ["/lab/members", "/inference/requests", "/settings"]) {
      expect((await fetch(`${base}${route}`, { headers })).status).toBe(401);
    }
    expect(
      (await fetch(`${base}/privacy/tasks`, { method: "POST", headers, body: "{}" })).status,
    ).toBe(401);
    await fetch(`${base}/tasks/${task.id}/wait`, { method: "POST", headers });
    gate.resume("test");
    await until(() => app.taskRuntime.get(task.id)?.status === "completed");
    expect(await (await fetch(`${base}/tasks/${task.id}/result`, { headers })).json()).toEqual({
      assistant_message: "synthetic",
      draft: {},
      missing_fields: [],
      ready: false,
    });
  });

  it("never publishes a successful task result from invalid model output", async () => {
    const fetchImpl: InferenceFetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ choices: [{ message: { content: "" } }] }),
    });
    const gate = createInferenceGate({
      db: openInferenceTestDb(),
      env: {},
      config: inferenceTestConfig(),
      fetchImpl,
    });
    const app = createAdminBotMockService({
      serviceToken: "synthetic-test-token",
      inferenceGate: gate,
      privacyBroker: createAdminBotPrivacyBroker(undefined, { gate, fetchImpl, env: {} }),
      calendarInviteRunner: async () => {},
      accountApprovedEmailRunner: async () => {},
      dcsFormRunner: async () => {},
    });
    gate.setShutdownGraceMs(0, "test");
    cleanups.push(() => app.close());
    const base = await serve(app.server);
    const headers = {
      Authorization: "Bearer synthetic-test-token",
      "Content-Type": "application/json",
    };
    const response = await fetch(`${base}/privacy/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task: "Synthetic invalid output test", privacy: "private" }),
    });
    expect(response.status).toBe(502);
    const { task } = (await response.json()) as { task: { id: string; status: string } };
    expect(task.status).toBe("failed");
    expect((await fetch(`${base}/tasks/${task.id}/result`, { headers })).status).toBe(502);
    expect(app.taskRuntime.get(task.id)?.result).toBeUndefined();
  });

  it("stores only visitor token hashes and expires the credential", async () => {
    let now = 1;
    const db = openInferenceTestDb();
    const visitors = new VisitorSessions(db, false, () => now);
    const runtime = new TaskRuntime({ db });
    runtime.register("reimbursement", 1, () => ({ ready: true }));
    runtime.start();
    const server = createServer(async (req, res) => {
      if (req.url === "/new") {
        await submitHttpTask(req, res, runtime, visitors.ensure(req, res), "reimbursement", {});
        return;
      }
      const owner = visitors.resolve(req);
      if (!owner) {
        res.writeHead(401).end();
        return;
      }
      await handleTaskRoute(
        req,
        res,
        new URL(req.url!, "http://local"),
        runtime,
        owner,
        () => true,
      );
    });
    cleanups.push(async () => {
      await runtime.shutdown({ graceMs: 0 });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    });
    const base = await serve(server);
    const res = await fetch(`${base}/new`);
    const token = res.headers.get("x-adminbot-visitor")!;
    const rows = db.prepare("SELECT * FROM adminbot_task_visitors").all();
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(
      (await fetch(`${base}/tasks`, { headers: { "X-AdminBot-Visitor": token } })).status,
    ).toBe(200);
    now += 86_400_001;
    expect(
      (await fetch(`${base}/tasks`, { headers: { "X-AdminBot-Visitor": token } })).status,
    ).toBe(401);
  });
});

it("serves expired guidebook status after private input has been erased", async () => {
  const app = createAdminBotMockService({
    serviceToken: "synthetic-test-token",
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
  });
  cleanups.push(() => app.close());
  const base = await serve(app.server);
  const now = Date.now();
  app.taskRuntime.store.save({
    id: "expired-guide",
    owner: "service",
    kind: "member-guidebook",
    version: 1,
    input: null,
    status: "expired",
    createdAt: now - 1000,
    updatedAt: now,
    expiresAt: now + 60_000,
  });
  const headers = { Authorization: "Bearer synthetic-test-token" };
  expect((await fetch(`${base}/tasks/expired-guide`, { headers })).status).toBe(200);
  expect((await fetch(`${base}/tasks/expired-guide/result`, { headers })).status).toBe(410);
});

it("allows credentialed visitor bootstrap only from approved UI origins", async () => {
  const app = createAdminBotMockService({
    allowedOrigins: ["https://example.invalid"],
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
  });
  cleanups.push(() => app.close());
  const base = await serve(app.server);
  const allowed = await fetch(`${base}/tasks/visitor`, {
    method: "POST",
    headers: { Origin: "https://example.invalid" },
  });
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get("access-control-allow-origin")).toBe("https://example.invalid");
  expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
  expect(allowed.headers.get("access-control-expose-headers")).toContain("X-AdminBot-Visitor");
  expect(allowed.headers.get("x-adminbot-visitor")).toBeTruthy();
  const denied = await fetch(`${base}/tasks/visitor`, {
    method: "POST",
    headers: { Origin: "https://untrusted.invalid" },
  });
  expect(denied.status).toBe(403);
  expect(denied.headers.get("access-control-allow-credentials")).toBeNull();
  expect(denied.headers.get("x-adminbot-visitor")).toBeNull();
  expect(app.taskRuntime.metrics().total).toBe(0);
});

it("counts a visitor's Wait and retry against the anonymous rate limit", async () => {
  // The task routes are resolved before the anonymous allowlist and its limiter, so without an
  // explicit check a visitor could bootstrap once, submit one turn, and then retry that row
  // without limit -- unbounded inference against a GPU the whole lab shares, from an endpoint
  // whose only abuse control is that limiter.
  const app = createAdminBotMockService({
    serviceToken: "synthetic-test-token",
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
  });
  cleanups.push(() => app.close());
  const base = await serve(app.server);
  const bootstrap = await fetch(`${base}/tasks/visitor`, { method: "POST" });
  const visitor = { "X-AdminBot-Visitor": bootstrap.headers.get("x-adminbot-visitor")! };

  // 60 per hour per address, one of which the bootstrap above already spent.
  let refusedAt = 0;
  for (let attempt = 1; attempt <= 61 && !refusedAt; attempt += 1) {
    const response = await fetch(`${base}/tasks/synthetic-missing-id/wait`, {
      method: "POST",
      headers: visitor,
    });
    if (response.status === 429) {
      refusedAt = attempt;
    }
  }
  expect(refusedAt).toBeGreaterThan(0);

  // Reads stay open: they spend no model time, and the UI polls status while a task runs.
  expect((await fetch(`${base}/tasks`, { headers: visitor })).status).toBe(200);

  // A member is authenticated, so the anonymous budget is not theirs to exhaust.
  const member = { Authorization: "Bearer synthetic-test-token" };
  expect(
    (await fetch(`${base}/tasks/synthetic-missing-id/retry`, { method: "POST", headers: member }))
      .status,
  ).toBe(404);
});

it("rejects an expired visitor credential before creating a replacement owner or task", async () => {
  const app = createAdminBotMockService({
    reimbursementWorkflow: {
      converse: async () => ({
        assistant_message: "synthetic",
        draft: {},
        missing_fields: [],
        ready: false,
      }),
      generate: async () => ({ artifacts: [] }),
    } as never,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
  });
  cleanups.push(() => app.close());
  const base = await serve(app.server);
  const bootstrap = await fetch(`${base}/tasks/visitor`, { method: "POST" });
  const token = bootstrap.headers.get("x-adminbot-visitor")!;
  // The fixture owns this database; expiring the row simulates the 24-hour boundary.
  app.taskRuntime.store.db.exec("UPDATE adminbot_task_visitors SET expires_at = 0");
  const before = app.taskRuntime.metrics().total;
  for (const credential of [
    { "X-AdminBot-Visitor": token },
    { Cookie: `adminbot_visitor=${token}` },
  ]) {
    const response = await fetch(`${base}/reimbursements/converse`, {
      method: "POST",
      headers: {
        ...credential,
        "Content-Type": "application/json",
        "Idempotency-Key": "lost-response",
      },
      body: JSON.stringify({ message: "Synthetic lost response", draft: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("x-adminbot-visitor")).toBeNull();
  }
  expect(app.taskRuntime.metrics().total).toBe(before);
});

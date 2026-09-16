/** Disposable loopback demonstration using the real task API, runner, broker, gate and SQLite. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAdminBotMockService } from "../extensions/adminbot/src/api/server.js";
import { resolveInferenceGateConfig } from "../extensions/adminbot/src/inference/config.js";
import { createInferenceGate } from "../extensions/adminbot/src/inference/gate.js";
import { AdminBotSqliteStore } from "../extensions/adminbot/src/persistence/sqlite.js";
import { createAdminBotPrivacyBroker } from "../extensions/adminbot/src/privacy/broker.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No loopback listener address");
  }
  return `http://127.0.0.1:${address.port}`;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert(Date.now() < deadline, message);
    await sleep(25);
  }
}
const smoke = process.argv.includes("--smoke");
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node --import tsx scripts/adminbot-task4-demo.ts [--smoke] [--output FILE]\nManual mode prints curl commands. --smoke asserts the full task flow and writes .artifacts/task4-shared-runner-smoke.json. All data and transports are synthetic loopback mocks.",
  );
  process.exit(0);
}
const directory = await mkdtemp(path.join(tmpdir(), "adminbot-task4-demo-"));
const token = `demo-${randomUUID()}`;
let holding = true;
let active = 0;
let peak = 0;
const calls: Array<{ stage: "classify" | "local"; task: string }> = [];
const held = new Set<() => void>();
const model = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const reply = (body: unknown) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.statusCode = 401;
    reply({ error: "Use the printed demo token" });
    return;
  }
  if (req.method === "GET" && pathname === "/demo/status") {
    reply({ holding, held: held.size, calls: calls.length, active, peak });
    return;
  }
  if (req.method === "POST" && pathname === "/demo/hold") {
    holding = true;
    reply({ holding });
    return;
  }
  if (req.method === "POST" && pathname === "/demo/release") {
    holding = false;
    for (const release of [...held]) {
      release();
    }
    reply({ holding, held: held.size });
    return;
  }
  if (req.method !== "POST" || pathname !== "/v1/chat/completions") {
    res.statusCode = 404;
    reply({ error: "Demo model route not found" });
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    messages: Array<{ role: string; content: string }>;
  };
  const classify = body.messages[0]?.content.includes("Return JSON only with classification");
  const prompt = body.messages.find((message) => message.role === "user")?.content ?? "";
  const task = classify ? (JSON.parse(prompt) as { task: string }).task : prompt;
  calls.push({ stage: classify ? "classify" : "local", task });
  active++;
  peak = Math.max(peak, active);
  const release = () => {
    held.delete(release);
    if (!res.destroyed) {
      reply({
        choices: [
          {
            message: {
              content: classify
                ? JSON.stringify({
                    classification: "uncertain",
                    sanitized_task: "",
                    replacements: [],
                  })
                : `Completed synthetic result: ${task}`,
            },
          },
        ],
      });
    }
  };
  res.once("close", () => {
    active--;
    held.delete(release);
  });
  if (holding) {
    held.add(release);
  } else {
    setTimeout(release, 10);
  }
});
const modelUrl = await listen(model);
const mockFetch = (input: string | URL, init?: RequestInit) => {
  const url = new URL(input);
  if (url.origin !== modelUrl || url.pathname !== "/v1/chat/completions") {
    throw new Error("Demo refuses a model destination outside its loopback mock");
  }
  return fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
};
const databasePath = path.join(directory, "demo.sqlite");
const ledger = new AdminBotSqliteStore(databasePath);
const gate = createInferenceGate({
  db: ledger.inferenceDatabase(),
  env: {},
  fetchImpl: mockFetch,
  config: resolveInferenceGateConfig({
    ADMINBOT_INFERENCE_CAPACITY: "1",
    ADMINBOT_INFERENCE_DEFAULT_TIMEOUT_MS: "360000",
    ADMINBOT_INFERENCE_SHUTDOWN_GRACE_MS: "360000",
    ADMINBOT_INFERENCE_QUEUE_SWEEP_INTERVAL_MS: "1000",
    ADMINBOT_INFERENCE_HEALTH_INTERVAL_MS: "0",
  }),
});
const privacyBroker = createAdminBotPrivacyBroker(
  {
    localBaseUrl: `${modelUrl}/v1`,
    localModel: "synthetic-demo-model",
    localApiKeyEnv: "DEMO_MODEL_KEY",
    remoteBaseUrl: `${modelUrl}/v1`,
    remoteModel: "synthetic-demo-model",
    remoteApiKeyEnv: "DEMO_REMOTE_KEY",
  },
  { gate, env: { DEMO_MODEL_KEY: token }, fetchImpl: mockFetch },
);
const service = createAdminBotMockService({
  databasePath,
  serviceToken: token,
  gatewayToken: "",
  gatewayUrl: "",
  ipinfoToken: "",
  sensitiveInfoPath: path.join(directory, "synthetic-sensitive-info.md"),
  inferenceGate: gate,
  privacyBroker,
  executor: { execute: async () => ({ handled: false }) },
  calendarInviteRunner: async () => {},
  accountApprovedEmailRunner: async () => {},
  passwordResetEmailRunner: async () => {},
  dcsFormRunner: async () => {},
});
const handlers = service.server.listeners("request");
service.server.removeAllListeners("request");
service.server.on("request", (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (
    !(
      pathname.startsWith("/inference/") ||
      pathname === "/tasks" ||
      pathname.startsWith("/tasks/") ||
      pathname === "/privacy/tasks" ||
      pathname === "/audit" ||
      pathname === "/health"
    )
  ) {
    res
      .writeHead(404, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "Route disabled in the isolated task demo" }));
    return;
  }
  for (const handler of handlers) {
    handler.call(service.server, req, res);
  }
});
const baseUrl = await listen(service.server);
let stopping: Promise<void> | undefined;
function stop() {
  stopping ??= (async () => {
    await service.close();
    await new Promise<void>((resolve) => {
      model.close(() => resolve());
      model.closeAllConnections();
    });
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  })();
  return stopping;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(
      "Draining tasks and inference; mock release and API grace controls remain available.",
    );
    void stop().then(
      () => console.log("Demo stopped; disposable state removed."),
      (error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  });
}

let shedAtBurst = 0;
let sharePerOwner = 0;
let immediateAtBurst = 0;
async function runSmoke() {
  type Payload = { task?: { id: string; status: string }; route?: string; output?: string };
  const request = async (
    route: string,
    method = "GET",
    body?: unknown,
    key?: string,
    wait?: boolean,
  ) => {
    const response = await fetch(route.startsWith("http:") ? route : `${baseUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
        ...(wait ? { "X-Inference-Wait": "true" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Payload };
  };
  const submit = (task: string, key: string, wait?: boolean) =>
    request("/privacy/tasks", "POST", { task, privacy: "private" }, key, wait);
  const final = async (id: string) => {
    await until(
      async () => (await request(`/tasks/${id}`)).body.task?.status === "completed",
      `Task ${id} did not finish`,
    );
    const result = await request(`/tasks/${id}/result`);
    assert.equal(result.status, 200);
    return result.body;
  };
  const a = await submit("Synthetic A", "a");
  assert.equal(a.status, 202);
  assert(a.body.task);
  const b = await submit("Synthetic B", "b");
  assert.equal(b.status, 409);
  assert.equal(b.body.task?.status, "shed");
  assert(b.body.task);
  assert.equal((await submit("Synthetic B", "b")).body.task?.id, b.body.task.id);
  assert.equal((await request(`/tasks/${b.body.task.id}/wait`, "POST")).status, 202);
  await request("/inference/pause", "POST");
  await request(`${modelUrl}/demo/release`, "POST");
  await until(() => gate.stats().in_flight === 0, "Active call did not settle while paused");
  assert(
    ["queued", "running"].includes(
      (await request(`/tasks/${b.body.task.id}`)).body.task?.status ?? "",
    ),
  );
  assert.equal(calls.length, 1, "Pause must prevent the waiting task from sending its model call");
  await request("/inference/resume", "POST");
  assert.deepEqual(await final(a.body.task.id), {
    route: "local",
    output: "Completed synthetic result: Synthetic A",
  });
  assert.deepEqual(await final(b.body.task.id), {
    route: "local",
    output: "Completed synthetic result: Synthetic B",
  });
  assert.equal(calls.length, 4);
  assert.deepEqual((await submit("Synthetic B", "b")).body, {
    route: "local",
    output: "Completed synthetic result: Synthetic B",
  });
  assert.equal(calls.length, 4);
  console.log(
    "PASS saved task -> Wait -> classification + reasoning -> exact original result; retry reused result; pause held dispatch.",
  );
  await request("/inference/pause", "POST");
  const cancelled = await submit("Synthetic cancelled", "cancelled");
  assert(cancelled.body.task);
  await request(`/tasks/${cancelled.body.task.id}/wait`, "POST");
  assert.equal(
    (await request(`/tasks/${cancelled.body.task.id}/cancel`, "POST")).body.task?.status,
    "cancelled",
  );
  assert.equal(
    (await request(`/tasks/${cancelled.body.task.id}/result`)).body.task?.status,
    "cancelled",
  );
  await request("/inference/resume", "POST");
  assert(!calls.some((call) => call.task === "Synthetic cancelled"));
  // One caller bursting past their share of the line. Everything over it is saved rather than
  // refused, so the client's job is to come back for those rows -- which is what a member does
  // by pressing Wait, and what this loop stands in for. Nothing is resubmitted: each retry
  // carries the same submission key and reaches the same row.
  const burstSize = 12;
  const share = service.taskRuntime.metrics().maxInFlightPerOwner;
  const burst = await Promise.all(
    Array.from({ length: burstSize }, (_, i) => submit(`Synthetic burst ${i}`, `burst-${i}`, true)),
  );
  // A submission that finishes inside the 150ms response window answers with its result rather
  // than a handle -- the existing immediate-success contract. Only the rest carry a row to poll.
  const ids = burst.flatMap((response) => (response.body.task ? [response.body.task.id] : []));
  immediateAtBurst = burstSize - ids.length;
  sharePerOwner = share;
  shedAtBurst = burst.filter((response) => response.body.task?.status === "shed").length;
  assert(shedAtBurst > 0, `A burst of ${burstSize} past a share of ${share} must shed`);
  await until(
    async () => {
      let outstanding = 0;
      for (const id of ids) {
        const status = (await request(`/tasks/${id}`)).body.task?.status;
        if (status === "completed") {
          continue;
        }
        outstanding += 1;
        // Wait is idempotent on a row that is already queued or running, so a client that polls
        // cannot turn one request into two.
        if (status === "shed") {
          await request(`/tasks/${id}/wait`, "POST");
        }
      }
      return outstanding === 0;
    },
    "Burst tasks did not all finish",
    60_000,
  );
  const outputs = await Promise.all(
    burst.map(async (response, i) => {
      const result = response.body.task ? await final(response.body.task.id) : response.body;
      assert.deepEqual(result, {
        route: "local",
        output: `Completed synthetic result: Synthetic burst ${i}`,
      });
      return result.output;
    }),
  );
  assert.equal(new Set(outputs).size, burstSize);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(peak, 1);
  // Two calls per task and not one more: shedding and re-Waiting a row never re-ran its work.
  assert.equal(calls.length, 4 + burstSize * 2);
  const beforeShutdown = service.taskRuntime.metrics();
  assert.equal(beforeShutdown.completed, burstSize + 2);
  assert.equal(beforeShutdown.cancelled, 1);
  assert.equal(beforeShutdown.total, burstSize + 3);
  console.log(
    `PASS ${burstSize} distinct tasks past a per-owner share of ${share}: ${shedAtBurst} saved and resumed, ${immediateAtBurst} answered inside the response window, ${burstSize * 2} model calls, peak ${peak}/1, no duplicate work; cancelled task made zero calls.`,
  );
  await request(`${modelUrl}/demo/hold`, "POST");
  const interrupted = await submit("Synthetic shutdown", "shutdown");
  assert(interrupted.body.task);
  await until(() => gate.stats().in_flight === 1, "Shutdown call did not start");
  const startedAt = Date.now();
  const closing = service.close();
  await until(() => gate.settings().shutting_down, "Shutdown did not start");
  assert.equal(
    (await request("/inference/settings", "PUT", { shutdown_grace_ms: 100 })).status,
    200,
  );
  await closing;
  const shutdownMs = Date.now() - startedAt;
  assert(shutdownMs < 3_000, `Live grace edit was not honored: ${shutdownMs}ms`);
  const finalCalls = calls.length;
  await sleep(50);
  assert.equal(calls.length, finalCalls);
  assert.equal(calls.filter((call) => call.task === "Synthetic shutdown").length, 1);
  const report = {
    generated_at: new Date().toISOString(),
    mode: "synthetic-loopback-real-http-api",
    persistence: "transient; durable recovery covered separately",
    checks: {
      full_task_result: true,
      duplicate_submission_reused_result: true,
      pause_blocks_dispatch: true,
      selected_task_cancellation: true,
      burst_distinct_results: burstSize,
      burst_shed_then_resumed: shedAtBurst,
      burst_answered_immediately: immediateAtBurst,
      task_share_per_owner: sharePerOwner,
      model_capacity: 1,
      observed_model_peak: peak,
      live_shutdown_grace_ms: 100,
      observed_shutdown_ms: shutdownMs,
      no_post_shutdown_model_calls: true,
    },
    reconciliation_before_shutdown: beforeShutdown,
    model_calls: calls.length,
    stages: calls,
  };
  const outputIndex = process.argv.indexOf("--output");
  const output = path.resolve(
    outputIndex >= 0
      ? (process.argv[outputIndex + 1] ?? ".artifacts/task4-shared-runner-smoke.json")
      : ".artifacts/task4-shared-runner-smoke.json",
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `PASS live shutdown grace edited to 100ms while control API remained live (${shutdownMs}ms). Artifact: ${output}`,
  );
}

if (smoke) {
  try {
    await runSmoke();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    gate.setShutdownGraceMs(0, "demo-cleanup");
  } finally {
    await stop();
  }
} else {
  console.log(`Shared task runner isolated demo. Synthetic data only. SQLite: ${databasePath}
Copy these exports into another terminal:
export DEMO='${baseUrl}'
export MODEL='${modelUrl}'
export TOKEN='${token}'

The model starts held. Original requests return task handles; use /tasks/:id/wait
and /tasks/:id/result for the completed application response.
curl -sS -X POST -H "Authorization: Bearer $TOKEN" "$MODEL/demo/release"

Full walkthrough: ../../review-walkthrough/local-demo.md
Ctrl-C drains admitted calls; the API grace controls stay live for up to six minutes.
Use --smoke for the automated HTTP walkthrough and reproducible JSON artifact.
`);
}

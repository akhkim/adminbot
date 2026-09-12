#!/usr/bin/env node
// Load simulation for the inference gate (extensions/adminbot/src/inference/gate.ts).
//
//   node --import tsx scripts/adminbot-load-sim.ts [--scenario all|burst|refuse|hang|restart|retry|matcher]
//                                                  [--requests 50] [--latency-ms 400] [--port 8100]
//
// The pass condition it exists to test, from the task sheet: "Burst traffic does not lose or
// silently duplicate requests, and users receive a clear status." Each scenario stands the mock
// vLLM (scripts/adminbot-mock-local-model.mjs) at --concurrency 2, fires traffic through a real
// durable gate on a real fixture database, and then reconciles from three directions at once:
//
//   1. What the client submitted: every logical request, by submission key.
//   2. What the database says happened: one row per key, exactly one terminal audit event per row,
//      no id completed twice, and a retrievable user-visible outcome (status + result) for each.
//   3. What the server saw: peak_arrivals <= capacity (the client's own in-flight count as observed
//      from the other end of the socket -- see TASK4-SETUP.md for why peak_served proves nothing),
//      and zero duplicate request fingerprints.
//
// A scenario passes only if all three agree. "One terminal event per id" alone would pass a run in
// which the same logical request was sent twice under two ids; reconciling by submission key and
// by server fingerprint is what closes that gap.
//
// The kill-and-restart scenario runs the gate in a child process and SIGKILLs it mid-queue, because
// durability that has only been tested by dropping an object in the same process has not been
// tested. No production data is touched: the fixture generator writes the database this reads.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInferenceGateConfig } from "../extensions/adminbot/src/inference/config.ts";
import {
  createInferenceGate,
  type InferenceGate,
  type InferenceOutcome,
} from "../extensions/adminbot/src/inference/gate.ts";
import { AdminBotSqliteStore } from "../extensions/adminbot/src/persistence/sqlite.ts";
import { createAdminBotPrivacyBroker } from "../extensions/adminbot/src/privacy/broker.ts";
import { DEADLINE_VENUES } from "../extensions/adminbot/src/workflows/deadlines/generated/dataset.ts";
import { createLocalWorkshopMatcher } from "../extensions/adminbot/src/workflows/papers/workshop-match-llm.ts";
import {
  workshopNudgeInputsFromAdminBot,
  workshopProfilesFromDeadlines,
} from "../extensions/adminbot/src/workflows/papers/workshop-nudges.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);

type Options = {
  scenario: string;
  requests: number;
  latencyMs: number;
  port: number;
  artifactsDir: string;
  /** Internal: this process is the child half of the restart scenario. */
  childRole?: "restart-victim" | "restart-survivor";
  dbPath?: string;
};

function parseArgs(argv: string[]): Options {
  const args = argv.slice(2);
  const read = (name: string, fallback: string): string => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 && args[at + 1] !== undefined ? (args[at + 1] as string) : fallback;
  };
  const num = (name: string, fallback: number): number => {
    const value = Number(read(name, String(fallback)));
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    scenario: read("scenario", "all"),
    requests: num("requests", 50),
    latencyMs: num("latency-ms", 400),
    port: num("port", 8100),
    artifactsDir: read("artifacts", path.join(repoRoot, ".artifacts/adminbot-task4/load-sim")),
    ...(args.includes("--child-role")
      ? { childRole: read("child-role", "") as Options["childRole"] }
      : {}),
    ...(args.includes("--db") ? { dbPath: read("db", "") } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Harness: the mock server, the fixture database, and a gate on it.
// ---------------------------------------------------------------------------------------------

type MockStats = {
  counters: { arrivals: number; served: number; shed_503: number; failed: number; hung: number };
  concurrency: { peak_arrivals: number; peak_served: number };
  distinct_fingerprints: number;
  duplicate_fingerprints: Array<{ fingerprint: string; count: number }>;
};

async function startMock(port: number, extra: string[] = []): Promise<{
  proc: ChildProcess;
  baseUrl: string;
  controlUrl: string;
  stats(): Promise<MockStats>;
  control(patch: Record<string, unknown>): Promise<void>;
  stop(): Promise<void>;
}> {
  const proc = spawn(
    process.execPath,
    [
      path.join(repoRoot, "scripts/adminbot-mock-local-model.mjs"),
      "--port",
      String(port),
      "--control-port",
      String(port + 1),
      "--concurrency",
      "2",
      "--quiet",
      ...extra,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const controlUrl = `http://127.0.0.1:${port + 1}`;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${controlUrl}/__stats`);
      if (res.ok) {
        break;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error("mock server did not come up");
    }
    await sleep(50);
  }
  return {
    proc,
    baseUrl,
    controlUrl,
    stats: async () => (await (await fetch(`${controlUrl}/__stats`)).json()) as MockStats,
    control: async (patch) => {
      await fetch(`${controlUrl}/__control`, { method: "POST", body: JSON.stringify(patch) });
    },
    stop: async () => {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 2000).unref();
      });
    },
  };
}

function freshFixture(artifactsDir: string, name: string): string {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const dbPath = path.join(artifactsDir, `${name}.sqlite`);
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(repoRoot, "scripts/adminbot-fixture-db.ts"),
      dbPath,
      "--write",
      "--force",
      "--members",
      "60",
      "--papers",
      "12",
      "--proposals",
      "4",
    ],
    { cwd: repoRoot, stdio: "pipe" },
  );
  return dbPath;
}

function openGate(
  dbPath: string,
  baseUrl: string,
  overrides: Parameters<typeof resolveInferenceGateConfig>[1] = {},
): { store: AdminBotSqliteStore; gate: InferenceGate } {
  const store = new AdminBotSqliteStore(dbPath);
  const gate = createInferenceGate({
    db: store.inferenceDatabase(),
    env: { ADMINBOT_LOCAL_BASE_URL: baseUrl },
    localBaseUrl: baseUrl,
    config: resolveInferenceGateConfig(
      {},
      {
        capacity: 2,
        queue: { maxDepth: 200, sweepIntervalMs: 0, ...overrides.queue },
        health: { intervalMs: 0, ...overrides.health },
        ...(overrides.escalate ? { escalate: overrides.escalate } : {}),
        ...(overrides.defaultTimeoutMs ? { defaultTimeoutMs: overrides.defaultTimeoutMs } : {}),
      },
    ),
    alert: (line) => log(`  ${line}`),
  });
  return { store, gate };
}

function chatRequest(baseUrl: string, prompt: string) {
  return {
    route: "chat/completions" as const,
    baseUrl,
    purpose: "load-sim",
    body: {
      model: "nvidia/Qwen3.5-122B-A10B-NVFP4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 64,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------

type AuditRow = { type: string; details?: Record<string, unknown> };

function auditEvents(store: AdminBotSqliteStore): AuditRow[] {
  return store.listAuditEvents() as unknown as AuditRow[];
}

type QueueRow = {
  id: string;
  owner_id: string;
  submission_key: string;
  status: string;
  result_json: string | null;
  outcome: string | null;
};

function queueRows(store: AdminBotSqliteStore): QueueRow[] {
  return store
    .inferenceDatabase()
    .prepare(
      "SELECT id, owner_id, submission_key, status, result_json, outcome FROM adminbot_inference_queue",
    )
    .all() as QueueRow[];
}

const TERMINAL = new Set(["inference.completed", "inference.failed", "inference.expired"]);

type Check = { name: string; ok: boolean; detail: string };

/**
 * The three-way reconciliation. `submitted` is the set of logical requests the client made, by
 * submission key; `expectRows` is whether every one of them should have a row (false for the
 * refused-connection scenario, where they do -- they fail -- but is left true everywhere).
 */
function reconcile(params: {
  store: AdminBotSqliteStore;
  submitted: Map<string, InferenceOutcome[]>;
  mock?: MockStats;
  capacity: number;
  expectedTerminal?: (row: QueueRow) => string | undefined;
}): Check[] {
  const checks: Check[] = [];
  const rows = queueRows(params.store);
  const events = auditEvents(params.store).filter((e) => e.type.startsWith("inference."));
  const byKey = new Map<string, QueueRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.submission_key) ?? [];
    list.push(row);
    byKey.set(row.submission_key, list);
  }

  // 1. Every logical request has exactly one row.
  const missing = [...params.submitted.keys()].filter((k) => !byKey.has(k));
  const duplicatedKeys = [...byKey.entries()].filter(([, list]) => list.length > 1);
  checks.push({
    name: "one row per submitted logical request",
    ok: missing.length === 0 && duplicatedKeys.length === 0,
    detail: `${params.submitted.size} submitted, ${rows.length} rows, ${missing.length} missing, ${duplicatedKeys.length} keys with >1 row`,
  });

  // 2. Every row that reached a terminal state has exactly one terminal event; no id completed twice.
  const terminalById = new Map<string, string[]>();
  for (const event of events) {
    if (!TERMINAL.has(event.type)) {
      continue;
    }
    const id = String(event.details?.request_id ?? "");
    terminalById.set(id, [...(terminalById.get(id) ?? []), event.type]);
  }
  const terminalRows = rows.filter((r) => ["completed", "failed", "expired"].includes(r.status));
  const rowsWithoutTerminal = terminalRows.filter((r) => (terminalById.get(r.id) ?? []).length === 0);
  const rowsWithMany = rows.filter((r) => (terminalById.get(r.id) ?? []).length > 1);
  const completedTwice = [...terminalById.values()].filter(
    (types) => types.filter((t) => t === "inference.completed").length > 1,
  );
  checks.push({
    name: "exactly one terminal event per finished row",
    ok: rowsWithoutTerminal.length === 0 && rowsWithMany.length === 0 && completedTwice.length === 0,
    detail: `${terminalRows.length} finished rows, ${rowsWithoutTerminal.length} without a terminal event, ${rowsWithMany.length} with several, ${completedTwice.length} completed twice`,
  });

  // 3. The status/result table agrees with the audit trail on what each row is.
  const statusMismatch = rows.filter((r) => {
    const types = terminalById.get(r.id) ?? [];
    if (r.status === "completed") return types[0] !== "inference.completed" || !r.result_json;
    if (r.status === "failed") return types[0] !== "inference.failed";
    if (r.status === "expired") return types[0] !== "inference.expired";
    return false;
  });
  checks.push({
    name: "row status agrees with its terminal event and result",
    ok: statusMismatch.length === 0,
    detail: `${statusMismatch.length} rows disagree with their audit event`,
  });

  // 4. Every user-visible outcome the client received matches the row it names.
  let outcomeMismatch = 0;
  for (const [key, outcomes] of params.submitted) {
    const row = byKey.get(key)?.[0];
    for (const outcome of outcomes) {
      if (!row || !("id" in outcome) || outcome.id !== row.id) {
        outcomeMismatch += 1;
      }
    }
  }
  checks.push({
    name: "every outcome handed to a client names that client's row",
    ok: outcomeMismatch === 0,
    detail: `${outcomeMismatch} outcomes named a different row`,
  });

  if (params.expectedTerminal) {
    const wrong = rows.filter((r) => {
      const want = params.expectedTerminal?.(r);
      return want !== undefined && r.status !== want;
    });
    checks.push({
      name: "rows ended in the state the scenario predicts",
      ok: wrong.length === 0,
      detail: `${wrong.length} rows in an unexpected state: ${wrong
        .slice(0, 3)
        .map((r) => `${r.submission_key}=${r.status}/${r.outcome}`)
        .join(", ")}`,
    });
  }

  // 5. The server's view.
  if (params.mock) {
    checks.push({
      name: `mock peak_arrivals <= ${params.capacity}`,
      ok: params.mock.concurrency.peak_arrivals <= params.capacity,
      detail: `peak_arrivals=${params.mock.concurrency.peak_arrivals} peak_served=${params.mock.concurrency.peak_served} arrivals=${params.mock.counters.arrivals}`,
    });
    checks.push({
      name: "mock saw no duplicate request bodies",
      ok: params.mock.duplicate_fingerprints.length === 0,
      detail: `${params.mock.distinct_fingerprints} distinct fingerprints, ${params.mock.duplicate_fingerprints.length} duplicated`,
    });
    const completed = rows.filter((r) => r.status === "completed").length;
    checks.push({
      name: "completed rows == requests the server answered",
      ok: completed === params.mock.counters.served,
      detail: `completed=${completed} served=${params.mock.counters.served}`,
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

type ScenarioResult = { name: string; checks: Check[]; notes: string[] };

async function scenarioBurst(o: Options): Promise<ScenarioResult> {
  const mock = await startMock(o.port, ["--latency-ms", String(o.latencyMs)]);
  const dbPath = freshFixture(o.artifactsDir, "burst");
  const { store, gate } = openGate(dbPath, mock.baseUrl);
  gate.start();
  const submitted = new Map<string, InferenceOutcome[]>();
  const t0 = Date.now();
  try {
    // Half the members wait, half take the default (shed). All fire in the same tick.
    const runs = Array.from({ length: o.requests }, (_, i) => {
      const key = `burst-${i}`;
      const wait = i % 2 === 0;
      return gate
        .run({
          owner: `member-${i}`,
          caller: "load_sim.burst",
          submissionKey: key,
          wait,
          request: chatRequest(mock.baseUrl, `burst prompt ${i}`),
          timeoutMs: 30_000,
        })
        .then((outcome) => {
          submitted.set(key, [...(submitted.get(key) ?? []), outcome]);
          return outcome;
        });
    });
    const outcomes = await Promise.all(runs);
    const kinds = outcomes.reduce<Record<string, number>>((acc, x) => {
      const label = x.kind === "failed" ? `failed:${x.failure}:${x.error.slice(0, 80)}` : x.kind;
      acc[label] = (acc[label] ?? 0) + 1;
      return acc;
    }, {});
    log(`  arrival outcomes: ${JSON.stringify(kinds)}`);
    const shed = outcomes.filter((x) => x.kind === "shed");
    // Every shed member now clicks "wait" -- twice, concurrently, to prove the second click is a
    // no-op -- and the stored bodies run without a re-send.
    for (const outcome of shed) {
      if (outcome.kind !== "shed") continue;
      const owner = queueRows(store).find((r) => r.id === outcome.id)?.owner_id as string;
      // Queued if the slots are still busy, running if the burst has already drained -- either
      // way the second click changes nothing and reports the same state.
      const [a, b] = [gate.wait(owner, outcome.id), gate.wait(owner, outcome.id)];
      const moved = new Set(["queued", "running", "completed"]);
      if (!moved.has(a?.state ?? "") || !moved.has(b?.state ?? "") || a?.state === "shed") {
        throw new Error(`wait click did not move the row: ${a?.state} / ${b?.state}`);
      }
    }
    await untilIdle(gate);
    const elapsed = Date.now() - t0;
    const stats = await mock.stats();
    const checks = reconcile({ store, submitted, mock: stats, capacity: 2 });
    checks.push({
      name: "every request ended completed",
      ok: queueRows(store).every((r) => r.status === "completed"),
      detail: JSON.stringify(gate.stats().rows),
    });
    checks.push({
      name: "no timeout fired while waiting in line",
      ok: auditEvents(store).every((e) => e.details?.outcome !== "timeout"),
      detail: `wall ${elapsed}ms for ${o.requests} requests at ${o.latencyMs}ms each over 2 slots (ideal ${Math.ceil(o.requests / 2) * o.latencyMs}ms); timeout per call 30000ms`,
    });
    return {
      name: `burst: ${o.requests} simultaneous arrivals, half wait, half shed then wait`,
      checks,
      notes: [
        `shed=${shed.length} queued-at-arrival=${outcomes.filter((x) => x.kind === "completed").length - 2}`,
        `mock: ${JSON.stringify(stats.concurrency)} ${JSON.stringify(stats.counters)}`,
        `gate: ${JSON.stringify(gate.stats().rows)}`,
      ],
    };
  } finally {
    // Never close the database under a call that is still running: a completion that cannot be
    // recorded would look, in the report, exactly like a lost request.
    await untilIdle(gate, 30_000).catch(() => undefined);
    gate.close();
    store.close();
    await mock.stop();
  }
}

async function scenarioRetry(o: Options): Promise<ScenarioResult> {
  // Lost response + retry with the same key; same key + different payload; concurrent submissions
  // of the same key.
  const mock = await startMock(o.port, ["--latency-ms", String(o.latencyMs)]);
  const dbPath = freshFixture(o.artifactsDir, "retry");
  const { store, gate } = openGate(dbPath, mock.baseUrl);
  gate.start();
  const submitted = new Map<string, InferenceOutcome[]>();
  const record = (key: string) => (outcome: InferenceOutcome) => {
    submitted.set(key, [...(submitted.get(key) ?? []), outcome]);
    return outcome;
  };
  try {
    const req = (i: number) => chatRequest(mock.baseUrl, `retry prompt ${i}`);
    // 20 logical requests, each submitted three times at once under its key (a client hammering
    // "send" with a lost response), while two hold the slots.
    const runs: Promise<InferenceOutcome>[] = [];
    for (let i = 0; i < 20; i += 1) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        runs.push(
          gate
            .run({ owner: "ada", caller: "load_sim.retry", submissionKey: `k${i}`, wait: true, request: req(i) })
            .then(record(`k${i}`)),
        );
      }
    }
    // And one key whose second submission changes the payload.
    runs.push(
      gate
        .run({ owner: "ada", caller: "load_sim.retry", submissionKey: "k0", wait: true, request: req(999) })
        .then(record("k0")),
    );
    const outcomes = await Promise.all(runs);
    await untilIdle(gate);
    const stats = await mock.stats();
    const checks = reconcile({
      store,
      submitted: new Map([...submitted].filter(([k]) => k !== "k0" || true)),
      mock: stats,
      capacity: 2,
    });
    checks.push({
      name: "the server ran each logical request exactly once (20 of 61 submissions)",
      ok: stats.counters.served === 20 && stats.distinct_fingerprints === 20,
      detail: `served=${stats.counters.served} distinct=${stats.distinct_fingerprints}`,
    });
    const conflicts = outcomes.filter((x) => x.kind === "conflict");
    checks.push({
      name: "same key + different payload is reported as a conflict, not run",
      ok: conflicts.length === 1,
      detail: `${conflicts.length} conflict outcomes`,
    });
    // After completion a replay with the same key returns the stored result with no server call.
    const replay = await gate.run({ owner: "ada", caller: "load_sim.retry", submissionKey: "k5", request: req(5) });
    const after = await mock.stats();
    checks.push({
      name: "replay after completion returns the stored result without a model call",
      ok: replay.kind === "completed" && after.counters.arrivals === stats.counters.arrivals,
      detail: `replay=${replay.kind} arrivals before/after=${stats.counters.arrivals}/${after.counters.arrivals}`,
    });
    // Ownership: somebody else with the same key gets their own row, and cannot read Ada's.
    const other = await gate.run({ owner: "bob", caller: "load_sim.retry", submissionKey: "k5", wait: true, request: req(5) });
    await untilIdle(gate);
    checks.push({
      name: "another owner's identical key is their own request; Ada's row is invisible to them",
      ok: other.kind === "completed" && gate.status("bob", replay.kind === "completed" ? replay.id : "") === undefined,
      detail: `bob=${other.kind}`,
    });
    return { name: "retry: lost responses, concurrent duplicate submissions, payload conflict", checks, notes: [] };
  } finally {
    // Never close the database under a call that is still running: a completion that cannot be
    // recorded would look, in the report, exactly like a lost request.
    await untilIdle(gate, 30_000).catch(() => undefined);
    gate.close();
    store.close();
    await mock.stop();
  }
}

async function scenarioRefuse(o: Options): Promise<ScenarioResult> {
  const mock = await startMock(o.port, ["--fail-mode", "refuse"]);
  const dbPath = freshFixture(o.artifactsDir, "refuse");
  const { store, gate } = openGate(dbPath, mock.baseUrl, {
    health: { failureThreshold: 2 },
    escalate: { healthFailures: 2 },
  });
  gate.start();
  const submitted = new Map<string, InferenceOutcome[]>();
  try {
    const runs = Array.from({ length: 10 }, (_, i) =>
      gate
        .run({ owner: `m${i}`, caller: "load_sim.refuse", submissionKey: `r${i}`, wait: true, request: chatRequest(mock.baseUrl, `p${i}`) })
        .then((x) => (submitted.set(`r${i}`, [x]), x)),
    );
    const outcomes = await Promise.all(runs);
    await gate.probeHealth();
    await gate.probeHealth();
    const checks = reconcile({
      store,
      submitted,
      capacity: 2,
      expectedTerminal: () => "failed",
    });
    checks.push({
      name: "every request failed fast with a transport error, none hung, none silently lost",
      ok: outcomes.every((x) => x.kind === "failed" && x.failure === "error"),
      detail: outcomes.map((x) => (x.kind === "failed" ? x.failure : x.kind)).join(","),
    });
    const health = gate.stats().health;
    checks.push({
      name: "health probe marks the server down after the threshold and arms the health escalation",
      ok: health.state === "down" && gate.stats().escalations_armed.includes("health"),
      detail: `${JSON.stringify(health)} armed=${gate.stats().escalations_armed.join(",")}`,
    });
    checks.push({
      name: "an inference.escalation_proposed event was recorded (no proposer wired in this sim)",
      ok: auditEvents(store).some((e) => e.type === "inference.escalation_proposed"),
      detail: "",
    });
    // Estimates are unavailable rather than extrapolated while down.
    const shedStatus = await gate.run({ owner: "x", caller: "load_sim.refuse", request: chatRequest(mock.baseUrl, "late") });
    checks.push({
      name: "a request arriving while the server is down is failed, not queued forever",
      ok: shedStatus.kind === "failed",
      detail: shedStatus.kind,
    });
    return { name: "refuse: model server not running (ECONNREFUSED)", checks, notes: [] };
  } finally {
    // Never close the database under a call that is still running: a completion that cannot be
    // recorded would look, in the report, exactly like a lost request.
    await untilIdle(gate, 30_000).catch(() => undefined);
    gate.close();
    store.close();
    await mock.stop();
  }
}

async function scenarioHang(o: Options): Promise<ScenarioResult> {
  const mock = await startMock(o.port, ["--fail-mode", "hang"]);
  const dbPath = freshFixture(o.artifactsDir, "hang");
  const { store, gate } = openGate(dbPath, mock.baseUrl, { defaultTimeoutMs: 800 });
  gate.start();
  const submitted = new Map<string, InferenceOutcome[]>();
  const t0 = Date.now();
  try {
    // Six requests, two slots, an 800ms timeout, and a server that never answers. Each request's
    // clock must start when it is admitted, so the third pair finishes ~2.4s in -- not all six at
    // 0.8s (clock at arrival) and not never (no timeout).
    const runs = Array.from({ length: 6 }, (_, i) =>
      gate
        .run({ owner: `m${i}`, caller: "load_sim.hang", submissionKey: `h${i}`, wait: true, request: chatRequest(mock.baseUrl, `p${i}`) })
        .then((x) => (submitted.set(`h${i}`, [x]), x)),
    );
    const outcomes = await Promise.all(runs);
    const elapsed = Date.now() - t0;
    const stats = await mock.stats();
    const checks = reconcile({ store, submitted, mock: stats, capacity: 2, expectedTerminal: () => "failed" });
    checks.push({
      name: "every request timed out (not errored, not hung)",
      ok: outcomes.every((x) => x.kind === "failed" && x.failure === "timeout"),
      detail: outcomes.map((x) => (x.kind === "failed" ? x.failure : x.kind)).join(","),
    });
    checks.push({
      name: "timeouts were serialized by admission: 3 rounds x 800ms, not one round",
      ok: elapsed >= 2_300 && elapsed < 6_000,
      detail: `wall ${elapsed}ms`,
    });
    checks.push({
      name: "health degraded from observed inference timeouts even though /v1/models still answers",
      ok: gate.stats().health.state !== "ok" && gate.stats().health.inference_timeouts === 6,
      detail: JSON.stringify(gate.stats().health),
    });
    return { name: "hang: model server accepts and never answers", checks, notes: [] };
  } finally {
    // Never close the database under a call that is still running: a completion that cannot be
    // recorded would look, in the report, exactly like a lost request.
    await untilIdle(gate, 30_000).catch(() => undefined);
    gate.close();
    store.close();
    await mock.stop();
  }
}

/**
 * Kill-and-restart, across two real processes.
 *
 * The victim opens the gate on the fixture, enqueues N always-wait requests against a slow mock,
 * and is SIGKILLed with two running and the rest queued. Some queued rows are backdated past
 * max_age before the survivor starts. The survivor opens the same file, calls start(), and must:
 * fail the two `running` rows as interrupted (naming the victim's claim), expire the backdated rows,
 * and re-admit and complete the rest -- with each outcome retrievable through status()/result().
 */
async function scenarioRestart(o: Options): Promise<ScenarioResult> {
  const mock = await startMock(o.port, ["--latency-ms", "60000"]);
  const dbPath = freshFixture(o.artifactsDir, "restart");
  const N = 12;
  const notes: string[] = [];
  try {
    const victim = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url), "--child-role", "restart-victim", "--db", dbPath, "--port", String(o.port), "--requests", String(N)],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let victimOut = "";
    victim.stdout?.on("data", (d) => (victimOut += String(d)));
    victim.stderr?.on("data", (d) => (victimOut += String(d)));
    await waitFor(() => victimOut.includes("VICTIM_READY"), 30_000, "victim never reported ready");
    const pidLine = /VICTIM_PROCESS (\S+)/u.exec(victimOut)?.[1];
    victim.kill("SIGKILL");
    await new Promise((r) => victim.once("exit", r));
    notes.push(`victim killed; gate process id ${pidLine}`);

    // Speed the mock up so the survivor's re-admitted rows finish, and backdate three queued rows
    // so they are past the survivor's max age.
    await mock.control({ latencyMs: 300 });
    const store = new AdminBotSqliteStore(dbPath);
    const before = queueRows(store);
    const runningBefore = before.filter((r) => r.status === "running").length;
    const queuedBefore = before.filter((r) => r.status === "queued");
    const stale = queuedBefore.slice(0, 3).map((r) => r.id);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    for (const id of stale) {
      store
        .inferenceDatabase()
        .prepare("UPDATE adminbot_inference_queue SET arrived_at = ?, queued_at = ?, expires_at = ? WHERE id = ?")
        .run(old, old, new Date(Date.now() - 60 * 60 * 1000).toISOString(), id);
    }
    store.close();
    notes.push(`after kill: running=${runningBefore} queued=${queuedBefore.length}; backdated ${stale.length} past max_age`);

    const survivor = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url), "--child-role", "restart-survivor", "--db", dbPath, "--port", String(o.port)],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let survivorOut = "";
    survivor.stdout?.on("data", (d) => (survivorOut += String(d)));
    survivor.stderr?.on("data", (d) => (survivorOut += String(d)));
    await new Promise((r) => survivor.once("exit", r));
    const report = /SURVIVOR_REPORT (.*)/u.exec(survivorOut)?.[1];
    if (!report) {
      throw new Error(`survivor produced no report:\n${survivorOut}`);
    }
    const parsed = JSON.parse(report) as {
      recovered: { interrupted: number; expired: number; readmitted: number };
      outcomes: Record<string, { state: string; result: boolean; outcome?: string }>;
    };
    notes.push(`survivor recovered: ${JSON.stringify(parsed.recovered)}`);

    const after = new AdminBotSqliteStore(dbPath);
    const rows = queueRows(after);
    const events = auditEvents(after);
    const interrupted = events.filter((e) => e.type === "inference.failed" && e.details?.outcome === "interrupted");
    const submitted = new Map<string, InferenceOutcome[]>();
    for (const row of rows) submitted.set(row.submission_key, []);
    const checks = reconcile({ store: after, submitted, capacity: 2 });
    checks.push({
      name: `rows found running were failed as interrupted (${runningBefore}), naming the dead claim`,
      ok:
        parsed.recovered.interrupted === runningBefore &&
        interrupted.length === runningBefore &&
        interrupted.every((e) => e.details?.claimed_by === pidLine && Boolean(e.details?.claimed_at)),
      detail: `${interrupted.length} interrupted events; claimed_by=${[...new Set(interrupted.map((e) => e.details?.claimed_by))].join(",")}`,
    });
    checks.push({
      name: "backdated rows expired with inference.expired and a resubmit status",
      ok:
        parsed.recovered.expired === stale.length &&
        stale.every((id) => rows.find((r) => r.id === id)?.status === "expired") &&
        stale.every((id) => /resubmit/iu.test(parsed.outcomes[id]?.outcome ?? "") || parsed.outcomes[id]?.state === "expired"),
      detail: `expired=${parsed.recovered.expired}`,
    });
    const readmitted = queuedBefore.filter((r) => !stale.includes(r.id));
    checks.push({
      name: "every unexpired queued row was re-admitted and completed, with a retrievable result",
      ok:
        parsed.recovered.readmitted === readmitted.length &&
        readmitted.every((r) => parsed.outcomes[r.id]?.state === "completed" && parsed.outcomes[r.id]?.result === true),
      detail: `readmitted=${parsed.recovered.readmitted}/${readmitted.length}; states=${readmitted.map((r) => parsed.outcomes[r.id]?.state).join(",")}`,
    });
    checks.push({
      name: "interrupted rows tell their owner to resubmit",
      ok: before
        .filter((r) => r.status === "running")
        .every((r) => /resubmit/iu.test(parsed.outcomes[r.id]?.outcome ?? "")),
      detail: "",
    });
    const stats = await mock.stats();
    // Across a crash the bound is capacity + interrupted, not capacity: the dead process's two
    // requests are still running on the server (it has no way to know the client is gone until the
    // response fails to write), and the survivor cannot see them. This is the "one published
    // result, not exactly-once GPU execution" caveat in the write-up made measurable, and the
    // reason interrupted rows are failed rather than replayed. A survivor that oversubscribed by
    // more than the interrupted count would be a real bug.
    checks.push({
      name: `server peak_arrivals <= capacity + interrupted (${2 + runningBefore}) across the crash`,
      ok: stats.concurrency.peak_arrivals <= 2 + runningBefore,
      detail: `peak_arrivals=${stats.concurrency.peak_arrivals}; the ${runningBefore} interrupted requests were still on the server when the survivor admitted its ${Math.min(2, readmitted.length)}`,
    });
    after.close();
    return { name: `restart: ${N} always-wait requests, SIGKILL mid-queue, survivor recovers`, checks, notes };
  } finally {
    await mock.stop();
  }
}

async function scenarioMatcher(o: Options): Promise<ScenarioResult> {
  // The setup agent's inconclusive check: the real workshop matcher, end to end, against the mock,
  // through the gate -- with an interactive member arriving mid-sweep and getting a slot promptly.
  const mock = await startMock(o.port, ["--latency-ms", String(o.latencyMs)]);
  const dbPath = freshFixture(o.artifactsDir, "matcher");
  const { store, gate } = openGate(dbPath, mock.baseUrl);
  gate.start();
  try {
    const members = store.listLabMembers();
    const papers = store.listPapers();
    const workshops = workshopProfilesFromDeadlines(DEADLINE_VENUES, new Date()).slice(0, 6);
    const inputs = workshopNudgeInputsFromAdminBot({
      papers,
      members,
      attendees: [],
      workshops,
    });
    const match = createLocalWorkshopMatcher({
      gate,
      baseUrl: mock.baseUrl,
      env: { ADMINBOT_LOCAL_BASE_URL: mock.baseUrl },
      papersPerRequest: 4,
      requestTimeoutMs: 30_000,
      retryBackoffMs: 0,
    });
    const progress: Array<[number, number, number]> = [];
    const t0 = Date.now();
    const sweep = match({
      papers: inputs.papers,
      workshops,
      onProgress: (done, total, failed) => progress.push([done, total, failed]),
    });
    // An interactive member arrives while the sweep is running; they should get a slot after at most
    // one matcher call finishes, not after the whole sweep.
    await sleep(o.latencyMs / 2);
    const tArrive = Date.now();
    const interactive = await gate.run({
      owner: "member-interactive",
      caller: "load_sim.interactive",
      submissionKey: "interactive-1",
      wait: true,
      request: chatRequest(mock.baseUrl, "urgent"),
    });
    const interactiveWait = Date.now() - tArrive;
    const matches = await sweep;
    const elapsed = Date.now() - t0;
    await untilIdle(gate);
    const stats = await mock.stats();
    const total = progress.at(-1)?.[1] ?? 0;
    const failed = progress.at(-1)?.[2] ?? 0;
    const checks: Check[] = [
      {
        name: "the real matcher completed its sweep against the mock through the gate",
        ok: total > 0 && progress.at(-1)?.[0] === total && failed === 0,
        detail: `${total} calls, ${failed} failed, ${matches.length} matches, wall ${elapsed}ms`,
      },
      {
        name: "mock peak_arrivals <= 2 with the matcher and an interactive caller both active",
        ok: stats.concurrency.peak_arrivals <= 2,
        detail: JSON.stringify(stats.concurrency),
      },
      {
        name: "the interactive request was served after at most ~one matcher call, not after the sweep",
        ok: interactive.kind === "completed" && interactiveWait < elapsed / 2 && interactiveWait < o.latencyMs * 3,
        detail: `interactive waited ${interactiveWait}ms; sweep took ${elapsed}ms`,
      },
      {
        name: "the matcher never held more than capacity rows in the line",
        ok: (auditEvents(store).map((e) => Number(e.details?.queue_depth ?? 0)).reduce((a, b) => Math.max(a, b), 0)) <= 3,
        detail: `max queue_depth seen in audit=${auditEvents(store).map((e) => Number(e.details?.queue_depth ?? 0)).reduce((a, b) => Math.max(a, b), 0)}`,
      },
      {
        name: "no duplicate bodies reached the server",
        ok: stats.duplicate_fingerprints.length === 0,
        detail: `${stats.distinct_fingerprints} distinct`,
      },
    ];
    return {
      name: "matcher: real workshop matcher end to end, with an interactive arrival mid-sweep",
      checks,
      notes: [`${workshops.length} workshops x ${inputs.papers.length} papers (batch 4) = ${total} calls`],
    };
  } finally {
    // Never close the database under a call that is still running: a completion that cannot be
    // recorded would look, in the report, exactly like a lost request.
    await untilIdle(gate, 30_000).catch(() => undefined);
    gate.close();
    store.close();
    await mock.stop();
  }
}

async function scenarioBroker(o: Options): Promise<ScenarioResult> {
  // The broker's multi-stage path under a burst: classify (local) -> remote (fails: no key) -> local.
  // Each task is two permits taken one after the other, never together.
  const mock = await startMock(o.port, ["--latency-ms", String(o.latencyMs)]);
  const dbPath = freshFixture(o.artifactsDir, "broker");
  const { store, gate } = openGate(dbPath, mock.baseUrl);
  gate.start();
  const audits: Array<{ type: string; details?: Record<string, unknown> }> = [];
  try {
    const broker = createAdminBotPrivacyBroker(
      {
        localBaseUrl: mock.baseUrl,
        localModel: "nvidia/Qwen3.5-122B-A10B-NVFP4",
        localApiKeyEnv: "VLLM_API_KEY",
        remoteBaseUrl: "https://integrate.api.nvidia.com/v1",
        remoteModel: "x",
        remoteApiKeyEnv: "NVIDIA_API_KEY",
      },
      { env: {}, gate, recordAudit: (e) => audits.push(e as { type: string }) },
    );
    const runs = Array.from({ length: 20 }, (_, i) =>
      broker
        .handle({ task: `task ${i}`, privacy: "private" }, undefined, { owner: `m${i}`, wait: true, submissionKey: `b${i}` })
        .then((r) => ({ ok: true as const, route: r.route }))
        .catch((error: Error) => ({ ok: false as const, error: error.name })),
    );
    const results = await Promise.all(runs);
    await untilIdle(gate);
    const stats = await mock.stats();
    const rows = queueRows(store);
    const checks: Check[] = [
      {
        name: "20 private tasks completed on the local route, each as two gated calls (classify + local)",
        ok: results.every((r) => r.ok && r.route === "local") && rows.length === 40 && rows.every((r) => r.status === "completed"),
        detail: `${results.filter((r) => r.ok).length} ok; ${rows.length} rows; states=${JSON.stringify(gate.stats().rows)}`,
      },
      {
        name: "mock peak_arrivals <= 2 across every stage of every task",
        ok: stats.concurrency.peak_arrivals <= 2,
        detail: JSON.stringify(stats.concurrency),
      },
      {
        name: "no duplicate bodies",
        ok: stats.duplicate_fingerprints.length === 0,
        detail: `${stats.distinct_fingerprints} distinct of ${stats.counters.arrivals}`,
      },
      {
        name: "each stage carries its own submission key derived from the task's",
        ok: rows.every((r) => /^b\d+:(classify|local)$/u.test(r.submission_key)),
        detail: rows.slice(0, 2).map((r) => r.submission_key).join(","),
      },
    ];
    return { name: "broker: 20 private tasks, two local stages each, under a burst", checks, notes: [`broker fallback audits recorded: ${audits.length}`] };
  } finally {
    // Never close the database under a call that is still running: a completion that cannot be
    // recorded would look, in the report, exactly like a lost request.
    await untilIdle(gate, 30_000).catch(() => undefined);
    gate.close();
    store.close();
    await mock.stop();
  }
}

// ---------------------------------------------------------------------------------------------
// Child roles for the restart scenario
// ---------------------------------------------------------------------------------------------

async function runVictim(o: Options): Promise<never> {
  const baseUrl = `http://127.0.0.1:${o.port}/v1`;
  const { gate } = openGate(o.dbPath as string, baseUrl);
  gate.start();
  for (let i = 0; i < o.requests; i += 1) {
    void gate.run({
      owner: `m${i}`,
      caller: "load_sim.restart",
      submissionKey: `rs${i}`,
      wait: true,
      request: chatRequest(baseUrl, `restart prompt ${i}`),
      timeoutMs: 120_000,
    });
  }
  await waitFor(() => gate.stats().in_flight === 2 && gate.stats().queued === o.requests - 2, 10_000, "victim did not fill");
  process.stdout.write(`VICTIM_PROCESS ${gate.processId}\nVICTIM_READY\n`);
  // Stay alive until killed.
  await new Promise(() => {});
  throw new Error("unreachable");
}

async function runSurvivor(o: Options): Promise<void> {
  const baseUrl = `http://127.0.0.1:${o.port}/v1`;
  const { store, gate } = openGate(o.dbPath as string, baseUrl);
  const recovered = gate.start();
  await untilIdle(gate);
  const outcomes: Record<string, { state: string; result: boolean; outcome?: string }> = {};
  for (const row of queueRows(store)) {
    const status = gate.status(row.owner_id, row.id);
    outcomes[row.id] = {
      state: status?.state ?? "missing",
      result: gate.result(row.owner_id, row.id) !== undefined,
      outcome: status?.message,
    };
  }
  process.stdout.write(`SURVIVOR_REPORT ${JSON.stringify({ recovered, outcomes })}\n`);
  gate.close();
  store.close();
}

// ---------------------------------------------------------------------------------------------

function log(line: string) {
  process.stdout.write(`${line}\n`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number, message: string) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await sleep(25);
  }
}

async function untilIdle(gate: InferenceGate, timeoutMs = 120_000) {
  await waitFor(() => gate.stats().in_flight === 0 && gate.stats().queued === 0, timeoutMs, "gate did not drain");
  // Let the last completion's transaction settle.
  await sleep(20);
}

async function main() {
  const o = parseArgs(process.argv);
  if (o.childRole === "restart-victim") {
    await runVictim(o);
    return;
  }
  if (o.childRole === "restart-survivor") {
    await runSurvivor(o);
    return;
  }
  // The gate module also warns about node:sqlite's experimental status through Node itself; that
  // warning is Node's, not this script's.
  const scenarios: Record<string, (o: Options) => Promise<ScenarioResult>> = {
    burst: scenarioBurst,
    retry: scenarioRetry,
    refuse: scenarioRefuse,
    hang: scenarioHang,
    restart: scenarioRestart,
    matcher: scenarioMatcher,
    broker: scenarioBroker,
  };
  const chosen = o.scenario === "all" ? Object.keys(scenarios) : o.scenario.split(",");
  const results: ScenarioResult[] = [];
  let failed = 0;
  for (const name of chosen) {
    const run = scenarios[name];
    if (!run) {
      throw new Error(`unknown scenario ${name}; choose from ${Object.keys(scenarios).join(", ")}`);
    }
    log(`\n== ${name} ==`);
    try {
      const result = await run(o);
      results.push(result);
      log(result.name);
      for (const note of result.notes) log(`  note: ${note}`);
      for (const check of result.checks) {
        log(`  ${check.ok ? "PASS" : "FAIL"} ${check.name}${check.detail ? ` -- ${check.detail}` : ""}`);
        if (!check.ok) failed += 1;
      }
    } catch (error) {
      failed += 1;
      log(`  ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      results.push({ name, checks: [{ name: "scenario ran", ok: false, detail: String(error) }], notes: [] });
    }
  }
  fs.mkdirSync(o.artifactsDir, { recursive: true });
  const reportPath = path.join(o.artifactsDir, "report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify({ ran_at: new Date().toISOString(), options: o, results }, null, 2)}\n`);
  log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}; report at ${reportPath}`);
  process.exit(failed === 0 ? 0 : 1);
}

void require;
main().catch((error) => {
  console.error(error);
  process.exit(1);
});

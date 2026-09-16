import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { currentTaskStepAttempt, taskStep } from "./context.js";
import { TaskRuntime } from "./runtime.js";

const tick = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
describe("shared task runtime", () => {
  it("bounds dispatch, preserves shed input, enforces owner identity and reattaches results", async () => {
    const r = new TaskRuntime({ maxRunning: 1 });
    let release!: () => void;
    let calls = 0;
    r.register<{ value: number }, number>("test", 1, async (input) => {
      calls++;
      if (input.value === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return input.value * 2;
    });
    const first = r.submit({ kind: "test", owner: "a", input: { value: 1 }, key: "first" });
    await tick();
    const second = r.submit({ kind: "test", owner: "a", input: { value: 2 }, key: "second" });
    expect(second.status).toBe("shed");
    expect(r.wait(second.id, "b")).toBeUndefined();
    const waited = r.wait(second.id, "a")!;
    expect(waited.status).toBe("queued");
    release();
    expect((await first.promise)!.result).toBe(2);
    expect((await waited.promise)!.result).toBe(4);
    expect(r.submit({ kind: "test", owner: "a", input: { value: 2 }, key: "second" }).result).toBe(
      4,
    );
    expect(calls).toBe(2);
    expect(() =>
      r.submit({ kind: "test", owner: "a", input: { value: 3 }, key: "second" }),
    ).toThrow("different task input");
    await r.shutdown({ graceMs: 0 });
  });
  it("retains completed predecessors and gives retry a new uncertain attempt", async () => {
    const r = new TaskRuntime();
    let first = 0,
      second = 0;
    const attempts: string[] = [];
    r.register("test", 1, async () => {
      await taskStep("first", {}, () => ++first);
      return taskStep("second", {}, () => {
        attempts.push(currentTaskStepAttempt()!);
        if (++second === 1) {
          throw new Error("connection lost");
        }
        return 42;
      });
    });
    const submitted = r.submit({ kind: "test", owner: "a", input: null });
    expect((await submitted.promise)!.status).toBe("needs_retry");
    const retried = r.retry(submitted.id, "a")!;
    expect((await retried.promise)!.result).toBe(42);
    expect(first).toBe(1);
    expect(new Set(attempts).size).toBe(2);
    await r.shutdown({ graceMs: 0 });
  });
  it("atomically rolls back domain writes if the checkpoint cannot serialize", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE effects (id INTEGER)");
    const r = new TaskRuntime({ db, maxResultBytes: 100 });
    r.register("test", 1, (_, ctx) =>
      ctx.commit("write", {}, () => {
        db.prepare("INSERT INTO effects VALUES(1)").run();
        return "x".repeat(101);
      }),
    );
    const submitted = r.submit({ kind: "test", owner: "a", input: null });
    expect((await submitted.promise)!.status).toBe("failed");
    expect(db.prepare("SELECT COUNT(*) AS n FROM effects").get()!.n).toBe(0);
    expect(r.steps(submitted.id)).toEqual([]);
    await r.shutdown({ graceMs: 0 });
    db.close();
  });
  it("cancels transports that ignore abort and prevents late journal writes", async () => {
    const db = new DatabaseSync(":memory:");
    const r = new TaskRuntime({ db });
    let release!: (s: string) => void;
    r.register("test", 1, async (_, ctx) =>
      ctx.step(
        "http",
        {},
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const submitted = r.submit({ kind: "test", owner: "a", input: null });
    await tick();
    await r.shutdown({ graceMs: 0 });
    expect((await submitted.promise)!.status).toBe("needs_retry");
    db.close();
    release("late");
    await tick();
  });
  it("pauses accepted backlog, expires bounded content, and resumes", async () => {
    let now = 0;
    const r = new TaskRuntime({ maxTasks: 1, retentionMs: 10, now: () => now });
    r.register("test", 1, () => 3);
    r.pause();
    const submitted = r.submit({ kind: "test", owner: "a", input: null, wait: true });
    expect(submitted.status).toBe("queued");
    r.resume();
    expect((await submitted.promise)!.result).toBe(3);
    expect(() => r.submit({ kind: "test", owner: "a", input: null })).toThrow("capacity");
    now = 11;
    expect(() => r.submit({ kind: "test", owner: "a", input: null })).toThrow("capacity");
    expect(r.get(submitted.id)!.status).toBe("expired");
    now = 22;
    const next = r.submit({ kind: "test", owner: "a", input: null });
    expect((await next.promise)!.status).toBe("completed");
    await r.shutdown({ graceMs: 0 });
  });
  it("rejects simultaneous durable owners and recovers queued work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-runtime-"));
    const file = join(dir, "tasks.sqlite");
    const db = new DatabaseSync(file);
    const db2 = new DatabaseSync(file);
    try {
      const first = new TaskRuntime({ db, persist: true });
      first.register("test", 1, () => 7);
      first.pause();
      first.start();
      const task = first.submit({ kind: "test", owner: "a", input: null, wait: true });
      const second = new TaskRuntime({ db: db2, persist: true });
      second.register("test", 1, () => 7);
      expect(() => second.start()).toThrow("Another live process");
      await first.shutdown({ graceMs: 0 });
      second.start();
      await tick();
      expect(second.get(task.id)!.result).toBe(7);
      await second.shutdown({ graceMs: 0 });
    } finally {
      db.close();
      db2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("bounds aggregate retained task and checkpoint content", async () => {
  const r = new TaskRuntime({ maxRetainedBytes: 12000, maxResultBytes: 20000 });
  r.register("test", 1, (_, ctx) => ctx.step("large", {}, () => "x".repeat(15000)));
  const submitted = r.submit({ kind: "test", owner: "a", input: "y".repeat(20) });
  expect((await submitted.promise)!.status).toBe("needs_retry");
  expect(r.metrics().retainedBytes).toBeLessThanOrEqual(12000);
  expect(() => r.submit({ kind: "test", owner: "b", input: "z".repeat(10000) })).toThrow(
    "capacity",
  );
  await r.shutdown({ graceMs: 0 });
});
it("resumes replay-safe orchestration after graceful suspension using completed child results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-suspend-"));
  const file = join(dir, "state.sqlite");
  const db = new DatabaseSync(file);
  let release!: () => void;
  let calls = 0;
  const r = new TaskRuntime({ db, persist: true });
  r.register("test", 1, async (_, ctx) =>
    ctx.step(
      "orchestration",
      {},
      async () => {
        await ctx.step("first", {}, async () => {
          calls++;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return 1;
        });
        return ctx.step("second", {}, () => 2);
      },
      { replaySafe: true },
    ),
  );
  const submitted = r.submit({ kind: "test", owner: "a", input: null });
  await tick();
  const closing = r.shutdown({ graceMs: 100 });
  release();
  await closing;
  expect((await submitted.promise)!.status).toBe("queued");
  const recovered = new TaskRuntime({ db, persist: true });
  recovered.register("test", 1, async (_, ctx) =>
    ctx.step(
      "orchestration",
      {},
      async () => {
        await ctx.step("first", {}, () => ++calls);
        return ctx.step("second", {}, () => 2);
      },
      { replaySafe: true },
    ),
  );
  recovered.start();
  const waited = recovered.wait(submitted.id, "a")!;
  expect((await waited.promise)!.result).toBe(2);
  expect(calls).toBe(1);
  await recovered.shutdown({ graceMs: 0 });
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
it("honors live shutdown grace changes and blocks subsequent cancelled work", async () => {
  const r = new TaskRuntime();
  let grace = 10_000;
  let after = 0;
  r.register("test", 1, async (_, ctx) => {
    await ctx.step("stalled", {}, () => new Promise(() => {}));
    return ctx.commit("after", {}, () => ++after);
  });
  const submitted = r.submit({ kind: "test", owner: "a", input: null });
  await tick();
  const closed = r.shutdown({ graceMs: () => grace });
  grace = 0;
  await closed;
  expect((await submitted.promise)!.status).toBe("needs_retry");
  expect(after).toBe(0);
});
it("keeps transient task payloads out of the main database and writes sanitized transactional audit", async () => {
  const db = new DatabaseSync(":memory:");
  const r = new TaskRuntime({ db });
  r.register("test", 1, (_, ctx) => ctx.step("stage", {}, () => "private result"));
  const submitted = r.submit({ kind: "test", owner: "owner", input: "private input" });
  await submitted.promise;
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='adminbot_transient_tasks'").get(),
  ).toBeUndefined();
  const audits = db.prepare("SELECT event_json FROM adminbot_audit_events").all();
  expect(audits.length).toBeGreaterThan(3);
  expect(JSON.stringify(audits)).not.toContain("private input");
  expect(JSON.stringify(audits)).not.toContain("private result");
  await r.shutdown({ graceMs: 0 });
  db.close();
});

it("does not let a handler hide an uncertain checkpoint behind a successful fallback", async () => {
  const r = new TaskRuntime();
  r.register("test", 1, async (_, ctx) => {
    try {
      await ctx.step("transport", {}, () => {
        throw new Error("unknown transport outcome");
      });
    } catch {
      return "fallback";
    }
  });
  const submitted = r.submit({ kind: "test", owner: "owner", input: null });
  expect((await submitted.promise)!.status).toBe("needs_retry");
  expect(r.get(submitted.id)!.result).toBeUndefined();
  await r.shutdown({ graceMs: 0 });
});

it("keeps active ownership intact when a terminal promise is immediately retried", async () => {
  const r = new TaskRuntime({ maxRunning: 2 });
  let attempts = 0;
  let release!: () => void;
  r.register("test", 1, async (_, ctx) =>
    ctx.step("operation", {}, async () => {
      if (++attempts === 1) {
        throw new Error("uncertain first attempt");
      }
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 9;
    }),
  );
  const first = r.submit({ kind: "test", owner: "owner", input: null });
  expect((await first.promise)!.status).toBe("needs_retry");
  const second = r.retry(first.id, "owner")!;
  await tick();
  expect(r.metrics().active).toBe(1);
  expect(r.get(first.id)!.status).toBe("running");
  release();
  expect((await second.promise)!.result).toBe(9);
  await r.shutdown({ graceMs: 0 });
});

it("uses indexed metadata queries without decoding completed bodies during scheduling", async () => {
  const db = new DatabaseSync(":memory:");
  const r = new TaskRuntime({ db });
  r.register<{ large?: boolean }, string>("test", 1, async (input, ctx) =>
    ctx.step("result", {}, () => (input.large ? "archived-large-body".repeat(10000) : "small")),
  );
  const archived = r.submit({
    kind: "test",
    owner: "owner",
    key: "archived",
    input: { large: true },
  });
  await archived.promise;
  await tick();
  const all = vi.spyOn(r.store, "all").mockImplementation(() => {
    throw new Error("Hot path decoded the task archive");
  });
  const journal = vi.spyOn(r.store, "journal").mockImplementation(() => {
    throw new Error("Hot path decoded the complete checkpoint journal");
  });
  const parse = JSON.parse;
  const decode = vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
    if (text.includes("archived-large-body")) {
      throw new Error("Unrelated completed payload decoded");
    }
    return parse(text) as unknown;
  });
  try {
    r.pause();
    const next = r.submit({ kind: "test", owner: "owner", key: "next", input: {}, wait: true });
    expect(r.submit({ kind: "test", owner: "owner", key: "next", input: {} }).id).toBe(next.id);
    r.resume();
    expect((await next.promise)!.result).toBe("small");
    r.resume();
    expect(r.metrics().completed).toBe(2);
    expect(all).not.toHaveBeenCalled();
    expect(journal).not.toHaveBeenCalled();
    const table = r.store.table;
    const queries = [
      {
        sql: `SELECT id FROM ${table} WHERE json_extract(record,'$.status')='queued' ORDER BY rowid`,
        index: `${table}_status_idx`,
      },
      {
        sql: `SELECT id,json_extract(record,'$.status') FROM ${table} WHERE json_extract(record,'$.expiresAt')<=0`,
        index: `${table}_expiry_idx`,
      },
      {
        sql: `SELECT SUM(length(CAST(record AS BLOB))) FROM ${table} INDEXED BY ${table}_bytes_idx`,
        index: `${table}_bytes_idx`,
      },
    ];
    for (const query of queries) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all();
      expect(JSON.stringify(plan)).toContain(query.index);
    }
    await r.shutdown({ graceMs: 0 });
  } finally {
    decode.mockRestore();
    all.mockRestore();
    journal.mockRestore();
    await r.shutdown({ graceMs: 0 });
    db.close();
  }
});
it("requires positive safe integer runtime resource limits", () => {
  const fields = [
    "maxRunning",
    "maxTasks",
    "maxInputBytes",
    "maxResultBytes",
    "maxSteps",
    "maxRetainedBytes",
    "maxAttempts",
    "retentionMs",
  ] as const;
  for (const field of fields) {
    for (const value of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new TaskRuntime({ [field]: value })).toThrow(`Invalid task runtime ${field}`);
    }
  }
});
it.each([0, -1, 1.5, Number.NaN, Infinity, 2_147_483_648])(
  "rejects invalid checkpoint timeout %s before recording or invoking it",
  async (timeoutMs) => {
    const r = new TaskRuntime();
    let calls = 0;
    r.register("test", 1, (_, ctx) => ctx.step("operation", {}, () => ++calls, { timeoutMs }));
    const submitted = r.submit({ kind: "test", owner: "owner", input: null });
    const result = await submitted.promise;
    expect(result!.status).toBe("failed");
    expect(result!.error).toContain("Task step timeout");
    expect(calls).toBe(0);
    expect(r.steps(submitted.id)).toEqual([]);
    await r.shutdown({ graceMs: 0 });
  },
);

it("allows immediate execution with zero waiting capacity but keeps excess input shed", async () => {
  const r = new TaskRuntime({ maxQueued: 0, maxRunning: 1 });
  let release!: () => void;
  r.register(
    "test",
    1,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = r.submit({ kind: "test", owner: "owner", input: 1, wait: true });
  expect(first.status).toBe("running");
  await tick();
  const second = r.submit({ kind: "test", owner: "owner", input: 2, wait: true });
  expect(second.status).toBe("shed");
  expect(r.wait(second.id, "owner")!.status).toBe("shed");
  expect(r.get(second.id)!.input).toBe(2);
  release();
  await first.promise;
  await tick();
  const admitted = r.wait(second.id, "owner")!;
  expect(admitted.status).toBe("running");
  await tick();
  release();
  await admitted.promise;
  await r.shutdown({ graceMs: 0 });
});
it("retains full-queue submissions and admits them when cancellation or expiry frees space", async () => {
  let now = 0;
  const r = new TaskRuntime({ maxQueued: 1, maxRunning: 1, now: () => now, retentionMs: 10 });
  r.register("test", 1, () => 7);
  r.pause();
  const queued = r.submit({ kind: "test", owner: "owner", input: 1, wait: true });
  const shed = r.submit({ kind: "test", owner: "owner", input: 2, wait: true });
  expect(queued.status).toBe("queued");
  expect(shed.status).toBe("shed");
  expect(r.wait(shed.id, "owner")!.status).toBe("shed");
  r.cancel(queued.id, "owner");
  expect(r.wait(shed.id, "owner")!.status).toBe("queued");
  now = 5;
  const later = r.submit({ kind: "test", owner: "owner", input: 3, wait: true });
  expect(later.status).toBe("shed");
  now = 11;
  const admitted = r.wait(later.id, "owner")!;
  expect(admitted.status).toBe("queued");
  expect(r.get(shed.id)!.status).toBe("expired");
  r.resume();
  expect((await admitted.promise)!.result).toBe(7);
  await r.shutdown({ graceMs: 0 });
});
it("does not implicitly queue a newcomer ahead of an existing backlog", async () => {
  let canStart = false;
  const r = new TaskRuntime({ canStart: () => canStart, maxQueued: 2 });
  r.register("test", 1, () => 1);
  const first = r.submit({ kind: "test", owner: "owner", input: 1, wait: true });
  expect(first.status).toBe("queued");
  canStart = true;
  const newcomer = r.submit({ kind: "test", owner: "owner", input: 2 });
  expect(newcomer.status).toBe("shed");
  await first.promise;
  await r.shutdown({ graceMs: 0 });
});
it("rejects fractional or negative task backlog limits", () => {
  for (const maxQueued of [-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => new TaskRuntime({ maxQueued })).toThrow("Invalid task runtime maxQueued");
  }
});

it("dispatches an accepted wait into the model FIFO independently of immediate capacity", async () => {
  let canDispatch = true;
  let calls = 0;
  const r = new TaskRuntime({ canStart: () => false, canDispatch: () => canDispatch });
  r.register("test", 1, () => ++calls);
  const shed = r.submit({ kind: "test", owner: "owner", input: 1 });
  expect(shed.status).toBe("shed");
  expect(calls).toBe(0);
  const waiting = r.wait(shed.id, "owner")!;
  expect(waiting.status).toBe("running");
  expect((await waiting.promise)!.result).toBe(1);
  canDispatch = false;
  const paused = r.submit({ kind: "test", owner: "owner", input: 2, wait: true });
  expect(paused.status).toBe("queued");
  r.resume();
  await tick();
  expect(calls).toBe(1);
  expect(r.get(paused.id)!.status).toBe("queued");
  canDispatch = true;
  r.resume();
  expect((await paused.promise)!.result).toBe(2);
  await r.shutdown({ graceMs: 0 });
});

it("gives each owner a share of the waiting line and dispatches owners in turn", async () => {
  // One member filling the queue must not put every later member behind all of it. The share
  // bounds how much of the line one owner holds; the rotation bounds how long the next one waits.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  const r = new TaskRuntime({ maxRunning: 1, maxInFlightPerOwner: 2 });
  r.register<{ tag: string }, string>("test", 1, async (input) => {
    started.push(input.tag);
    await held;
    return input.tag;
  });

  // Fills the single running slot, so everything after this contends for the queue.
  const running = r.submit({ kind: "test", owner: "ada", input: { tag: "ada-0" }, wait: true });
  await tick();
  expect(started).toEqual(["ada-0"]);

  // ada holds one of her two shares already; the next fits, the one after it does not.
  const adaSecond = r.submit({ kind: "test", owner: "ada", input: { tag: "ada-1" }, wait: true });
  expect(adaSecond.status).toBe("queued");
  const adaThird = r.submit({ kind: "test", owner: "ada", input: { tag: "ada-2" }, wait: true });
  expect(adaThird.status).toBe("shed");
  expect(adaThird.task.error).toBeUndefined();

  // A different owner is unaffected by ada's share, and is not refused.
  const bo = r.submit({ kind: "test", owner: "bo", input: { tag: "bo-0" }, wait: true });
  expect(bo.status).toBe("queued");

  // ada-1 arrived before bo-0, but ada was served last, so the rotation runs bo-0 first.
  release();
  expect((await running.promise)!.result).toBe("ada-0");
  expect((await bo.promise)!.result).toBe("bo-0");
  expect((await adaSecond.promise)!.result).toBe("ada-1");
  expect(started.slice(0, 2)).toEqual(["ada-0", "bo-0"]);
  // The shed task never ran, and is still the owner's to resume.
  expect(started).not.toContain("ada-2");
  expect(r.get(adaThird.id, "ada")!.status).toBe("shed");
  await r.shutdown({ graceMs: 0 });
});

it("serves every waiting owner before serving a backlogged one twice", async () => {
  // The two-owner test above covers one round, which is the one shape where ordering by
  // least-recently-served and resuming after the owner served last agree. They diverge as soon
  // as an owner's queue empties: an earlier implementation lost its cursor there and fell back
  // to the head of the arrival-ordered list, which is the backlogged owner, handing them every
  // second dispatch regardless of how many others were waiting.
  const started: string[] = [];
  const r = new TaskRuntime({ maxRunning: 1, maxInFlightPerOwner: 32 });
  r.register<{ tag: string }, string>("test", 1, (input) => {
    started.push(input.tag);
    return input.tag;
  });
  for (let n = 0; n < 10; n += 1) {
    r.submit({ kind: "test", owner: "ada", input: { tag: `ada-${n}` }, wait: true });
  }
  const singles = ["bo", "cy", "di", "eve", "fay"];
  for (const owner of singles) {
    r.submit({ kind: "test", owner, input: { tag: owner }, wait: true });
  }
  await vi.waitFor(() => expect(started.length).toBeGreaterThanOrEqual(6), { timeout: 5_000 });

  // ada may lead -- she arrived first -- but every other owner is served before she is again.
  expect(started[0]).toBe("ada-0");
  expect(new Set(started.slice(1, 6))).toEqual(new Set(singles));
  expect(started.slice(0, 6).filter((tag) => tag.startsWith("ada"))).toHaveLength(1);
  await r.shutdown({ graceMs: 0 });
});

it("reaches a terminal state even when the store fails while recording the failure", async () => {
  // execute's catch is the last error boundary and every line in it touches SQLite. Unguarded,
  // a store failure there rejected a promise nobody awaits, and the task stayed at "running"
  // with its waiter unsettled -- a member's Wait hanging until the service restarted.
  const db = new DatabaseSync(":memory:");
  const r = new TaskRuntime({ db });
  r.register("test", 1, () => {
    throw new Error("handler failed");
  });
  // The first store read inside that catch. One failure, so the retry below can still land.
  const stepsWithStatus = r.store.stepsWithStatus.bind(r.store);
  let firstRecording = true;
  r.store.stepsWithStatus = (id, status) => {
    if (firstRecording) {
      firstRecording = false;
      throw new Error("SQLITE_BUSY: database is locked");
    }
    return stepsWithStatus(id, status);
  };
  const submitted = r.submit({ kind: "test", owner: "a", input: null });
  const settled = await submitted.promise;
  expect(settled!.status).toBe("failed");
  expect(r.get(submitted.id)!.status).toBe("failed");
  await r.shutdown({ graceMs: 0 });
  db.close();
});

it("persists task lifecycle event types on the shared audit trail without task content", async () => {
  const db = new DatabaseSync(":memory:");
  const runtime = new TaskRuntime({ db });
  runtime.register("test", 1, (_, ctx) => ctx.step("model", {}, () => "private-output"));
  const task = runtime.submit({ owner: "member:a", kind: "test", input: "private-input" });
  await task.promise;
  const rows = db.prepare("SELECT event_type,event_json FROM adminbot_audit_events").all();
  expect(rows.map((row) => row.event_type)).toEqual([
    "task.accepted",
    "task.running",
    "task.step.running",
    "task.step.completed",
    "task.completed",
  ]);
  for (const row of rows) {
    expect(JSON.parse(String(row.event_json)).type).toBe(row.event_type);
  }
  expect(JSON.stringify(rows)).not.toContain("private-input");
  expect(JSON.stringify(rows)).not.toContain("private-output");
  await runtime.shutdown({ graceMs: 0 });
  db.close();
});

it.each([false, true])(
  "bounds explicit retries, including failures before checkpoints (step=%s)",
  async (step) => {
    const runtime = new TaskRuntime({ maxAttempts: 2 });
    let calls = 0;
    const fail = () => {
      calls++;
      throw new Error("deterministic failure");
    };
    runtime.register("test", 1, (_, ctx) =>
      step ? ctx.step("fail", {}, fail, { replaySafe: true }) : fail(),
    );
    const first = runtime.submit({ owner: "a", kind: "test", input: {} });
    expect((await first.promise)?.status).toBe("failed");
    const second = runtime.retry(first.id, "a")!;
    expect((await second.promise)?.retryExhausted).toBe(true);
    expect(() => runtime.retry(first.id, "a")).toThrow("attempt limit");
    expect(calls).toBe(2);
    await runtime.shutdown({ graceMs: 0 });
  },
);

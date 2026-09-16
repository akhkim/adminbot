import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { taskView } from "../api/server.tasks.js";
import { TaskRuntime } from "./runtime.js";

function failEvent(db: DatabaseSync, event: string) {
  db.exec(`CREATE TRIGGER fail_task_event BEFORE INSERT ON adminbot_audit_events
    WHEN NEW.event_type='${event}' BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END`);
}

it("keeps an accepted task queued when its running transition cannot be committed", async () => {
  vi.useFakeTimers();
  const alert = vi.spyOn(console, "error").mockImplementation(() => {});
  const db = new DatabaseSync(":memory:");
  const runtime = new TaskRuntime({ db });
  let calls = 0;
  runtime.register("work", 1, () => ++calls);
  runtime.pause();
  const submitted = runtime.submit({ owner: "a", kind: "work", input: {}, wait: true });
  failEvent(db, "task.running");
  try {
    expect(() => runtime.resume()).not.toThrow();
    expect(runtime.get(submitted.id)?.status).toBe("queued");
    expect(runtime.metrics().active).toBe(0);
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(runtime.get(submitted.id)?.status).toBe("queued");
    expect(alert).toHaveBeenCalledTimes(1);
    db.exec("DROP TRIGGER fail_task_event");
    await vi.advanceTimersByTimeAsync(100);
    expect((await submitted.promise)?.result).toBe(1);
    expect(calls).toBe(1);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_task_event");
    await runtime.shutdown({ graceMs: 0 });
    db.close();
    alert.mockRestore();
    vi.useRealTimers();
  }
});

it("retains uncertain checkpoints when Retry's admission transaction fails", async () => {
  const db = new DatabaseSync(":memory:");
  const runtime = new TaskRuntime({ db });
  runtime.register("work", 1, (_, ctx) =>
    ctx.step("uncertain", {}, () => {
      throw new Error("response lost");
    }),
  );
  const submitted = runtime.submit({ owner: "a", kind: "work", input: {} });
  expect((await submitted.promise)?.status).toBe("needs_retry");
  const before = runtime.steps(submitted.id);
  failEvent(db, "task.queued");
  try {
    expect(() => runtime.retry(submitted.id, "a")).toThrow("synthetic storage failure");
    expect(runtime.get(submitted.id)?.status).toBe("needs_retry");
    expect(runtime.steps(submitted.id)).toEqual(before);
  } finally {
    db.exec("DROP TRIGGER fail_task_event");
    await runtime.shutdown({ graceMs: 0 });
    db.close();
  }
});

it("can retry startup recovery after a failed recovery audit", async () => {
  const db = new DatabaseSync(":memory:");
  const seed = new TaskRuntime({ db, persist: true });
  seed.register("work", 1, () => "unused");
  seed.pause();
  const submitted = seed.submit({ owner: "a", kind: "work", input: {}, wait: true });
  await seed.shutdown({ graceMs: 0 });
  seed.store.save({ ...submitted.task, status: "running" });
  seed.store.saveStep(submitted.id, {
    key: "model",
    hash: "synthetic",
    status: "running",
    attempt: "old",
  });
  const runtime = new TaskRuntime({ db, persist: true });
  let calls = 0;
  runtime.register("work", 1, () => ++calls);
  failEvent(db, "task.needs_retry");
  try {
    expect(() => runtime.start()).toThrow("synthetic storage failure");
    expect(runtime.store.step(submitted.id, "model")?.status).toBe("running");
    expect(db.prepare("SELECT count(*) n FROM adminbot_task_runner_lock").get()!.n).toBe(0);
    db.exec("DROP TRIGGER fail_task_event");
    runtime.start();
    expect(runtime.get(submitted.id)?.status).toBe("needs_retry");
    expect(calls).toBe(0);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_task_event");
    await runtime.shutdown({ graceMs: 0 });
    db.close();
  }
});

it("cancels a running task and prevents a late continuation from committing", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE effects (value TEXT)");
  const runtime = new TaskRuntime({ db });
  let release!: () => void;
  let resumed!: () => void;
  let lateError: unknown;
  const continuation = new Promise<void>((resolve) => {
    resumed = resolve;
  });
  runtime.register("work", 1, async (_, ctx) => {
    try {
      await ctx.step(
        "model",
        {},
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
    } catch {
      /* A workflow may catch a rejected stage and try to continue. */
    }
    try {
      ctx.commit("write", {}, () => db.exec("INSERT INTO effects VALUES('late')"));
    } catch (error) {
      lateError = error;
    } finally {
      resumed();
    }
  });
  const submitted = runtime.submit({ owner: "a", kind: "work", input: {} });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(runtime.cancel(submitted.id, "other")).toBeUndefined();
  runtime.cancel(submitted.id, "a");
  expect((await submitted.promise)?.status).toBe("cancelled");
  release();
  await continuation;
  expect(lateError).toMatchObject({ name: "TaskInterruptedError" });
  expect(db.prepare("SELECT count(*) n FROM effects").get()!.n).toBe(0);
  expect(runtime.get(submitted.id)?.status).toBe("cancelled");
  await runtime.shutdown({ graceMs: 0 });
  db.close();
});

it("does not advertise Retry after a crash consumed the final execution attempt", async () => {
  const db = new DatabaseSync(":memory:");
  const seed = new TaskRuntime({ db, persist: true });
  seed.register("work", 1, () => "unused");
  seed.pause();
  const submitted = seed.submit({ owner: "a", kind: "work", input: {}, wait: true });
  await seed.shutdown({ graceMs: 0 });
  seed.store.save({ ...submitted.task, status: "running", executionAttempts: 1 });
  seed.store.saveStep(submitted.id, {
    key: "model",
    hash: "synthetic",
    status: "running",
    attempt: "old",
  });
  const runtime = new TaskRuntime({ db, persist: true, maxAttempts: 1 });
  let calls = 0;
  runtime.register("work", 1, () => ++calls);
  try {
    runtime.start();
    const recovered = runtime.get(submitted.id)!;
    expect(recovered.status).toBe("needs_retry");
    expect(taskView(recovered).actions).not.toContain("retry");
    expect(recovered.error).toContain("attempt limit");
    expect(() => runtime.retry(submitted.id, "a")).toThrow("attempt limit");
    expect(calls).toBe(0);
  } finally {
    await runtime.shutdown({ graceMs: 0 });
    db.close();
  }
});

it("settles a failed handler even if the first cancellation-status read fails", async () => {
  const db = new DatabaseSync(":memory:");
  const runtime = new TaskRuntime({ db });
  let failRead = false;
  const get = runtime.store.get.bind(runtime.store);
  const read = vi.spyOn(runtime.store, "get").mockImplementation((id) => {
    if (failRead) {
      failRead = false;
      throw new Error("synthetic read failure");
    }
    return get(id);
  });
  runtime.register("work", 1, () => {
    failRead = true;
    throw new Error("handler failed");
  });
  const submitted = runtime.submit({ owner: "a", kind: "work", input: {} });
  try {
    await vi.waitFor(() => expect(runtime.get(submitted.id)?.status).toBe("failed"), {
      timeout: 300,
    });
    expect((await submitted.promise)?.status).toBe("failed");
  } finally {
    read.mockRestore();
    await runtime.shutdown({ graceMs: 0 });
    db.close();
  }
});

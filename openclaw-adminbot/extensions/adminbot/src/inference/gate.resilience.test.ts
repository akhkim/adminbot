import { expect, it, vi } from "vitest";
import { inferenceTestConfig } from "./config.test-support.js";
import { createInferenceGate } from "./gate.js";
import { openInferenceTestDb } from "./gate.test-support.js";

const request = {
  route: "chat/completions" as const,
  baseUrl: "http://127.0.0.1:8000/v1",
  purpose: "synthetic review",
  body: { prompt: "synthetic" },
};

it("keeps an expiring waiter's promise attached if the expiry transaction fails", async () => {
  vi.useFakeTimers();
  const db = openInferenceTestDb();
  const fetchImpl = vi.fn();
  const gate = createInferenceGate({
    db,
    env: {},
    fetchImpl,
    config: inferenceTestConfig({
      startPaused: true,
      queue: { maxAgeMs: 20, sweepIntervalMs: 0 },
    }),
  });
  const pending = gate.run({ owner: "a", caller: "test", request, wait: true });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  try {
    db.exec(`CREATE TRIGGER fail_expiry BEFORE INSERT ON adminbot_audit_events
      WHEN NEW.event_type='inference.expired' BEGIN SELECT RAISE(ABORT,'synthetic expiry failure'); END`);
    await vi.advanceTimersByTimeAsync(30);
    expect(() => gate.sweep()).toThrow("synthetic expiry failure");
    expect(settled).toBe(false);
    expect(gate.stats().queued).toBe(1);
    db.exec("DROP TRIGGER fail_expiry");
    gate.sweep();
    expect((await pending).kind).toBe("expired");
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_expiry");
    await gate.shutdown();
    db.close();
    vi.useRealTimers();
  }
});

it("retries a periodic expiry after storage recovery without throwing from the timer", async () => {
  vi.useFakeTimers();
  const db = openInferenceTestDb();
  const gate = createInferenceGate({
    db,
    env: {},
    fetchImpl: vi.fn(),
    config: inferenceTestConfig({
      startPaused: true,
      queue: { maxAgeMs: 20, sweepIntervalMs: 30 },
    }),
  });
  gate.start();
  const pending = gate.run({ owner: "a", caller: "test", request, wait: true });
  try {
    db.exec(`CREATE TRIGGER fail_expiry BEFORE INSERT ON adminbot_audit_events
      WHEN NEW.event_type='inference.expired' BEGIN SELECT RAISE(ABORT,'synthetic expiry failure'); END`);
    await vi.advanceTimersByTimeAsync(60);
    expect(gate.stats().queued).toBe(1);
    db.exec("DROP TRIGGER fail_expiry");
    await vi.advanceTimersByTimeAsync(30);
    expect((await pending).kind).toBe("expired");
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_expiry");
    await gate.shutdown();
    db.close();
    vi.useRealTimers();
  }
});

it("retries a failed escalation audit without proposing the same escalation twice", async () => {
  const db = openInferenceTestDb();
  const onEscalate = vi.fn(async () => ({ proposal_id: "synthetic-proposal" }));
  const alert = vi.fn();
  const gate = createInferenceGate({
    db,
    env: {},
    onEscalate,
    alert,
    config: inferenceTestConfig({
      health: { failureThreshold: 1 },
      escalate: { healthFailures: 1 },
    }),
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      statusText: "Unavailable",
      text: async () => "",
    }),
  });
  try {
    db.exec(`CREATE TRIGGER fail_escalation BEFORE INSERT ON adminbot_audit_events
      WHEN NEW.event_type='inference.escalation_proposed' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
    await expect(gate.probeHealth()).resolves.toMatchObject({ state: "down" });
    expect(onEscalate).toHaveBeenCalledTimes(1);
    db.exec("DROP TRIGGER fail_escalation");
    await gate.probeHealth();
    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM adminbot_audit_events WHERE event_type='inference.escalation_proposed'",
        )
        .get()!.n,
    ).toBe(1);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_escalation");
    await gate.shutdown();
    db.close();
  }
});

it("retries partial startup recovery without duplicating recovered waiters", async () => {
  const db = openInferenceTestDb();
  const config = inferenceTestConfig({ persistAcrossRestarts: true, startPaused: true });
  const seed = createInferenceGate({ db, env: {}, config });
  void seed.run({ owner: "a", caller: "test", request, wait: true, submissionKey: "keep" });
  void seed.run({ owner: "a", caller: "test", request, wait: true, submissionKey: "expire" });
  seed.close();
  db.exec(
    "UPDATE adminbot_inference_queue SET expires_at='2000-01-01T00:00:00.000Z' WHERE submission_key='expire'",
  );
  const fetchImpl = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "done",
  }));
  const gate = createInferenceGate({ db, env: {}, config, fetchImpl });
  try {
    db.exec(`CREATE TRIGGER fail_expiry BEFORE INSERT ON adminbot_audit_events
      WHEN NEW.event_type='inference.expired' BEGIN SELECT RAISE(ABORT,'synthetic expiry failure'); END`);
    expect(() => gate.start()).toThrow("synthetic expiry failure");
    db.exec("DROP TRIGGER fail_expiry");
    expect(gate.start().expired).toBe(1);
    expect(gate.stats().queued).toBe(1);
    gate.resume();
    await vi.waitFor(() => expect(gate.stats().rows.completed).toBe(1));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_expiry");
    await gate.shutdown();
    await seed.shutdown();
    db.close();
  }
});

it("keeps shutdown waiters attached when a terminal write fails", async () => {
  const db = openInferenceTestDb();
  const gate = createInferenceGate({
    db,
    env: {},
    fetchImpl: vi.fn(),
    config: inferenceTestConfig({ startPaused: true }),
  });
  const pending = gate.run({ owner: "a", caller: "test", request, wait: true });
  try {
    db.exec(`CREATE TRIGGER fail_shutdown BEFORE INSERT ON adminbot_audit_events
      WHEN NEW.event_type='inference.failed' BEGIN SELECT RAISE(ABORT,'synthetic shutdown failure'); END`);
    expect(() => gate.shutdown()).toThrow("synthetic shutdown failure");
    expect(gate.stats().queued).toBe(1);
    db.exec("DROP TRIGGER fail_shutdown");
    await gate.shutdown();
    expect((await pending).kind).toBe("failed");
    expect(gate.stats().rows.queued).toBe(0);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_shutdown");
    await gate.shutdown();
    db.close();
  }
});

it("backs off blocked admission and exposes its owning task's storage notice", async () => {
  vi.useFakeTimers();
  const db = openInferenceTestDb();
  const fetchImpl = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "done",
  }));
  const gate = createInferenceGate({
    db,
    env: {},
    fetchImpl,
    config: inferenceTestConfig({ startPaused: true, queue: { maxAgeMs: 300_000 } }),
  });
  const pending = gate.run({ owner: "a", taskId: "task-a", caller: "test", request, wait: true });
  db.exec(`CREATE TRIGGER fail_admission BEFORE INSERT ON adminbot_audit_events
    WHEN NEW.event_type='inference.admitted' BEGIN SELECT RAISE(ABORT,'synthetic admission failure'); END`);
  const exec = vi.spyOn(db, "exec");
  const attempts = () => exec.mock.calls.filter(([sql]) => sql === "BEGIN IMMEDIATE").length;
  try {
    gate.resume();
    expect(attempts()).toBe(1);
    expect(gate.admissionNotice("task-a")).toContain("storage problem");
    expect(gate.admissionNotice("other-task")).toBeUndefined();
    gate.pause();
    expect(gate.admissionNotice("task-a")).toBeUndefined();
    gate.resume();
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts()).toBe(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(attempts()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts()).toBe(3);
    await vi.advanceTimersByTimeAsync(58_000);
    expect(attempts()).toBe(7);
    expect(fetchImpl).not.toHaveBeenCalled();
    db.exec("DROP TRIGGER fail_admission");
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).kind).toBe("completed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(gate.admissionNotice("task-a")).toBeUndefined();
  } finally {
    exec.mockRestore();
    db.exec("DROP TRIGGER IF EXISTS fail_admission");
    await gate.shutdown();
    db.close();
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "uses one cancellation audit shape before or after a storage retry (retry=%s)",
  async (retry) => {
    vi.useFakeTimers();
    const db = openInferenceTestDb();
    const gate = createInferenceGate({
      db,
      env: {},
      fetchImpl: vi.fn(),
      config: inferenceTestConfig({ startPaused: true }),
    });
    const controller = new AbortController();
    const pending = gate.run({
      owner: "a",
      caller: "test",
      request,
      wait: true,
      signal: controller.signal,
    });
    try {
      if (retry) {
        db.exec(`CREATE TRIGGER fail_cancel BEFORE INSERT ON adminbot_audit_events
      WHEN NEW.event_type='inference.failed' BEGIN SELECT RAISE(ABORT,'synthetic cancellation failure'); END`);
      }
      controller.abort();
      if (retry) {
        db.exec("DROP TRIGGER fail_cancel");
        gate.resume();
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect((await pending).kind).toBe("failed");
      const row = db
        .prepare("SELECT event_json FROM adminbot_audit_events WHERE event_type='inference.failed'")
        .get()!;
      const details = JSON.parse(String(row.event_json)).details;
      expect(Object.keys(details).toSorted()).toEqual([
        "caller",
        "duration_ms",
        "in_flight",
        "outcome",
        "queue_depth",
        "request_id",
        "wait_ms",
      ]);
      expect(details).toMatchObject({
        outcome: "cancelled",
        duration_ms: 0,
        wait_ms: expect.any(Number),
      });
    } finally {
      db.exec("DROP TRIGGER IF EXISTS fail_cancel");
      await gate.shutdown();
      db.close();
      vi.useRealTimers();
    }
  },
);

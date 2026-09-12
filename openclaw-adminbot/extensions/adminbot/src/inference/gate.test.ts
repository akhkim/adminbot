import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotAuditEvent } from "../contracts/actions.js";
import { resolveInferenceGateConfig } from "./config.js";
import {
  createInferenceGate,
  InferenceDeferredError,
  runGated,
  type InferenceFetch,
  type InferenceGate,
  type InferenceOutcome,
} from "./gate.js";
import type { InferenceRequestRecord } from "./queue-store.js";

const require = createRequire(import.meta.url);

function openDb(): DatabaseSync {
  const sqlite = require("node:sqlite") as typeof import("node:sqlite");
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec(`CREATE TABLE adminbot_audit_events (
    id TEXT PRIMARY KEY, action_id TEXT, event_type TEXT NOT NULL,
    timestamp TEXT NOT NULL, actor TEXT, event_json TEXT NOT NULL
  )`);
  return db;
}

function auditEvents(db: DatabaseSync): AdminBotAuditEvent[] {
  return (
    db
      .prepare("SELECT event_json FROM adminbot_audit_events ORDER BY timestamp, rowid")
      .all() as Array<{ event_json: string }>
  ).map((row) => JSON.parse(row.event_json) as AdminBotAuditEvent);
}

function request(prompt: string): InferenceRequestRecord {
  return {
    route: "chat/completions",
    baseUrl: "http://127.0.0.1:8000/v1",
    body: { model: "m", messages: [{ role: "user", content: prompt }] },
    purpose: "test call",
  };
}

/** A fake model whose calls resolve only when the test says so, to hold slots deliberately. */
function controllableFetch() {
  const pending: Array<{ body: string; resolve: () => void }> = [];
  let inFlight = 0;
  let peak = 0;
  const fetchImpl: InferenceFetch = async (_url, init) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => pending.push({ body: init.body ?? "", resolve }));
    inFlight -= 1;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    };
  };
  return {
    fetchImpl,
    release(count = 1) {
      for (let i = 0; i < count; i += 1) {
        pending.shift()?.resolve();
      }
    },
    releaseAll() {
      while (pending.length) {
        pending.shift()?.resolve();
      }
    },
    get pendingCount() {
      return pending.length;
    },
    get peak() {
      return peak;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const gates: InferenceGate[] = [];
afterEach(() => {
  for (const gate of gates.splice(0)) {
    gate.close();
  }
});

function makeGate(
  db: DatabaseSync,
  fetchImpl: InferenceFetch,
  overrides: Parameters<typeof resolveInferenceGateConfig>[1] = {},
  extra: Partial<Parameters<typeof createInferenceGate>[0]> = {},
) {
  const gate = createInferenceGate({
    db,
    fetchImpl,
    env: {},
    config: resolveInferenceGateConfig(
      {},
      {
        capacity: 2,
        queue: { sweepIntervalMs: 0, ...overrides.queue },
        health: { intervalMs: 0, ...overrides.health },
        ...(overrides.escalate ? { escalate: overrides.escalate } : {}),
        ...(overrides.capacity !== undefined ? { capacity: overrides.capacity } : {}),
      },
    ),
    ...extra,
  });
  gates.push(gate);
  return gate;
}

describe("inference gate admission", () => {
  it("never has more requests in flight than its capacity, whatever arrives at once", async () => {
    const db = openDb();
    const model = controllableFetch();
    const gate = makeGate(db, model.fetchImpl);

    const runs = Array.from({ length: 10 }, (_, i) =>
      gate.run({ owner: "ada", caller: "test", request: request(`p${i}`), wait: true }),
    );
    await settle();
    expect(model.peak).toBe(2);
    expect(gate.stats().queued).toBe(8);

    // Frees one slot at a time; the line advances one at a time.
    for (let i = 0; i < 10; i += 1) {
      model.release();
      await settle();
      expect(model.peak).toBe(2);
    }
    const outcomes = await Promise.all(runs);
    expect(outcomes.every((o) => o.kind === "completed")).toBe(true);

    // Every row has exactly one terminal event, and it is `completed`.
    const events = auditEvents(db);
    const terminal = events.filter((e) =>
      ["inference.completed", "inference.failed", "inference.expired"].includes(e.type),
    );
    expect(terminal).toHaveLength(10);
    expect(new Set(terminal.map((e) => e.details?.request_id)).size).toBe(10);
    expect(events.filter((e) => e.type === "inference.queued")).toHaveLength(8);
  });

  it("sheds by default when there is no slot, keeps the body, and lets the member wait later", async () => {
    const db = openDb();
    const model = controllableFetch();
    const gate = makeGate(db, model.fetchImpl);

    const busy = [
      gate.run({ owner: "ada", caller: "test", request: request("a") }),
      gate.run({ owner: "ada", caller: "test", request: request("b") }),
    ];
    await settle();
    const shed = await gate.run({ owner: "bob", caller: "test", request: request("c") });
    expect(shed.kind).toBe("shed");
    if (shed.kind !== "shed") {
      throw new Error("expected shed");
    }
    expect(shed.status.message).toMatch(/GPU busy, 0 ahead of you/u);
    expect(shed.status.can_wait).toBe(true);
    expect(auditEvents(db).filter((e) => e.type === "inference.shed")).toHaveLength(1);
    // Nothing went to the model for the shed request.
    expect(model.pendingCount).toBe(2);

    // The member clicks "wait". The stored body is used; nothing is re-sent by the client.
    const waited = gate.wait("bob", shed.id);
    expect(waited?.state).toBe("queued");
    // A second click is a no-op that reports the current state.
    expect(gate.wait("bob", shed.id)?.state).toBe("queued");
    expect(auditEvents(db).filter((e) => e.type === "inference.waited")).toHaveLength(1);

    model.releaseAll();
    await Promise.all(busy);
    await settle();
    model.releaseAll();
    await settle();
    expect(gate.status("bob", shed.id)?.state).toBe("completed");
    expect(gate.result("bob", shed.id)?.text).toContain("ok");

    // One request, one body sent to the model, one terminal event.
    const allBodies = auditEvents(db).filter((e) => e.type === "inference.admitted");
    expect(allBodies.filter((e) => e.details?.request_id === shed.id)).toHaveLength(1);
    const terminal = auditEvents(db).filter(
      (e) => e.details?.request_id === shed.id && /completed|failed|expired/u.test(e.type),
    );
    expect(terminal).toHaveLength(1);
  });

  it("honors the member's always-wait preference without the caller asking", async () => {
    const db = openDb();
    const model = controllableFetch();
    const gate = makeGate(db, model.fetchImpl);
    gate.setPreferences("ada", { inference_always_wait: true });

    const busy = [
      gate.run({ owner: "x", caller: "test", request: request("a") }),
      gate.run({ owner: "x", caller: "test", request: request("b") }),
    ];
    await settle();
    const third = gate.run({ owner: "ada", caller: "test", request: request("c") });
    await settle();
    expect(gate.stats().queued).toBe(1);
    model.releaseAll();
    await Promise.all(busy);
    await settle();
    model.releaseAll();
    expect((await third).kind).toBe("completed");
  });

  it("sheds even an always-wait member once the line is at max depth", async () => {
    const db = openDb();
    const model = controllableFetch();
    const gate = makeGate(db, model.fetchImpl, { queue: { maxDepth: 1 } });

    void gate.run({ owner: "x", caller: "test", request: request("a") });
    void gate.run({ owner: "x", caller: "test", request: request("b") });
    await settle();
    void gate.run({ owner: "x", caller: "test", request: request("c"), wait: true });
    await settle();
    const overflow = await gate.run({ owner: "x", caller: "test", request: request("d"), wait: true });
    expect(overflow.kind).toBe("shed");
    if (overflow.kind === "shed") {
      expect(overflow.status.can_wait).toBe(false);
      expect(overflow.status.message).toMatch(/wait line is full/u);
      // And a wait click on it is refused, not queued.
      expect(gate.wait("x", overflow.id)?.state).toBe("shed");
    }
    model.releaseAll();
  });

  it("serves waiters in order: a fresh arrival does not take a slot ahead of the line", async () => {
    const db = openDb();
    const model = controllableFetch();
    const gate = makeGate(db, model.fetchImpl, { capacity: 1 });
    const order: string[] = [];
    const track = (label: string, p: Promise<InferenceOutcome>) =>
      p.then((o) => {
        order.push(label);
        return o;
      });

    const first = track("first", gate.run({ owner: "x", caller: "t", request: request("first") }));
    await settle();
    const second = track(
      "second",
      gate.run({ owner: "x", caller: "t", request: request("second"), wait: true }),
    );
    await settle();
    model.release(); // first finishes; second must be admitted, not a newcomer.
    await settle();
    const third = track("third", gate.run({ owner: "x", caller: "t", request: request("third"), wait: true }));
    await settle();
    model.release();
    await settle();
    model.release();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first", "second", "third"]);
  });
});

describe("inference gate timing", () => {
  it("starts the timeout at admission, not at arrival", async () => {
    // The incident: a request that waited 90s in line and then had 30s of a 120s budget left. Here
    // the timeout is shorter than the time spent waiting, and the request still completes.
    const db = openDb();
    const model = controllableFetch();
    const gate = makeGate(db, model.fetchImpl);

    void gate.run({ owner: "x", caller: "t", request: request("a") });
    void gate.run({ owner: "x", caller: "t", request: request("b") });
    await settle();
    const queued = gate.run({
      owner: "x",
      caller: "t",
      request: request("c"),
      wait: true,
      timeoutMs: 40,
    });
    // Waits longer than its whole timeout budget.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(gate.stats().queued).toBe(1);
    model.releaseAll();
    await settle();
    model.releaseAll();
    const outcome = await queued;
    expect(outcome.kind).toBe("completed");
  });

  it("times out a call that the model never answers, once admitted", async () => {
    const db = openDb();
    const hang: InferenceFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const gate = makeGate(db, hang);
    const outcome = await gate.run({ owner: "x", caller: "t", request: request("a"), timeoutMs: 20 });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.failure).toBe("timeout");
    }
    expect(gate.stats().in_flight).toBe(0);
    expect(auditEvents(db).filter((e) => e.type === "inference.failed")).toHaveLength(1);
  });

  it("honors the caller's cancellation while queued, releasing the row", async () => {
    const db = openDb();
    const model = controllableFetch();
    const gate = makeGate(db, model.fetchImpl);
    void gate.run({ owner: "x", caller: "t", request: request("a") });
    void gate.run({ owner: "x", caller: "t", request: request("b") });
    await settle();
    const controller = new AbortController();
    const queued = gate.run({
      owner: "x",
      caller: "t",
      request: request("c"),
      wait: true,
      signal: controller.signal,
    });
    await settle();
    controller.abort();
    const outcome = await queued;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.failure).toBe("cancelled");
    }
    expect(gate.stats().queued).toBe(0);
    model.releaseAll();
  });
});

describe("inference gate durability", () => {
  it("dedupes a retry with the same submission key onto the same row and the same model call", async () => {
    const db = openDb();
    const model = controllableFetch();
    const gate = makeGate(db, model.fetchImpl);
    const first = gate.run({ owner: "ada", caller: "t", request: request("a"), submissionKey: "k1" });
    await settle();
    // The response was lost; the client sends the same thing again.
    const retry = gate.run({ owner: "ada", caller: "t", request: request("a"), submissionKey: "k1" });
    await settle();
    expect(model.pendingCount).toBe(1);
    model.releaseAll();
    const [a, b] = await Promise.all([first, retry]);
    expect(a.kind).toBe("completed");
    expect(b.kind).toBe("completed");
    if (a.kind === "completed" && b.kind === "completed") {
      expect(a.id).toBe(b.id);
    }
    // And after completion, the same key still finds the stored answer without a model call.
    const again = await gate.run({ owner: "ada", caller: "t", request: request("a"), submissionKey: "k1" });
    expect(again.kind).toBe("completed");
    expect(model.pendingCount).toBe(0);
    expect(auditEvents(db).filter((e) => e.type === "inference.completed")).toHaveLength(1);
  });

  it("reports a conflict when the same key arrives with a different payload", async () => {
    const db = openDb();
    const model = controllableFetch();
    const gate = makeGate(db, model.fetchImpl);
    const first = gate.run({ owner: "ada", caller: "t", request: request("a"), submissionKey: "k" });
    await settle();
    const other = await gate.run({ owner: "ada", caller: "t", request: request("b"), submissionKey: "k" });
    expect(other.kind).toBe("conflict");
    // Keys are scoped to the owner: somebody else's identical key is their own request.
    const bob = gate.run({ owner: "bob", caller: "t", request: request("b"), submissionKey: "k" });
    await settle();
    expect(model.pendingCount).toBe(2);
    model.releaseAll();
    await Promise.all([first, bob]);
  });

  it("expires queued rows past max age instead of admitting them, and says resubmit", async () => {
    const db = openDb();
    const model = controllableFetch();
    let clock = Date.parse("2026-09-12T10:00:00Z");
    const gate = makeGate(db, model.fetchImpl, { queue: { maxAgeMs: 1000 } }, { now: () => new Date(clock) });
    void gate.run({ owner: "x", caller: "t", request: request("a") });
    void gate.run({ owner: "x", caller: "t", request: request("b") });
    await settle();
    const stale = gate.run({ owner: "x", caller: "t", request: request("c"), wait: true });
    await settle();
    clock += 5000;
    const swept = gate.sweep();
    expect(swept.expired).toBe(1);
    const outcome = await stale;
    expect(outcome.kind).toBe("expired");
    if (outcome.kind === "expired") {
      expect(outcome.status.message).toMatch(/Resubmit/u);
    }
    expect(auditEvents(db).filter((e) => e.type === "inference.expired")).toHaveLength(1);
    model.releaseAll();
  });

  it("re-admits unexpired queued rows after a restart and expires the rest", async () => {
    const db = openDb();
    const model = controllableFetch();
    let clock = Date.parse("2026-09-12T10:00:00Z");
    const first = makeGate(db, model.fetchImpl, { queue: { maxAgeMs: 60_000 } }, { now: () => new Date(clock) });
    void first.run({ owner: "x", caller: "t", request: request("a") });
    void first.run({ owner: "x", caller: "t", request: request("b") });
    await settle();
    void first.run({ owner: "x", caller: "t", request: request("old"), wait: true });
    clock += 30_000;
    void first.run({ owner: "x", caller: "t", request: request("fresh"), wait: true });
    await settle();
    // "Process dies": the gate object is dropped without finishing anything. Rows a and b are still
    // `running` in the database; old and fresh are `queued`.
    first.close();
    clock += 40_000; // old is now 70s in line: past max age. fresh is 40s: within it.

    const model2 = controllableFetch();
    const second = makeGate(db, model2.fetchImpl, { queue: { maxAgeMs: 60_000 } }, { now: () => new Date(clock) });
    const recovered = second.start();
    expect(recovered).toEqual({ interrupted: 2, expired: 1, readmitted: 1 });
    await settle();
    expect(model2.pendingCount).toBe(1);
    model2.releaseAll();
    await settle();

    const events = auditEvents(db);
    const interrupted = events.filter(
      (e) => e.type === "inference.failed" && e.details?.outcome === "interrupted",
    );
    expect(interrupted).toHaveLength(2);
    // Names the claim so an operator can tell a restart from a hung model.
    expect(interrupted[0]?.details?.claimed_by).toBe(first.processId);
    expect(interrupted[0]?.details?.claimed_at).toBeTruthy();
    expect(events.filter((e) => e.type === "inference.expired")).toHaveLength(1);
    expect(events.filter((e) => e.type === "inference.completed")).toHaveLength(1);
    // Every one of the four rows has exactly one terminal event.
    const terminal = events.filter((e) => /completed|failed|expired/u.test(e.type));
    expect(terminal).toHaveLength(4);
    expect(new Set(terminal.map((e) => e.details?.request_id)).size).toBe(4);
  });

  it("strips bodies from finished rows after the retention window but keeps their status", async () => {
    const db = openDb();
    const model = controllableFetch();
    let clock = Date.parse("2026-09-12T10:00:00Z");
    const gate = makeGate(db, model.fetchImpl, { queue: { retentionMs: 1000 } }, { now: () => new Date(clock) });
    const run = gate.run({ owner: "ada", caller: "t", request: request("a") });
    await settle();
    model.releaseAll();
    const done = await run;
    expect(done.kind).toBe("completed");
    expect(gate.result("ada", done.id)).toBeDefined();
    clock += 5000;
    expect(gate.sweep().purged).toBe(1);
    expect(gate.result("ada", done.id)).toBeUndefined();
    expect(gate.status("ada", done.id)?.state).toBe("completed");
    expect(gate.stats().retained_bytes).toBe(0);
  });

  it("refuses, without storing, a body over the payload cap", async () => {
    const db = openDb();
    const model = controllableFetch();
    const gate = makeGate(db, model.fetchImpl, { queue: { maxPayloadBytes: 100 } });
    const outcome = await gate.run({ owner: "x", caller: "t", request: request("x".repeat(200)) });
    expect(outcome.kind).toBe("refused");
    expect(gate.stats().rows.queued + gate.stats().rows.shed + gate.stats().rows.running).toBe(0);
    expect(auditEvents(db).filter((e) => e.type === "inference.refused")).toHaveLength(1);
  });
});

describe("inference gate ownership", () => {
  it("hides another member's row completely: status, result, wait and list", async () => {
    const db = openDb();
    const model = controllableFetch();
    const gate = makeGate(db, model.fetchImpl);
    void gate.run({ owner: "x", caller: "t", request: request("a") });
    void gate.run({ owner: "x", caller: "t", request: request("b") });
    await settle();
    const shed = await gate.run({ owner: "ada", caller: "t", request: request("private cv") });
    expect(shed.kind).toBe("shed");
    if (shed.kind !== "shed") {
      throw new Error("expected shed");
    }
    expect(gate.status("mallory", shed.id)).toBeUndefined();
    expect(gate.result("mallory", shed.id)).toBeUndefined();
    expect(gate.wait("mallory", shed.id)).toBeUndefined();
    expect(gate.listForOwner("mallory")).toEqual([]);
    // Still shed: the wrong-owner wait did nothing.
    expect(gate.status("ada", shed.id)?.state).toBe("shed");
    model.releaseAll();
  });
});

describe("runGated", () => {
  it("turns a queue decision into an InferenceDeferredError and never a retry", async () => {
    const db = openDb();
    const model = controllableFetch();
    const gate = makeGate(db, model.fetchImpl);
    void gate.run({ owner: "x", caller: "t", request: request("a") });
    void gate.run({ owner: "x", caller: "t", request: request("b") });
    await settle();
    await expect(
      runGated(gate, { owner: "ada", caller: "t", request: request("c") }),
    ).rejects.toBeInstanceOf(InferenceDeferredError);
    expect(model.pendingCount).toBe(2);
    model.releaseAll();
  });

  it("hands back non-2xx responses as responses, so callers keep their own error wording", async () => {
    const db = openDb();
    const fetchImpl: InferenceFetch = async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => "busy",
    });
    const gate = makeGate(db, fetchImpl);
    const response = await runGated(gate, { owner: "x", caller: "t", request: request("a") });
    expect(response.status).toBe(503);
    const failed = auditEvents(db).filter((e) => e.type === "inference.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.details?.outcome).toBe("http_503");
  });

  it("rethrows the transport error itself for a refused connection", async () => {
    const db = openDb();
    const fetchImpl: InferenceFetch = async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
    };
    const gate = makeGate(db, fetchImpl);
    await expect(runGated(gate, { owner: "x", caller: "t", request: request("a") })).rejects.toThrow(
      "fetch failed",
    );
  });
});

describe("inference gate escalation", () => {
  it("fires each trigger once while it holds, proposes through the callback, and records the proposal", async () => {
    const db = openDb();
    const model = controllableFetch();
    const onEscalate = vi.fn(async () => ({ proposal_id: "act_1" }));
    const alert = vi.fn();
    const gate = makeGate(
      db,
      model.fetchImpl,
      { escalate: { queueDepth: 1 } },
      { onEscalate, alert },
    );
    void gate.run({ owner: "x", caller: "t", request: request("a") });
    void gate.run({ owner: "x", caller: "t", request: request("b") });
    await settle();
    void gate.run({ owner: "x", caller: "t", request: request("c"), wait: true });
    void gate.run({ owner: "x", caller: "t", request: request("d"), wait: true });
    await settle();
    gate.sweep();
    await settle();
    gate.sweep();
    await settle();
    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    const proposed = auditEvents(db).filter((e) => e.type === "inference.escalation_proposed");
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.action_id).toBe("act_1");
    expect(proposed[0]?.details?.trigger).toBe("queue_depth");
    // Nothing claims delivery: `inference.escalated` waits for the connector.
    expect(auditEvents(db).filter((e) => e.type === "inference.escalated")).toHaveLength(0);
    // Members in line see that help was asked for.
    const status = gate.listForOwner("x")[0];
    expect(status?.escalation?.awaiting_approval).toBe(true);
    model.releaseAll();
  });

  it("marks health down after repeated probe failures and drops the wait estimate", async () => {
    const db = openDb();
    const fetchImpl: InferenceFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const gate = makeGate(db, fetchImpl, { health: { failureThreshold: 2 } });
    await gate.probeHealth();
    expect(gate.stats().health.state).toBe("degraded");
    await gate.probeHealth();
    expect(gate.stats().health.state).toBe("down");
    expect(gate.stats().escalations_armed).toContain("health");
  });
});

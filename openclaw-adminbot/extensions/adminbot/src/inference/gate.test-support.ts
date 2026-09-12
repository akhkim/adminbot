/**
 * A gate that is already full, for the tests that prove each caller honors a queue decision.
 *
 * The property under test is the same everywhere: when the gate says "shed", the caller must make
 * zero further model calls -- no retry, no fallback -- and must surface the decision rather than an
 * outage. Every caller has its own catch blocks that could quietly break that, so every caller gets
 * its own test, built on this.
 */
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { resolveInferenceGateConfig } from "./config.js";
import { createInferenceGate, type InferenceGate } from "./gate.js";

export function openInferenceTestDb(): DatabaseSync {
  const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS adminbot_audit_events (
    id TEXT PRIMARY KEY, action_id TEXT, event_type TEXT NOT NULL,
    timestamp TEXT NOT NULL, actor TEXT, event_json TEXT NOT NULL
  )`);
  return db;
}

/**
 * A gate of capacity one with one request parked in its only slot forever. Every arrival after that
 * is shed (the line has depth zero), so a caller's whole behavior under "no slot" is observable from
 * how many times its own fetch was invoked: the parked request used a different fetch.
 */
export function createSaturatedGate(): { gate: InferenceGate; release: () => void } {
  const db = openInferenceTestDb();
  const gate = createInferenceGate({
    db,
    env: {},
    config: resolveInferenceGateConfig(
      {},
      {
        capacity: 1,
        queue: { maxDepth: 0, sweepIntervalMs: 0 },
        health: { intervalMs: 0 },
      },
    ),
  });
  let release: () => void = () => {};
  void gate.run({
    owner: "system:test-occupant",
    caller: "test.occupant",
    request: {
      route: "chat/completions",
      baseUrl: "http://127.0.0.1:8000/v1",
      body: { model: "m", messages: [] },
      purpose: "occupant",
    },
    fetchImpl: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ ok: true, status: 200, statusText: "OK", text: async () => "{}" });
      }),
  });
  return {
    gate,
    release: () => {
      release();
      gate.close();
    },
  };
}

/** Lets the parked request reach the gate before the test's own call arrives. */
export const settleMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 2));

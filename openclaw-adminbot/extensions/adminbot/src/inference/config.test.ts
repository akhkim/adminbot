import { describe, expect, it } from "vitest";
import { DEFAULT_INFERENCE_GATE_CONFIG, resolveInferenceGateConfig } from "./config.js";
import { inferenceTestConfig, type InferenceConfigOverrides } from "./config.test-support.js";
import { createInferenceGate } from "./gate.js";

describe("inference deployment configuration", () => {
  it("requires explicit opt-in for cross-restart inference persistence", () => {
    expect(resolveInferenceGateConfig({}).persistAcrossRestarts).toBe(false);
    expect(resolveInferenceGateConfig({ ADMINBOT_INFERENCE_PERSIST_ACROSS_RESTARTS: "true" }).persistAcrossRestarts).toBe(true);
  });
  it("retains defaults and legacy concurrency, with the dedicated variable taking priority", () => {
    expect(resolveInferenceGateConfig({})).toEqual(DEFAULT_INFERENCE_GATE_CONFIG);
    expect(resolveInferenceGateConfig({ ADMINBOT_WORKSHOP_MATCH_CONCURRENCY: "4" }).capacity).toBe(
      4,
    );
    expect(
      resolveInferenceGateConfig({
        ADMINBOT_WORKSHOP_MATCH_CONCURRENCY: "4",
        ADMINBOT_INFERENCE_CAPACITY: "3",
      }).capacity,
    ).toBe(3);
  });

  it.each(["", "no", "NaN", "Infinity", "-1", "0", "1.5", "9007199254740992"])(
    "falls back for invalid positive integer env values: %s",
    (value) => {
      const config = resolveInferenceGateConfig({
        ADMINBOT_INFERENCE_CAPACITY: value,
        ADMINBOT_INFERENCE_DEFAULT_TIMEOUT_MS: value,
        ADMINBOT_INFERENCE_HEALTH_TIMEOUT_MS: value,
      });
      expect(config.capacity).toBe(DEFAULT_INFERENCE_GATE_CONFIG.capacity);
      expect(config.defaultTimeoutMs).toBe(DEFAULT_INFERENCE_GATE_CONFIG.defaultTimeoutMs);
      expect(config.health.timeoutMs).toBe(DEFAULT_INFERENCE_GATE_CONFIG.health.timeoutMs);
    },
  );

  it("rejects overflowing env timers and fractional counts without rounding", () => {
    const config = resolveInferenceGateConfig({
      ADMINBOT_INFERENCE_DEFAULT_TIMEOUT_MS: "2147483648",
      ADMINBOT_INFERENCE_SHUTDOWN_GRACE_MS: "2147483648",
      ADMINBOT_INFERENCE_QUEUE_SWEEP_INTERVAL_MS: "2147483648",
      ADMINBOT_INFERENCE_HEALTH_INTERVAL_MS: "2147483648",
      ADMINBOT_INFERENCE_HEALTH_TIMEOUT_MS: "2147483648",
      ADMINBOT_INFERENCE_QUEUE_MAX_DEPTH: "0.5",
      ADMINBOT_INFERENCE_QUEUE_MAX_PAYLOAD_BYTES: "0.5",
    });
    expect(config).toEqual(DEFAULT_INFERENCE_GATE_CONFIG);
  });

  it("preserves meaningful zero values", () => {
    const config = resolveInferenceGateConfig({
      ADMINBOT_INFERENCE_SHUTDOWN_GRACE_MS: "0",
      ADMINBOT_INFERENCE_QUEUE_MAX_DEPTH: "0",
      ADMINBOT_INFERENCE_QUEUE_SWEEP_INTERVAL_MS: "0",
      ADMINBOT_INFERENCE_HEALTH_INTERVAL_MS: "0",
    });
    expect(config.shutdownGraceMs).toBe(0);
    expect(config.queue.maxDepth).toBe(0);
    expect(config.queue.sweepIntervalMs).toBe(0);
    expect(config.health.intervalMs).toBe(0);
    const gate = createInferenceGate({ config, env: {} });
    gate.close();
  });
});

describe("direct gate configuration", () => {
  const cases: Array<[string, InferenceConfigOverrides]> = [
    ["capacity", { capacity: 0 }],
    ["capacity", { capacity: 1.5 }],
    ["capacity", { capacity: Number.NaN }],
    ["defaultTimeoutMs", { defaultTimeoutMs: 0 }],
    ["defaultTimeoutMs", { defaultTimeoutMs: 1.5 }],
    ["defaultTimeoutMs", { defaultTimeoutMs: 2_147_483_648 }],
    ["shutdownGraceMs", { shutdownGraceMs: -1 }],
    ["shutdownGraceMs", { shutdownGraceMs: 2_147_483_648 }],
    ["queue.maxDepth", { queue: { maxDepth: -1 } }],
    ["queue.maxAgeMs", { queue: { maxAgeMs: Infinity } }],
    ["queue.retentionMs", { queue: { retentionMs: -1 } }],
    ["queue.maxPayloadBytes", { queue: { maxPayloadBytes: 1.5 } }],
    ["queue.maxRetainedBytes", { queue: { maxRetainedBytes: Infinity } }],
    ["queue.sweepIntervalMs", { queue: { sweepIntervalMs: 2_147_483_648 } }],
    ["health.intervalMs", { health: { intervalMs: 2_147_483_648 } }],
    ["health.timeoutMs", { health: { timeoutMs: 0 } }],
    ["health.timeoutMs", { health: { timeoutMs: 2_147_483_648 } }],
    ["health.failureThreshold", { health: { failureThreshold: 0 } }],
    ["health.staleAfterMs", { health: { staleAfterMs: -1 } }],
    ["escalate.queueAgeMs", { escalate: { queueAgeMs: -1 } }],
    ["escalate.queueDepth", { escalate: { queueDepth: 1.5 } }],
    ["escalate.healthFailures", { escalate: { healthFailures: 0 } }],
  ];
  it.each(cases)("rejects invalid %s before initializing persistence", (name, overrides) => {
    expect(() => createInferenceGate({ config: inferenceTestConfig(overrides), env: {} })).toThrow(
      name,
    );
  });
});

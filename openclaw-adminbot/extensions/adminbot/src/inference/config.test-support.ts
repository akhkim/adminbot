import { DEFAULT_INFERENCE_GATE_CONFIG, type InferenceGateConfig } from "./config.js";

export type InferenceConfigOverrides = Partial<
  Omit<InferenceGateConfig, "queue" | "health" | "escalate">
> & {
  queue?: Partial<InferenceGateConfig["queue"]>;
  health?: Partial<InferenceGateConfig["health"]>;
  escalate?: Partial<InferenceGateConfig["escalate"]>;
};

export function inferenceTestConfig(overrides: InferenceConfigOverrides = {}): InferenceGateConfig {
  const defaults = DEFAULT_INFERENCE_GATE_CONFIG;
  return {
    ...defaults,
    ...overrides,
    queue: { ...defaults.queue, sweepIntervalMs: 0, ...overrides.queue },
    health: { ...defaults.health, intervalMs: 0, ...overrides.health },
    escalate: { ...defaults.escalate, ...overrides.escalate },
  };
}

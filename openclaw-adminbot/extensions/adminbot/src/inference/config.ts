/**
 * Knobs for the shared inference gate, read from the environment.
 *
 * Environment rather than `AdminBotSettings`, on the precedent of ADMINBOT_WORKSHOP_MATCH_CONCURRENCY
 * and ADMINBOT_LOCAL_BASE_URL: every value here describes the GPU deployment the service is sitting
 * in front of -- how many sequences vLLM admits, how long a body may wait for it, how many failed
 * health probes mean it is gone -- and that is decided by whoever runs the unit, at deploy time, in
 * the same file that sets the model URL. `AdminBotSettings` is lab policy an administrator edits in
 * the UI (who the head professor is, where reimbursements go); a capacity figure there would let a
 * settings edit quietly oversubscribe the GPU and reproduce the incident this module exists to stop.
 */

export type InferenceGateConfig = {
  /** Requests in flight to the local model. Anything past this queues here, not inside vLLM. */
  capacity: number;
  /** The model's time budget once admitted, for callers that do not name their own. */
  defaultTimeoutMs: number;
  queue: {
    /** Waiting rows past this are shed even for members who asked to always wait. */
    maxDepth: number;
    /** A request older than this is never admitted; it expires with a "resubmit" status. */
    maxAgeMs: number;
    /** How long a finished row keeps its request and result bodies before the sweep strips them. */
    retentionMs: number;
    /** How often the sweep runs. */
    sweepIntervalMs: number;
    /** Largest request body the queue will store. Over it, the request is refused, not preserved. */
    maxPayloadBytes: number;
    /** Ceiling on request plus result bytes held across every row, shed rows included. */
    maxRetainedBytes: number;
  };
  health: {
    /** How often GET /v1/models is probed. Zero disables the probe. */
    intervalMs: number;
    /** How long one probe may take before it counts as a failure. */
    timeoutMs: number;
    /** Consecutive probe failures before the server is considered down. */
    failureThreshold: number;
    /** With no completion for this long while work is in flight, health is degraded. */
    staleAfterMs: number;
  };
  escalate: {
    /** Oldest waiting request past this age fires an escalation. */
    queueAgeMs: number;
    /** Waiting depth past this fires an escalation. */
    queueDepth: number;
    /** Consecutive health failures past this fire an escalation. */
    healthFailures: number;
  };
};

/**
 * Two, because that is what the server admits: Aurora's vLLM runs with `--max-num-seqs 2`
 * (deploy/aurora/setup-qwen35-vllm.sh). More than two in flight does not run faster; it queues
 * inside vLLM with the timeout already ticking, which is the recorded incident.
 */
export const DEFAULT_INFERENCE_CAPACITY = 2;

export const DEFAULT_INFERENCE_GATE_CONFIG: InferenceGateConfig = {
  capacity: DEFAULT_INFERENCE_CAPACITY,
  // The matcher's first-attempt budget, which is the longest any caller here has needed.
  defaultTimeoutMs: 120_000,
  queue: {
    // Sixteen per slot. A deeper line is minutes of waiting at the model's real latency, and a
    // member told "32 ahead of you" is better served by "try later" than by a place in it.
    maxDepth: 32,
    maxAgeMs: 60 * 60 * 1000,
    // Bodies are CVs, receipts and private tasks. They stay only as long as a member could plausibly
    // still come back for the answer; the row's status metadata stays after.
    retentionMs: 60 * 60 * 1000,
    sweepIntervalMs: 30 * 1000,
    // A reimbursement turn carries up to twenty receipt page images inline as base64.
    maxPayloadBytes: 16 * 1024 * 1024,
    maxRetainedBytes: 256 * 1024 * 1024,
  },
  health: {
    intervalMs: 15 * 1000,
    timeoutMs: 5 * 1000,
    failureThreshold: 3,
    // Longer than the longest single call the matcher allows (360s on its third attempt), so a slow
    // answer is not mistaken for a hung server.
    staleAfterMs: 6 * 60 * 1000,
  },
  escalate: {
    queueAgeMs: 5 * 60 * 1000,
    queueDepth: 16,
    healthFailures: 3,
  },
};

const ENV_PREFIX = "ADMINBOT_INFERENCE_";

/**
 * The configured gate, from `ADMINBOT_INFERENCE_*` with the defaults above underneath.
 *
 * ADMINBOT_WORKSHOP_MATCH_CONCURRENCY is honored as the capacity when the newer variable is unset,
 * because a deployment that raised it did so for the reason this gate exists and should not have to
 * learn a second name for the same number.
 */
export function resolveInferenceGateConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: DeepPartial<InferenceGateConfig> = {},
): InferenceGateConfig {
  const read = (suffix: string, fallback: number, minimum = 0): number => {
    const raw = env[`${ENV_PREFIX}${suffix}`];
    const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
  };
  const legacyConcurrency = Number(env.ADMINBOT_WORKSHOP_MATCH_CONCURRENCY);
  const capacityFallback =
    Number.isInteger(legacyConcurrency) && legacyConcurrency > 0
      ? legacyConcurrency
      : DEFAULT_INFERENCE_GATE_CONFIG.capacity;
  const defaults = DEFAULT_INFERENCE_GATE_CONFIG;
  const resolved: InferenceGateConfig = {
    capacity: Math.max(1, Math.floor(read("CAPACITY", capacityFallback, 1))),
    defaultTimeoutMs: read("DEFAULT_TIMEOUT_MS", defaults.defaultTimeoutMs, 1),
    queue: {
      maxDepth: Math.floor(read("QUEUE_MAX_DEPTH", defaults.queue.maxDepth)),
      maxAgeMs: read("QUEUE_MAX_AGE_MS", defaults.queue.maxAgeMs),
      retentionMs: read("QUEUE_RETENTION_MS", defaults.queue.retentionMs),
      sweepIntervalMs: read("QUEUE_SWEEP_INTERVAL_MS", defaults.queue.sweepIntervalMs),
      maxPayloadBytes: read("QUEUE_MAX_PAYLOAD_BYTES", defaults.queue.maxPayloadBytes),
      maxRetainedBytes: read("QUEUE_MAX_RETAINED_BYTES", defaults.queue.maxRetainedBytes),
    },
    health: {
      intervalMs: read("HEALTH_INTERVAL_MS", defaults.health.intervalMs),
      timeoutMs: read("HEALTH_TIMEOUT_MS", defaults.health.timeoutMs, 1),
      failureThreshold: Math.max(
        1,
        Math.floor(read("HEALTH_FAILURE_THRESHOLD", defaults.health.failureThreshold, 1)),
      ),
      staleAfterMs: read("HEALTH_STALE_AFTER_MS", defaults.health.staleAfterMs),
    },
    escalate: {
      queueAgeMs: read("ESCALATE_QUEUE_AGE_MS", defaults.escalate.queueAgeMs),
      queueDepth: Math.floor(read("ESCALATE_QUEUE_DEPTH", defaults.escalate.queueDepth)),
      healthFailures: Math.max(
        1,
        Math.floor(read("ESCALATE_HEALTH_FAILURES", defaults.escalate.healthFailures, 1)),
      ),
    },
  };
  return {
    ...resolved,
    ...(overrides.capacity !== undefined ? { capacity: Math.max(1, overrides.capacity) } : {}),
    ...(overrides.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: Math.max(1, overrides.defaultTimeoutMs) }
      : {}),
    queue: { ...resolved.queue, ...stripUndefined(overrides.queue) },
    health: { ...resolved.health, ...stripUndefined(overrides.health) },
    escalate: { ...resolved.escalate, ...stripUndefined(overrides.escalate) },
  };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

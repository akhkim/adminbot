/**
 * Deployment settings for the shared inference gate. Environment variables follow the
 * existing model URL and concurrency configuration; member wait preferences live in SQLite.
 */

export type InferenceGateConfig = {
  /** Opt-in persistence: the service runner recovers tasks; standalone gates recover model calls. */
  persistAcrossRestarts: boolean;
  startPaused: boolean;
  shutdownGraceMs: number;
  /** Requests in flight to the local model. Anything past this queues here, not inside vLLM. */
  capacity: number;
  /** The model's time budget once admitted, for callers that do not name their own. */
  defaultTimeoutMs: number;
  queue: {
    /** Waiting rows past this are shed even for members who asked to always wait. */
    maxDepth: number;
    /**
     * One owner's share of the waiting line, counting their queued and running tasks. Past it a
     * task is shed rather than refused, so the owner keeps a row and a Wait. Service and system
     * owners share a single identity each, so this bounds a fleet, not one agent.
     */
    maxPerOwner: number;
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

/** Matches the deployment script's vLLM --max-num-seqs 2. */
export const DEFAULT_INFERENCE_CAPACITY = 2;

export const DEFAULT_INFERENCE_GATE_CONFIG: InferenceGateConfig = {
  persistAcrossRestarts: false,
  startPaused: false,
  // Allow admitted work up to six minutes to finish during shutdown.
  shutdownGraceMs: 360_000,
  capacity: DEFAULT_INFERENCE_CAPACITY,
  // The matcher's first-attempt budget, which is the longest any caller here has needed.
  defaultTimeoutMs: 120_000,
  queue: {
    // Sixteen per slot. A deeper line is minutes of waiting at the model's real latency, and a
    // member told "32 ahead of you" is better served by "try later" than by a place in it.
    maxDepth: 32,
    // Eight owners can hold a share each before the line is full, which is the mix a roster of
    // this size produces. A member with a fifth question is told to wait, not turned away.
    maxPerOwner: 4,
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
const MAX_TIMER_MS = 2_147_483_647;

/** Read deployment settings, retaining the legacy matcher concurrency fallback. */
export function resolveInferenceGateConfig(
  env: NodeJS.ProcessEnv = process.env,
): InferenceGateConfig {
  const read = (
    suffix: string,
    fallback: number,
    minimum = 0,
    maximum = Number.MAX_SAFE_INTEGER,
  ): number => {
    const raw = env[`${ENV_PREFIX}${suffix}`];
    const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
      ? parsed
      : fallback;
  };
  const timer = (suffix: string, fallback: number, minimum = 0): number =>
    read(suffix, fallback, minimum, MAX_TIMER_MS);
  const defaults = DEFAULT_INFERENCE_GATE_CONFIG;
  const legacyConcurrency = Number(env.ADMINBOT_WORKSHOP_MATCH_CONCURRENCY);
  const capacityFallback =
    Number.isSafeInteger(legacyConcurrency) && legacyConcurrency > 0
      ? legacyConcurrency
      : defaults.capacity;
  return {
    persistAcrossRestarts: /^(1|true)$/iu.test(
      env.ADMINBOT_INFERENCE_PERSIST_ACROSS_RESTARTS?.trim() ?? "",
    ),
    startPaused: /^(1|true)$/iu.test(env.ADMINBOT_INFERENCE_START_PAUSED?.trim() ?? ""),
    shutdownGraceMs: timer("SHUTDOWN_GRACE_MS", defaults.shutdownGraceMs),
    capacity: read("CAPACITY", capacityFallback, 1),
    defaultTimeoutMs: timer("DEFAULT_TIMEOUT_MS", defaults.defaultTimeoutMs, 1),
    queue: {
      maxDepth: read("QUEUE_MAX_DEPTH", defaults.queue.maxDepth),
      maxPerOwner: read("QUEUE_MAX_PER_OWNER", defaults.queue.maxPerOwner, 1),
      maxAgeMs: read("QUEUE_MAX_AGE_MS", defaults.queue.maxAgeMs),
      retentionMs: read("QUEUE_RETENTION_MS", defaults.queue.retentionMs),
      sweepIntervalMs: timer("QUEUE_SWEEP_INTERVAL_MS", defaults.queue.sweepIntervalMs),
      maxPayloadBytes: read("QUEUE_MAX_PAYLOAD_BYTES", defaults.queue.maxPayloadBytes),
      maxRetainedBytes: read("QUEUE_MAX_RETAINED_BYTES", defaults.queue.maxRetainedBytes),
    },
    health: {
      intervalMs: timer("HEALTH_INTERVAL_MS", defaults.health.intervalMs),
      timeoutMs: timer("HEALTH_TIMEOUT_MS", defaults.health.timeoutMs, 1),
      failureThreshold: read("HEALTH_FAILURE_THRESHOLD", defaults.health.failureThreshold, 1),
      staleAfterMs: read("HEALTH_STALE_AFTER_MS", defaults.health.staleAfterMs),
    },
    escalate: {
      queueAgeMs: read("ESCALATE_QUEUE_AGE_MS", defaults.escalate.queueAgeMs),
      queueDepth: read("ESCALATE_QUEUE_DEPTH", defaults.escalate.queueDepth),
      healthFailures: read("ESCALATE_HEALTH_FAILURES", defaults.escalate.healthFailures, 1),
    },
  };
}

/** Direct callers supply complete configs; reject invalid limits before opening the gate. */
export function validateInferenceGateConfig(config: InferenceGateConfig): void {
  const integer = (name: string, value: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(
        `Inference gate ${name} must be an integer from ${minimum} to ${maximum}`,
      );
    }
  };
  if (typeof config.persistAcrossRestarts !== "boolean") {
    throw new TypeError("Inference gate persistAcrossRestarts must be a boolean");
  }
  if (typeof config.startPaused !== "boolean") {
    throw new TypeError("Inference gate startPaused must be a boolean");
  }
  integer("capacity", config.capacity, 1);
  integer("shutdownGraceMs", config.shutdownGraceMs, 0, MAX_TIMER_MS);
  integer("defaultTimeoutMs", config.defaultTimeoutMs, 1, MAX_TIMER_MS);
  integer("queue.maxPerOwner", config.queue.maxPerOwner, 1);
  for (const key of [
    "maxDepth",
    "maxAgeMs",
    "retentionMs",
    "maxPayloadBytes",
    "maxRetainedBytes",
  ] as const) {
    integer(`queue.${key}`, config.queue[key]);
  }
  integer("queue.sweepIntervalMs", config.queue.sweepIntervalMs, 0, MAX_TIMER_MS);
  integer("health.intervalMs", config.health.intervalMs, 0, MAX_TIMER_MS);
  integer("health.timeoutMs", config.health.timeoutMs, 1, MAX_TIMER_MS);
  integer("health.failureThreshold", config.health.failureThreshold, 1);
  integer("health.staleAfterMs", config.health.staleAfterMs);
  integer("escalate.queueAgeMs", config.escalate.queueAgeMs);
  integer("escalate.queueDepth", config.escalate.queueDepth);
  integer("escalate.healthFailures", config.escalate.healthFailures, 1);
}

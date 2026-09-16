import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
/**
 * Shared admission control for local inference. Each permit covers one HTTP call through
 * response-body consumption; workflow stages acquire separate permits to avoid deadlocks.
 * Timeouts start after admission. Caller cancellation also applies while queued.
 *
 * Requests are persisted before dispatch or shedding. Shed requests can later join the FIFO
 * queue. Owner-scoped submission keys deduplicate retries while their rows retain bodies.
 * Queue decisions must propagate through callers without triggering fallback or retry.
 */
import {
  currentTaskContext,
  currentTaskScope,
  currentTaskStepAttempt,
  taskStep,
} from "../tasks/context.js";
import {
  DEFAULT_INFERENCE_GATE_CONFIG,
  validateInferenceGateConfig,
  type InferenceGateConfig,
} from "./config.js";
import {
  InferenceQueueStore,
  type InferenceFailureKind,
  type InferenceQueueRow,
  type InferenceRequestRecord,
  type InferenceResponseRecord,
  type InferenceRowStatus,
  type InferenceStage,
  type MemberInferencePreferences,
} from "./queue-store.js";

export type { InferenceRequestRecord, InferenceResponseRecord, InferenceRowStatus, InferenceStage };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Validate the endpoint at dispatch. `purpose` identifies the caller in configuration errors. */
export function assertLoopbackUrl(value: string, purpose: string): string {
  const url = new URL(value.endsWith("/") ? value : `${value}/`);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${purpose} must use a loopback URL, got ${url.hostname}`);
  }
  return url.toString();
}

export type InferenceFetch = (
  input: string,
  init: {
    method: "POST" | "GET";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: "error";
  },
) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

export type InferenceGateRequest = {
  /** Who this request belongs to: a member id, or `system:<job>` for unattended work. */
  owner: string;
  /** Which code path sent it, for the audit trail: `privacy_broker.classify`, `cv_scan.extract`. */
  caller: string;
  /** For multi-step callers: which step of which task this is. See InferenceStage. */
  stage?: InferenceStage;
  request: InferenceRequestRecord;
  /**
   * A stable key the owner chose, so a retry after a lost response finds this row rather than
   * making another. Bound to the payload hash: the same key with a different payload is a conflict.
   * Absent, the request gets a fresh key and no retry can find it -- right for in-process callers
   * that hold the promise, wrong for an HTTP client, which should always send one.
   */
  submissionKey?: string;
  /** How long the model may take once admitted. Not how long the request may wait. */
  timeoutMs?: number;
  /** The caller's cancellation. Honored while queued as well as while running. */
  signal?: AbortSignal;
  /** Wait for a slot rather than being shed. Overrides the member's stored preference when set. */
  wait?: boolean;
  /** Transport for this request. Tests inject theirs; production leaves it to the gate. */
  fetchImpl?: InferenceFetch;
  /**
   * The bearer token, when the caller resolved it itself. Kept in memory beside the waiting promise
   * and never written to the queue row -- see InferenceRequestRecord. A row re-admitted after a
   * restart has lost it and falls back to `request.apiKeyEnv`.
   */
  apiKey?: string;
};

export type InferenceStatus = {
  request_id: string;
  state: InferenceRowStatus;
  /** One sentence the UI can show as-is. */
  message: string;
  /** Requests ahead of this one, for queued and shed rows. */
  ahead?: number;
  /** `null` while unhealthy or before service latency has been measured. */
  estimated_wait_ms?: number | null;
  /** Whether "wait" is an available choice right now. */
  can_wait: boolean;
  expires_at: string;
  arrived_at: string;
  finished_at?: string;
  outcome?: string;
  error?: string;
  result_available: boolean;
  /**
   * For a step of a multi-step task: whether the *task* completed. A completed step whose task did
   * not is reported as such, never as "Done".
   */
  task_completed?: boolean;
  /** Present while an escalation for the GPU is proposed and awaiting an administrator. */
  escalation?: { proposal_id?: string; trigger: string; awaiting_approval: true };
};

export type InferenceOutcome =
  | { kind: "completed"; id: string; response: InferenceResponseRecord; waitMs: number }
  | {
      kind: "failed";
      id: string;
      failure: InferenceFailureKind;
      error: string;
      response?: InferenceResponseRecord;
      cause?: unknown;
    }
  | { kind: "shed"; id: string; status: InferenceStatus }
  | { kind: "queued"; id: string; status: InferenceStatus }
  | { kind: "expired"; id: string; status: InferenceStatus }
  | { kind: "conflict"; id: string; status: InferenceStatus }
  | { kind: "refused"; reason: string };

export type InferenceDeferredKind = Exclude<InferenceOutcome["kind"], "completed" | "failed">;

/** Carry queue decisions through response-or-error APIs. Callers must propagate them without retry or fallback. */
export class InferenceDeferredError extends Error {
  readonly outcome: Extract<InferenceOutcome, { kind: InferenceDeferredKind }>;
  constructor(outcome: Extract<InferenceOutcome, { kind: InferenceDeferredKind }>) {
    super(
      outcome.kind === "refused"
        ? `inference request refused: ${outcome.reason}`
        : outcome.status.message,
    );
    this.name = "InferenceDeferredError";
    this.outcome = outcome;
  }
}

export function isInferenceDeferred(error: unknown): error is InferenceDeferredError {
  return error instanceof InferenceDeferredError;
}

export type InferenceHealth = {
  state: "ok" | "degraded" | "down";
  consecutive_probe_failures: number;
  /** Timeouts, transport errors, and HTTP 5xx responses since the last successful completion. */
  consecutive_inference_failures: number;
  last_probe_ok_at?: string;
  last_probe_error?: string;
  last_inference_ok_at?: string;
  inference_timeouts: number;
  inference_failures: number;
};

export type InferenceEscalationTrigger = "queue_age" | "queue_depth" | "health";

export type InferenceEscalation = {
  trigger: InferenceEscalationTrigger;
  summary: string;
  details: Record<string, unknown>;
};

export type InferenceGateStats = {
  persist_across_restarts: boolean;
  paused: boolean;
  shutting_down: boolean;
  shutdown_grace_ms: number;
  capacity: number;
  in_flight: number;
  queued: number;
  shed: number;
  oldest_queued_age_ms: number | null;
  mean_service_ms: number | null;
  retained_bytes: number;
  health: InferenceHealth;
  rows: Record<InferenceRowStatus, number>;
  escalations_armed: InferenceEscalationTrigger[];
};

export type InferenceGateOptions = {
  db?: DatabaseSync;
  config?: InferenceGateConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: InferenceFetch;
  /** Where the health probe goes. Defaults to ADMINBOT_LOCAL_BASE_URL, then the vLLM default. */
  localBaseUrl?: string;
  /**
   * Which environment variable holds the local model's bearer token, for the health probe. The
   * checked-in vLLM unit runs with `--api-key`, so an unauthenticated `/v1/models` is a 401 and a
   * healthy server would read as down. Defaults to VLLM_API_KEY, like every caller in this tree.
   */
  localApiKeyEnv?: string;
  /**
   * Called once per armed trigger. Returns the proposal it created, if any, so the status a member
   * sees can point at it. Delivery is not this module's business: the proposal goes through the
   * approval gate like every other external effect, and `inference.escalated` is recorded by the
   * execution path only once a connector has actually delivered.
   */
  onEscalate?: (escalation: InferenceEscalation) => Promise<{ proposal_id?: string } | void>;
  /** Operator-visible line the moment a trigger fires, before anyone approves anything. */
  alert?: (line: string) => void;
  now?: () => Date;
  /** Identifies this process on a claim, so a row found running at startup names who held it. */
  processId?: string;
};

type Waiter = {
  id: string;
  resolvers: Array<(outcome: InferenceOutcome) => void>;
  fetchImpl?: InferenceFetch;
  apiKey?: string;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type Active = {
  promise: Promise<InferenceOutcome>;
};

export type InferenceGate = ReturnType<typeof createInferenceGate>;

export function createInferenceGate(options: InferenceGateOptions) {
  const config = options.config ?? DEFAULT_INFERENCE_GATE_CONFIG;
  validateInferenceGateConfig(config);
  const database = options.db ?? openMemoryDatabase();
  const store = new InferenceQueueStore(database, !config.persistAcrossRestarts);
  const env = options.env ?? process.env;
  // A gate built with its own transport uses it for every request, whatever the caller handed in:
  // that is how a test stands one fake model behind every code path at once. A gate built without
  // one -- production, and every caller's own unit test -- defers to the caller's transport, which
  // is how those tests keep their existing fakes.
  const pinnedFetch = options.fetchImpl;
  const defaultFetch: InferenceFetch =
    pinnedFetch ?? ((input, init) => globalThis.fetch(input, init) as ReturnType<InferenceFetch>);
  const transportFor = (requested: InferenceFetch | undefined): InferenceFetch =>
    pinnedFetch ?? requested ?? defaultFetch;
  const now = options.now ?? (() => new Date());
  const processId = options.processId ?? `${process.pid}:${randomUUID().slice(0, 8)}`;
  const localBaseUrl =
    options.localBaseUrl ?? env.ADMINBOT_LOCAL_BASE_URL?.trim() ?? "http://127.0.0.1:8000/v1";
  const localApiKeyEnv = options.localApiKeyEnv ?? "VLLM_API_KEY";

  // The wait line, in the order rows joined it. The database is the durable copy; this is the
  // dispatch order and the place a waiting caller's promise lives.
  const waiting: Waiter[] = [];
  // Rows this process is running, keyed by id, so a second submission with the same key can wait on
  // the same call rather than making another.
  const active = new Map<string, Active>();
  let inFlight = 0;
  let started = false;
  let closed = false;
  let paused = config.startPaused;
  let shutdownGraceMs = config.shutdownGraceMs;
  const shutdownAbort = new AbortController();
  let shutdownPromise: Promise<void> | undefined;
  let shutdownStartedAt: number | undefined;
  let shutdownFinished = false;
  let shutdownTimer: NodeJS.Timeout | undefined;

  let sweepTimer: NodeJS.Timeout | undefined;
  let healthTimer: NodeJS.Timeout | undefined;

  // Exponential moving average of service time, for the estimate a queued member is shown.
  let meanServiceMs: number | null = null;
  const health: InferenceHealth = {
    state: "ok",
    consecutive_probe_failures: 0,
    consecutive_inference_failures: 0,
    inference_timeouts: 0,
    inference_failures: 0,
  };
  // One escalation per trigger while its condition holds. Re-armed when it clears, so a queue that
  // drains and fills again does escalate again -- but a queue that stays full escalates once.
  const armed = new Map<InferenceEscalationTrigger, { proposal_id?: string }>();

  const timestamp = () => now().toISOString();

  function depth(): number {
    return waiting.length;
  }

  function positionOf(id: string): number {
    const index = waiting.findIndex((entry) => entry.id === id);
    return index < 0 ? depth() : index;
  }

  function estimate(ahead: number): number | null {
    // Any unhealthy state, not only `down`: a degraded server is one whose recent calls timed out,
    // and its healthy-era mean says nothing about how long the next one will take.
    if (paused || health.state !== "ok" || meanServiceMs === null) {
      return null;
    }
    // Everybody ahead plus this one, divided across the slots.
    return Math.round(((ahead + 1) * meanServiceMs) / config.capacity);
  }

  function statusOf(row: InferenceQueueRow): InferenceStatus {
    const base = {
      request_id: row.id,
      state: row.status,
      expires_at: row.expires_at,
      arrived_at: row.arrived_at,
      ...(row.finished_at ? { finished_at: row.finished_at } : {}),
      ...(row.outcome ? { outcome: row.outcome } : {}),
      ...(row.error ? { error: row.error } : {}),
      result_available: row.status === "completed" && row.result !== null,
      ...(row.stage
        ? { task_completed: row.stage.final ? row.status === "completed" : taskDone(row) }
        : {}),
      ...(armed.size > 0
        ? {
            escalation: {
              trigger: [...armed.keys()][0] as string,
              ...(([...armed.values()][0]?.proposal_id ?? undefined)
                ? { proposal_id: [...armed.values()][0]?.proposal_id }
                : {}),
              awaiting_approval: true as const,
            },
          }
        : {}),
    };
    switch (row.status) {
      case "shed": {
        const ahead = depth();
        const canWait =
          ahead < config.queue.maxDepth || (!paused && inFlight < config.capacity && ahead === 0);
        return {
          ...base,
          ahead,
          estimated_wait_ms: estimate(ahead),
          can_wait: canWait,
          message: paused
            ? canWait
              ? "Inference paused by operator. Request saved; you may choose to wait."
              : "Inference paused and queue full. Request saved; try waiting later."
            : canWait
              ? `GPU busy, ${ahead} ahead of you. Wait or try later.`
              : `GPU busy and the wait line is full (${ahead} waiting). Try later.`,
        };
      }
      case "queued": {
        const ahead = positionOf(row.id);
        return {
          ...base,
          ahead,
          estimated_wait_ms: estimate(ahead),
          can_wait: false,
          message: paused
            ? "Queue paused by operator. Request saved."
            : `Waiting for the GPU, ${ahead} ahead of you.`,
        };
      }
      case "running":
        return { ...base, can_wait: false, message: "Running on the GPU." };
      case "completed":
        if (row.stage && !row.stage.final && !taskDone(row)) {
          // Completing classification alone does not complete the parent task.
          return {
            ...base,
            can_wait: false,
            message: `The "${row.stage.name}" step finished, but the task it was part of did not. Resubmit the task.`,
          };
        }
        return {
          ...base,
          can_wait: false,
          message: row.result_retained
            ? "Done."
            : "Done. The answer was delivered but not kept, because the queue was at its storage limit.",
        };
      case "failed":
        return {
          ...base,
          can_wait: false,
          message:
            row.outcome === "interrupted"
              ? "This request was interrupted before its result could be delivered. Resubmit the task."
              : row.outcome === "cancelled"
                ? "Cancelled."
                : `Failed: ${row.error ?? "unknown error"}`,
        };
      case "expired":
        return {
          ...base,
          can_wait: false,
          message: "This request waited too long and was never run. Resubmit it.",
        };
    }
  }

  function taskDone(row: InferenceQueueRow): boolean {
    return row.stage
      ? store.taskCompleted(row.owner_id, row.stage.task)
      : row.status === "completed";
  }

  /**
   * What an audit row may say about a failure: a code, a status, a kind. Never the message. A model
   * error can quote the prompt back, an HTTP body can carry it, and the audit table is read by more
   * people than the queue table is. The raw text lives in the row's `error` column, under the same
   * retention as the body.
   */
  function auditableFailure(kind: InferenceFailureKind, cause: unknown, httpStatus?: number) {
    const code = errorCode(cause);
    return {
      outcome: kind,
      ...(code ? { error_code: code } : {}),
      ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    };
  }

  function auditRow(
    type: Parameters<InferenceQueueStore["audit"]>[0]["type"],
    row: Pick<InferenceQueueRow, "id" | "caller" | "owner_id">,
    details: Record<string, unknown>,
  ) {
    store.audit({
      type,
      actor: row.owner_id,
      details: {
        request_id: row.id,
        caller: row.caller,
        queue_depth: depth(),
        in_flight: inFlight,
        ...details,
      },
    });
  }

  function waitedMs(row: InferenceQueueRow, until: string): number {
    return Math.max(0, Date.parse(until) - Date.parse(row.arrived_at));
  }

  // ---------------------------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------------------------

  /** Consume one admitted HTTP response. `track` releases its permit when dispatch settles. */
  async function execute(
    row: InferenceQueueRow,
    fetchImpl: InferenceFetch,
    callerSignal?: AbortSignal,
    apiKeyInMemory?: string,
  ): Promise<InferenceOutcome> {
    const request = row.request;
    const admittedAt = row.admitted_at ?? timestamp();
    const startedAt = Date.now();
    let outcome: InferenceOutcome;
    try {
      if (!request) {
        throw new Error("request body is no longer stored");
      }
      // The timeout starts here, at admission -- see the file header.
      const timeout = AbortSignal.timeout(row.timeout_ms);
      const signal = AbortSignal.any([
        timeout,
        shutdownAbort.signal,
        ...(callerSignal ? [callerSignal] : []),
      ]);
      const base = assertLoopbackUrl(request.baseUrl, `${request.purpose} inference`);
      const apiKey =
        apiKeyInMemory || (request.apiKeyEnv ? env[request.apiKeyEnv]?.trim() : undefined);
      let response: Awaited<ReturnType<InferenceFetch>>;
      let text: string;
      try {
        response = await abortable(
          fetchImpl(`${base}${request.route}`, {
            method: "POST",
            // A loopback origin must not redirect private content to another host.
            redirect: "error",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify(request.body),
            signal,
          }),
          signal,
        );
        text = await abortable(response.text(), signal);
      } catch (error) {
        const kind: InferenceFailureKind = shutdownAbort.signal.aborted
          ? "interrupted"
          : callerSignal?.aborted
            ? "cancelled"
            : timeout.aborted
              ? "timeout"
              : "error";
        const message = error instanceof Error ? error.message : String(error);
        outcome = { kind: "failed", id: row.id, failure: kind, error: message, cause: error };
        return settleFailed(row, outcome, undefined, Date.now() - startedAt);
      }
      const record: InferenceResponseRecord = {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        text,
      };
      const durationMs = Date.now() - startedAt;
      if (!response.ok) {
        const kind = `http_${response.status}` as InferenceFailureKind;
        const message = `${request.purpose}: HTTP ${response.status} ${response.statusText}`;
        outcome = { kind: "failed", id: row.id, failure: kind, error: message, response: record };
        return settleFailed(row, outcome, record, durationMs);
      }
      const finishedAt = timestamp();
      // Deliver the response even when the storage ceiling prevents retaining it.
      const resultBytes = Buffer.byteLength(JSON.stringify(record));
      const keep = store.retainedBytes() + resultBytes <= config.queue.maxRetainedBytes;
      const transitioned = store.transaction(() => {
        if (!store.finishCompleted(row.id, finishedAt, keep ? record : undefined)) {
          return false;
        }
        auditRow("inference.completed", row, {
          outcome: "completed",
          wait_ms: waitedMs(row, admittedAt),
          duration_ms: durationMs,
          http_status: response.status,
          result_retained: keep,
        });
        return true;
      });
      if (!transitioned) {
        // The row is no longer ours: recovery (or another gate on the same file) marked it
        // interrupted while the call was in flight. The answer arrived, but the row says failed
        // and a second terminal event would make the audit trail contradict itself. The caller
        // gets what the row says.
        return settledElsewhere(row);
      }
      meanServiceMs = meanServiceMs === null ? durationMs : meanServiceMs * 0.7 + durationMs * 0.3;
      health.last_inference_ok_at = finishedAt;
      health.consecutive_inference_failures = 0;
      if (health.state === "degraded") {
        health.state = "ok";
      }
      outcome = {
        kind: "completed",
        id: row.id,
        response: record,
        waitMs: waitedMs(row, admittedAt),
      };
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return settleFailed(
        row,
        { kind: "failed", id: row.id, failure: "error", error: message, cause: error },
        undefined,
        Date.now() - startedAt,
      );
    }
  }

  /** The row's actual terminal state, for a call whose guarded transition lost to somebody else's. */
  function settledElsewhere(row: InferenceQueueRow): InferenceOutcome {
    const current = store.get(row.id);
    if (!current) {
      return { kind: "refused", reason: "request row vanished" };
    }
    if (current.status === "completed" && current.result) {
      return { kind: "completed", id: current.id, response: current.result, waitMs: 0 };
    }
    if (current.status === "expired") {
      return { kind: "expired", id: current.id, status: statusOf(current) };
    }
    return {
      kind: "failed",
      id: current.id,
      failure: (current.outcome as InferenceFailureKind | null) ?? "error",
      error: current.error ?? "the request was settled by another process",
    };
  }

  function settleFailed(
    row: InferenceQueueRow,
    outcome: Extract<InferenceOutcome, { kind: "failed" }>,
    response: InferenceResponseRecord | undefined,
    durationMs: number,
  ): InferenceOutcome {
    return finishFailed(row, outcome.failure, outcome.error, response, durationMs, outcome.cause)
      ? outcome
      : settledElsewhere(row);
  }

  /** running|queued -> failed, if the row is still ours. Returns whether the transition happened. */
  function finishFailed(
    row: InferenceQueueRow,
    kind: InferenceFailureKind,
    message: string,
    response: InferenceResponseRecord | undefined,
    durationMs: number,
    cause?: unknown,
  ): boolean {
    const finishedAt = timestamp();
    const transitioned = store.transaction(() => {
      const keep =
        response &&
        store.retainedBytes() + Buffer.byteLength(JSON.stringify(response)) <=
          config.queue.maxRetainedBytes;
      if (!store.finishFailed(row.id, finishedAt, kind, message, keep ? response : undefined)) {
        return false;
      }
      auditRow("inference.failed", row, {
        ...auditableFailure(kind, cause, response?.status),
        wait_ms: row.admitted_at ? waitedMs(row, row.admitted_at) : undefined,
        duration_ms: durationMs,
      });
      return true;
    });
    if (!transitioned) {
      return false;
    }
    if (kind === "timeout") {
      health.inference_timeouts += 1;
    } else if (kind !== "cancelled") {
      health.inference_failures += 1;
    }
    if (
      !closed &&
      (kind === "timeout" || kind === "error" || (response && response.status >= 500))
    ) {
      // Generation can fail while /models still answers. Evaluate even when the queue is empty.
      health.consecutive_inference_failures += 1;
      health.state = health.state === "down" ? "down" : "degraded";
      void evaluateEscalations();
    }
    return true;
  }

  /**
   * Admission, atomically: the running transition and its `inference.admitted` event in one
   * transaction, before any model call. If that transaction fails nothing has changed -- the row is
   * still queued (or, for an arrival, was never inserted) and there is no orphaned `running` row
   * with no call behind it.
   */
  function admitQueued(row: InferenceQueueRow, at: string): boolean {
    return store.transaction(() => {
      if (!store.claim(row.id, processId, at)) {
        return false;
      }
      auditRow("inference.admitted", row, {
        wait_ms: waitedMs(row, at),
        timeout_ms: row.timeout_ms,
      });
      return true;
    });
  }

  function admitArrival(row: InferenceQueueRow): void {
    store.transaction(() => {
      store.insertRunning(row, processId);
      auditRow("inference.admitted", row, { wait_ms: 0, timeout_ms: row.timeout_ms });
    });
  }

  /**
   * Runs an admitted row and guarantees the promise settles with an outcome, never a rejection. A
   * throw out of execute() -- which should not happen, but a database error in a finishing
   * transaction can -- is turned into a failed outcome and the row reconciled, so a waiter never
   * hangs and no rejection escapes into `void run.then(resolve)`.
   */
  async function dispatch(
    row: InferenceQueueRow,
    fetchImpl: InferenceFetch,
    signal?: AbortSignal,
    apiKey?: string,
  ): Promise<InferenceOutcome> {
    try {
      return await execute(row, fetchImpl, signal, apiKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        finishFailed(row, "error", message, undefined, 0, error);
      } catch {
        // The database itself is failing. The caller still gets a typed outcome; the row is
        // whatever the last successful write left it, and recovery on the next start will settle it.
      }
      return { kind: "failed", id: row.id, failure: "error", error: message, cause: error };
    }
  }

  function track(id: string, run: Promise<InferenceOutcome>): Promise<InferenceOutcome> {
    inFlight += 1;
    const wrapped = run.finally(() => {
      inFlight -= 1;
      active.delete(id);
      pump();
    });
    active.set(id, { promise: wrapped });
    return wrapped;
  }

  /** Moves the head of the line into a free slot, until either runs out. */
  function pump(): void {
    if (closed || paused) {
      return;
    }
    while (inFlight < config.capacity && waiting.length > 0) {
      const waiter = waiting.shift() as Waiter;
      waiter.onAbort && waiter.signal?.removeEventListener("abort", waiter.onAbort);
      const at = timestamp();
      const row = store.get(waiter.id);
      if (!row) {
        continue;
      }
      if (Date.parse(row.expires_at) <= Date.parse(at)) {
        const expired = expireRow(row, at);
        for (const resolve of waiter.resolvers) {
          resolve(expired);
        }
        continue;
      }
      let admitted: boolean;
      try {
        admitted = admitQueued(row, at);
      } catch (error) {
        // The admission transaction itself failed (database trouble). The row is untouched and
        // still queued in the table; the waiter is told, rather than left hanging, and the row
        // will be re-admitted by the next process's recovery.
        const message = error instanceof Error ? error.message : String(error);
        for (const resolve of waiter.resolvers) {
          resolve({ kind: "failed", id: row.id, failure: "error", error: message, cause: error });
        }
        continue;
      }
      if (!admitted) {
        // Somebody else changed the row under us (a sweep expired it, a cancel failed it). Whatever
        // they wrote is the answer.
        const outcome = settledElsewhere(row);
        for (const resolve of waiter.resolvers) {
          resolve(outcome);
        }
        continue;
      }
      const claimed = { ...row, status: "running" as const, admitted_at: at, claimed_at: at };
      const run = track(
        claimed.id,
        dispatch(claimed, transportFor(waiter.fetchImpl), waiter.signal, waiter.apiKey),
      );
      for (const resolve of waiter.resolvers) {
        // `run` never rejects (see dispatch), so this settles every waiter exactly once.
        void run.then(resolve);
      }
    }
  }

  function expireRow(row: InferenceQueueRow, at: string): InferenceOutcome {
    store.transaction(() => {
      if (store.expire(row.id, at)) {
        auditRow("inference.expired", row, {
          outcome: "expired",
          wait_ms: waitedMs(row, at),
          max_age_ms: config.queue.maxAgeMs,
        });
      }
    });
    const current = store.get(row.id) ?? { ...row, status: "expired" as const };
    return { kind: "expired", id: row.id, status: statusOf(current) };
  }

  function enqueue(
    row: InferenceQueueRow,
    request: InferenceGateRequest,
  ): Promise<InferenceOutcome> {
    return new Promise<InferenceOutcome>((resolve) => {
      const waiter: Waiter = {
        id: row.id,
        resolvers: [resolve],
        ...(request.fetchImpl ? { fetchImpl: request.fetchImpl } : {}),
        ...(request.apiKey ? { apiKey: request.apiKey } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      };
      waiting.push(waiter);
      if (request.signal) {
        const onAbort = () => {
          const index = waiting.indexOf(waiter);
          if (index < 0) {
            return;
          }
          waiting.splice(index, 1);
          const message = "cancelled while waiting for a slot";
          store.transaction(() => {
            store.finishFailed(row.id, timestamp(), "cancelled", message);
            auditRow("inference.failed", row, {
              outcome: "cancelled",
              wait_ms: waitedMs(row, timestamp()),
            });
          });
          for (const r of waiter.resolvers) {
            r({ kind: "failed", id: row.id, failure: "cancelled", error: message });
          }
        };
        waiter.onAbort = onAbort;
        if (request.signal.aborted) {
          onAbort();
          return;
        }
        request.signal.addEventListener("abort", onAbort, { once: true });
      }
      pump();
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Arrival
  // ---------------------------------------------------------------------------------------------

  function payloadHash(request: InferenceRequestRecord): string {
    return createHash("sha256")
      .update(JSON.stringify({ route: request.route, body: request.body }))
      .digest("hex");
  }

  async function run(request: InferenceGateRequest): Promise<InferenceOutcome> {
    if (closed) {
      return { kind: "refused", reason: "inference gate is closed" };
    }
    const arrivedAt = timestamp();
    const hash = payloadHash(request.request);
    const requestJson = JSON.stringify(request.request);
    const bytes = Buffer.byteLength(requestJson);
    const submissionKey = request.submissionKey?.trim() || `auto:${randomUUID()}`;

    // A retry finds its row. Same key, same payload: whatever that row is doing is the answer. Same
    // key, different payload: the client changed its mind under a key it already used, and neither
    // request can be silently preferred.
    const existing = request.submissionKey
      ? store.findReusable(request.owner, submissionKey)
      : undefined;
    if (existing) {
      if (existing.payload_hash !== hash) {
        return { kind: "conflict", id: existing.id, status: statusOf(existing) };
      }
      return attach(existing, request);
    }

    if (bytes > config.queue.maxPayloadBytes) {
      const reason = `request body is ${bytes} bytes; the queue stores at most ${config.queue.maxPayloadBytes}`;
      store.audit({
        type: "inference.refused",
        actor: request.owner,
        details: { caller: request.caller, reason, bytes, queue_depth: depth() },
      });
      return { kind: "refused", reason };
    }
    if (store.retainedBytes() + bytes > config.queue.maxRetainedBytes) {
      // Not preserved, and said so: a handle would promise a row this refused to write.
      const reason = "the queue is holding as much request content as it is allowed to; try later";
      store.audit({
        type: "inference.refused",
        actor: request.owner,
        details: { caller: request.caller, reason, bytes, queue_depth: depth() },
      });
      return { kind: "refused", reason };
    }

    const row: InferenceQueueRow = {
      id: `inf_${randomUUID()}`,
      owner_id: request.owner,
      submission_key: submissionKey,
      payload_hash: hash,
      caller: request.caller,
      stage: request.stage ?? null,
      status: "queued",
      arrived_at: arrivedAt,
      // Fixed at arrival and never moved: a request cannot wait its way past the age limit by being
      // converted from shed to queued late.
      expires_at: new Date(Date.parse(arrivedAt) + config.queue.maxAgeMs).toISOString(),
      queued_at: null,
      admitted_at: null,
      finished_at: null,
      claimed_at: null,
      claimed_by: null,
      timeout_ms: Math.max(1, request.timeoutMs ?? config.defaultTimeoutMs),
      request: request.request,
      request_bytes: bytes,
      result: null,
      result_bytes: 0,
      outcome: null,
      error: null,
      result_retained: true,
    };

    if (request.signal?.aborted) {
      return {
        kind: "failed",
        id: row.id,
        failure: "cancelled",
        error: "cancelled before arrival",
      };
    }

    // Slot free and nobody ahead: run. Somebody ahead means the slot is theirs the moment pump runs.
    if (!paused && inFlight < config.capacity && waiting.length === 0) {
      admitArrival(row);
      const running = {
        ...row,
        status: "running" as const,
        admitted_at: arrivedAt,
        claimed_at: arrivedAt,
      };
      return track(
        row.id,
        dispatch(running, transportFor(request.fetchImpl), request.signal, request.apiKey),
      );
    }

    const wantsWait =
      request.wait ?? Boolean(store.getPreferences(request.owner).inference_always_wait);
    if (wantsWait && waiting.length < config.queue.maxDepth) {
      store.transaction(() => {
        store.insert({ ...row, queued_at: arrivedAt });
        auditRow("inference.queued", row, { position: waiting.length, wait: true });
      });
      return enqueue({ ...row, queued_at: arrivedAt }, request);
    }

    store.transaction(() => {
      store.insert({ ...row, status: "shed" });
      auditRow("inference.shed", row, {
        reason: wantsWait ? "queue_full" : "no_slot",
        max_depth: config.queue.maxDepth,
      });
    });
    const shedRow = { ...row, status: "shed" as const };
    return { kind: "shed", id: row.id, status: statusOf(shedRow) };
  }

  /** The outcome of a row that already exists, for a retry that found it. */
  function attach(
    row: InferenceQueueRow,
    request: InferenceGateRequest,
  ): Promise<InferenceOutcome> {
    switch (row.status) {
      case "completed":
        return Promise.resolve(
          row.result
            ? { kind: "completed", id: row.id, response: row.result, waitMs: 0 }
            : { kind: "expired", id: row.id, status: statusOf(row) },
        );
      case "failed":
        // The key found a row that failed. That failure is the answer to this key -- a retry that
        // ran the request again under the same key is exactly the double execution the key exists
        // to prevent. A genuinely new attempt needs a new key; the status says so.
        return Promise.resolve({
          kind: "failed",
          id: row.id,
          failure: (row.outcome as InferenceFailureKind | null) ?? "error",
          error: `${row.error ?? "the request failed"} (resubmit with a new key to try again)`,
        });
      case "running": {
        const current = active.get(row.id);
        return current
          ? current.promise
          : Promise.resolve({ kind: "queued", id: row.id, status: statusOf(row) });
      }
      case "queued": {
        const waiter = waiting.find((entry) => entry.id === row.id);
        if (waiter && (request.wait ?? true)) {
          return new Promise((resolve) => waiter.resolvers.push(resolve));
        }
        return Promise.resolve({ kind: "queued", id: row.id, status: statusOf(row) });
      }
      case "shed":
        if (request.wait) {
          const converted = wait(request.owner, row.id);
          if (converted && converted.state !== "shed") {
            return attach(store.get(row.id) as InferenceQueueRow, request);
          }
          return Promise.resolve({ kind: "shed", id: row.id, status: converted ?? statusOf(row) });
        }
        return Promise.resolve({ kind: "shed", id: row.id, status: statusOf(row) });
      default:
        return Promise.resolve({ kind: "expired", id: row.id, status: statusOf(row) });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Member-facing operations. Every one checks the owner: knowing a request id is not authority.
  // ---------------------------------------------------------------------------------------------

  function ownedRow(owner: string, id: string): InferenceQueueRow | undefined {
    const row = store.get(id);
    // Wrong owner reads exactly like no such row, so an id cannot be used to learn that a request
    // exists, let alone what it says.
    return row && row.owner_id === owner ? row : undefined;
  }

  function status(owner: string, id: string): InferenceStatus | undefined {
    const row = ownedRow(owner, id);
    return row ? statusOf(row) : undefined;
  }

  function result(owner: string, id: string): InferenceResponseRecord | undefined {
    const row = ownedRow(owner, id);
    return row?.status === "completed" && row.result ? row.result : undefined;
  }

  /**
   * shed -> queued, at the member's request. One transaction checks the state, the expiry and the
   * line's capacity together, so two clicks cannot enqueue twice and an expired row cannot be
   * revived. A repeat click on a row that is no longer shed returns whatever it is now.
   */
  function wait(owner: string, id: string): InferenceStatus | undefined {
    if (closed) {
      return status(owner, id);
    }
    const row = ownedRow(owner, id);
    if (!row) {
      return undefined;
    }
    const at = timestamp();
    const converted = store.transaction(() => {
      const fresh = store.get(id);
      if (!fresh || fresh.status !== "shed") {
        return false;
      }
      if (Date.parse(fresh.expires_at) <= Date.parse(at)) {
        expireRow(fresh, at);
        return false;
      }
      const canAdmitNow = !paused && inFlight < config.capacity && waiting.length === 0;
      if (waiting.length >= config.queue.maxDepth && !canAdmitNow) {
        return false;
      }
      if (!store.convertToQueued(id, at)) {
        return false;
      }
      auditRow("inference.waited", fresh, {
        position: waiting.length,
        wait_ms: waitedMs(fresh, at),
      });
      return true;
    });
    if (converted) {
      const queued = store.get(id) as InferenceQueueRow;
      void enqueue(queued, {
        owner,
        caller: queued.caller,
        request: queued.request as InferenceRequestRecord,
      });
    }
    const current = store.get(id);
    return current ? statusOf(current) : undefined;
  }

  function listForOwner(owner: string): InferenceStatus[] {
    return store.listForOwner(owner).map(statusOf);
  }

  function preferences(owner: string): MemberInferencePreferences {
    return store.getPreferences(owner);
  }

  function setPreferences(
    owner: string,
    next: MemberInferencePreferences,
  ): MemberInferencePreferences {
    store.savePreferences(owner, next);
    return store.getPreferences(owner);
  }

  // ---------------------------------------------------------------------------------------------
  // Recovery, sweep, health, escalation
  // ---------------------------------------------------------------------------------------------

  /**
   * Startup. Three passes over what the previous process left behind:
   *
   *  - Rows still `running` were claimed by a process that is gone. Whether the GPU ran them is
   *    unknowable from here, so they are failed as `interrupted` and the member is told to resubmit
   *    -- never replayed, which could run a request twice. The event names the claim and who held
   *    it, so an operator can tell "we restarted" from "vLLM hung".
   *  - Rows past their expiry are expired, whatever they were waiting for.
   *  - Rows still `queued` rejoin the line in the order they joined it. Rows still `shed` keep
   *    waiting for their member's choice.
   */
  function recover(): { interrupted: number; expired: number; readmitted: number } {
    if (!config.persistAcrossRestarts) {
      return { interrupted: 0, expired: 0, readmitted: 0 };
    }
    const at = timestamp();
    let interrupted = 0;
    let expired = 0;
    let readmitted = 0;
    for (const row of store.listByStatus("running")) {
      store.transaction(() => {
        store.finishFailed(
          row.id,
          at,
          "interrupted",
          "the service restarted while this request was running",
        );
        auditRow("inference.failed", row, {
          outcome: "interrupted",
          claimed_at: row.claimed_at,
          claimed_by: row.claimed_by,
          recovered_by: processId,
          wait_ms: row.admitted_at ? waitedMs(row, row.admitted_at) : undefined,
        });
      });
      interrupted += 1;
    }
    for (const row of store.listByStatus("queued", "shed")) {
      if (Date.parse(row.expires_at) <= Date.parse(at)) {
        expireRow(row, at);
        expired += 1;
        continue;
      }
      if (row.status === "queued") {
        waiting.push({ id: row.id, resolvers: [] });
        readmitted += 1;
      }
    }
    pump();
    return { interrupted, expired, readmitted };
  }

  function sweep(): { expired: number; purged: number } {
    const at = timestamp();
    let expired = 0;
    for (const row of store.listByStatus("queued", "shed")) {
      if (Date.parse(row.expires_at) > Date.parse(at)) {
        continue;
      }
      const index = waiting.findIndex((entry) => entry.id === row.id);
      const waiter = index >= 0 ? waiting.splice(index, 1)[0] : undefined;
      const outcome = expireRow(row, at);
      for (const resolve of waiter?.resolvers ?? []) {
        resolve(outcome);
      }
      expired += 1;
    }
    const purged = store.purgeBodiesBefore(
      new Date(Date.parse(at) - config.queue.retentionMs).toISOString(),
    );
    void evaluateEscalations();
    return { expired, purged };
  }

  async function probeHealth(): Promise<InferenceHealth> {
    if (closed) {
      return { ...health };
    }
    const base = assertLoopbackUrl(localBaseUrl, "inference health probe");
    try {
      const probeKey = env[localApiKeyEnv]?.trim();
      const response = await defaultFetch(`${base}models`, {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(probeKey ? { Authorization: `Bearer ${probeKey}` } : {}),
        },
        signal: AbortSignal.timeout(config.health.timeoutMs),
      });
      await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      health.consecutive_probe_failures = 0;
      health.last_probe_ok_at = timestamp();
      delete health.last_probe_error;
      // A listing that answers proves the process is up, not that generation works. Recent
      // inference failures keep the state degraded until a completion clears it.
      if (health.state !== "ok") {
        health.state = health.consecutive_inference_failures > 0 ? "degraded" : "ok";
      }
    } catch (error) {
      health.consecutive_probe_failures += 1;
      health.last_probe_error = error instanceof Error ? error.message : String(error);
      if (health.consecutive_probe_failures >= config.health.failureThreshold) {
        health.state = "down";
      } else if (health.state === "ok") {
        health.state = "degraded";
      }
    }
    if (inFlight > 0 && !recentInferenceSuccess() && health.state === "ok") {
      health.state = "degraded";
    }
    await evaluateEscalations();
    return { ...health };
  }

  function recentInferenceSuccess(): boolean {
    return (
      health.last_inference_ok_at !== undefined &&
      Date.now() - Date.parse(health.last_inference_ok_at) < config.health.staleAfterMs
    );
  }

  function oldestQueuedAgeMs(): number | null {
    if (waiting.length === 0) {
      return null;
    }
    const head = store.get((waiting[0] as Waiter).id);
    return head ? Date.now() - Date.parse(head.queued_at ?? head.arrived_at) : null;
  }

  async function evaluateEscalations(): Promise<void> {
    if (closed) {
      return;
    }
    const conditions: Array<[InferenceEscalationTrigger, boolean, InferenceEscalation]> = [
      [
        "queue_age",
        (oldestQueuedAgeMs() ?? 0) > config.escalate.queueAgeMs,
        {
          trigger: "queue_age",
          summary: `Inference requests have been waiting more than ${Math.round(config.escalate.queueAgeMs / 1000)}s for the GPU`,
          details: {
            oldest_queued_age_ms: oldestQueuedAgeMs(),
            queue_depth: depth(),
            in_flight: inFlight,
          },
        },
      ],
      [
        "queue_depth",
        depth() > config.escalate.queueDepth,
        {
          trigger: "queue_depth",
          summary: `${depth()} inference requests are waiting for the GPU (threshold ${config.escalate.queueDepth})`,
          details: { queue_depth: depth(), in_flight: inFlight },
        },
      ],
      [
        "health",
        // Probe failures, or generation failing while the probe still answers: a hung vLLM lists its
        // models happily and never finishes a completion, and only the second signal sees that.
        health.consecutive_probe_failures >= config.escalate.healthFailures ||
          health.consecutive_inference_failures >= config.escalate.healthFailures ||
          health.state === "down",
        {
          trigger: "health",
          summary:
            health.consecutive_probe_failures >= config.escalate.healthFailures ||
            health.state === "down"
              ? `The local model at ${localBaseUrl} has failed ${health.consecutive_probe_failures} health checks in a row`
              : `The local model at ${localBaseUrl} answers health checks but ${health.consecutive_inference_failures} inference calls in a row have timed out or failed`,
          details: { ...health, queue_depth: depth(), in_flight: inFlight },
        },
      ],
    ];
    for (const [trigger, firing, escalation] of conditions) {
      if (!firing) {
        armed.delete(trigger);
        continue;
      }
      if (armed.has(trigger)) {
        continue;
      }
      armed.set(trigger, {});
      options.alert?.(`[adminbot] inference escalation (${trigger}): ${escalation.summary}`);
      let proposalId: string | undefined;
      try {
        const created = await options.onEscalate?.(escalation);
        proposalId = created?.proposal_id ?? undefined;
      } catch (error) {
        escalation.details.proposal_error = error instanceof Error ? error.message : String(error);
      }
      if (closed) {
        return;
      }
      if (proposalId) {
        armed.set(trigger, { proposal_id: proposalId });
      }
      store.audit({
        type: "inference.escalation_proposed",
        actor: "system:inference-gate",
        ...(proposalId ? { action_id: proposalId } : {}),
        details: {
          trigger,
          summary: escalation.summary,
          ...escalation.details,
          queue_depth: depth(),
          in_flight: inFlight,
        },
      });
    }
  }

  function start(options: { recoverExisting?: boolean } = {}): ReturnType<typeof recover> {
    if (started) {
      return { interrupted: 0, expired: 0, readmitted: 0 };
    }
    started = true;
    const recovered =
      options.recoverExisting === false ? { interrupted: 0, expired: 0, readmitted: 0 } : recover();
    if (config.queue.sweepIntervalMs > 0) {
      sweepTimer = setInterval(() => sweep(), config.queue.sweepIntervalMs);
      sweepTimer.unref();
    }
    if (config.health.intervalMs > 0) {
      healthTimer = setInterval(() => void probeHealth(), config.health.intervalMs);
      healthTimer.unref();
    }
    return recovered;
  }

  function settings() {
    return {
      paused,
      shutting_down: closed,
      shutdown_grace_ms: shutdownGraceMs,
      persist_across_restarts: config.persistAcrossRestarts,
    };
  }

  function controlAudit(actor: string, operation: string, details = {}) {
    store.audit({ type: "inference.control_changed", actor, details: { operation, ...details } });
  }

  function pause(actor = "system:inference-gate") {
    if (closed) {
      throw new Error("inference gate is shutting down");
    }
    if (!paused) {
      controlAudit(actor, "pause");
      paused = true;
    }
    return settings();
  }

  function resume(actor = "system:inference-gate") {
    if (closed) {
      throw new Error("inference gate is shutting down");
    }
    if (paused) {
      controlAudit(actor, "resume");
      paused = false;
      pump();
    }
    return settings();
  }

  function cancelPending(ids: string[], actor = "system:inference-gate") {
    const cancelled: string[] = [];
    store.transaction(() => {
      for (const id of new Set(ids)) {
        const row = store.get(id);
        if (!row || !store.cancelPending(id, timestamp())) {
          continue;
        }
        auditRow("inference.failed", row, { outcome: "cancelled", cancelled_by: actor });
        cancelled.push(id);
      }
    });
    for (const id of cancelled) {
      const index = waiting.findIndex((w) => w.id === id);
      if (index < 0) {
        continue;
      }
      const waiter = waiting.splice(index, 1)[0];
      if (waiter.onAbort) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
      }
      for (const resolve of waiter.resolvers) {
        resolve({ kind: "failed", id, failure: "cancelled", error: "Cancelled by operator" });
      }
    }
    return { cancelled, unchanged: [...new Set(ids)].filter((id) => !cancelled.includes(id)) };
  }

  // The grace budget is measured from shutdown's start, including live edits during draining.
  function armShutdownDeadline() {
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
    }
    if (shutdownFinished || shutdownStartedAt === undefined || shutdownAbort.signal.aborted) {
      return;
    }
    const remaining = Math.max(0, shutdownStartedAt + shutdownGraceMs - Date.now());
    shutdownTimer = setTimeout(
      () => shutdownAbort.abort(new Error("shutdown grace period elapsed")),
      remaining,
    );
  }

  function setShutdownGraceMs(value: number, actor = "system:inference-gate") {
    if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
      throw new Error("shutdown_grace_ms must be an integer from 0 to 2147483647");
    }
    controlAudit(actor, "shutdown_grace", { shutdown_grace_ms: value });
    shutdownGraceMs = value;
    armShutdownDeadline();
    return settings();
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    close();
    shutdownStartedAt = Date.now();
    for (const waiter of waiting.splice(0)) {
      if (waiter.onAbort) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
      }
      const row = store.get(waiter.id);
      if (!row) {
        continue;
      }
      let outcome: InferenceOutcome;
      if (config.persistAcrossRestarts) {
        outcome = {
          kind: "queued",
          id: row.id,
          status: {
            ...statusOf(row),
            message:
              "Service shutting down. Inference request saved for restart; its parent workflow will not resume automatically.",
          },
        };
      } else {
        const error = "Service shutting down. Restart persistence is disabled; resubmit the task.";
        finishFailed(row, "interrupted", error, undefined, 0);
        outcome = { kind: "failed", id: row.id, failure: "interrupted", error };
      }
      for (const resolve of waiter.resolvers) {
        resolve(outcome);
      }
    }
    armShutdownDeadline();
    shutdownPromise = Promise.allSettled([...active.values()].map((entry) => entry.promise)).then(
      () => {
        shutdownFinished = true;
        if (shutdownTimer) {
          clearTimeout(shutdownTimer);
        }
      },
    );
    return shutdownPromise;
  }

  /** Synchronous admission/timer stop. Await shutdown() before closing the database. */
  function close(): void {
    closed = true;
    if (sweepTimer) {
      clearInterval(sweepTimer);
    }
    if (healthTimer) {
      clearInterval(healthTimer);
    }
  }

  function stats(): InferenceGateStats {
    return {
      ...settings(),
      capacity: config.capacity,
      in_flight: inFlight,
      queued: depth(),
      shed: store.countByStatus().shed,
      oldest_queued_age_ms: oldestQueuedAgeMs(),
      mean_service_ms: meanServiceMs,
      retained_bytes: store.retainedBytes(),
      health: { ...health },
      rows: store.countByStatus(),
      escalations_armed: [...armed.keys()],
    };
  }

  return {
    run,
    status,
    result,
    wait,
    listForOwner,
    preferences,
    setPreferences,
    start,
    recover,
    sweep,
    probeHealth,
    close,
    shutdown,
    pause,
    resume,
    cancelPending,
    settings,
    setShutdownGraceMs,
    stats,
    config,
    processId,
    /** The handle this gate writes to. Exposed so a server can build a durable gate on the same file. */
    database,
  };
}

/** A Node/undici error code (`ECONNREFUSED`, `UND_ERR_...`) or the error's class name; never its message. */
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const own = (error as unknown as { code?: unknown }).code;
  if (typeof own === "string") {
    return own;
  }
  const nested = (error.cause as { code?: unknown } | undefined)?.code;
  if (typeof nested === "string") {
    return nested;
  }
  return error.name;
}

/**
 * `run`, for a caller whose contract is "a response or an error".
 *
 * Completed rows return the response record -- including non-2xx ones, so the caller keeps its own
 * wording for HTTP failures. Transport failures rethrow the original cause for the same reason.
 * Queue decisions become `InferenceDeferredError`, which every catch above must rethrow first.
 */
export async function runGated(
  gate: Pick<InferenceGate, "run">,
  request: InferenceGateRequest,
): Promise<InferenceResponseRecord> {
  const task = currentTaskContext();
  if (!task) {
    return runGatedCall(gate, request);
  }
  const key = `${currentTaskScope()}:model:${request.caller}`;
  return taskStep(key, request.request, async () => {
    const gatedRequest: InferenceGateRequest = {
      ...request,
      owner: task.owner,
      wait: true,
      submissionKey: `${task.id}:${currentTaskStepAttempt()}`,
      signal: request.signal ? AbortSignal.any([task.signal, request.signal]) : task.signal,
    };
    for (;;) {
      task.check();
      try {
        return await runGatedCall(gate, gatedRequest);
      } catch (error) {
        // Internal backpressure is not an uncertain model attempt. Reuse the saved child row.
        if (!isInferenceDeferred(error) || error.outcome.kind !== "shed") {
          throw error;
        }
        await abortable(
          new Promise<void>((resolve) => setTimeout(resolve, 50)),
          gatedRequest.signal!,
        );
      }
    }
  });
}

async function runGatedCall(
  gate: Pick<InferenceGate, "run">,
  request: InferenceGateRequest,
): Promise<InferenceResponseRecord> {
  const outcome = await gate.run(request);
  switch (outcome.kind) {
    case "completed":
      return outcome.response;
    case "failed":
      if (outcome.response) {
        return outcome.response;
      }
      throw outcome.cause instanceof Error ? outcome.cause : new Error(outcome.error);
    default:
      throw new InferenceDeferredError(outcome);
  }
}

// ---------------------------------------------------------------------------------------------
// The process-wide gate.
// ---------------------------------------------------------------------------------------------

let shared: InferenceGate | undefined;

/** Fallback for callers without an injected gate. The server registers its durable gate at startup. */
export function sharedInferenceGate(): InferenceGate {
  if (!shared) {
    shared = createInferenceGate({ db: openMemoryDatabase() });
  }
  return shared;
}

export function setSharedInferenceGate(gate: InferenceGate | undefined): void {
  shared = gate;
}

function openMemoryDatabase(): DatabaseSync {
  // `require`, like persistence/sqlite.ts does: node:sqlite is still flagged experimental and a
  // static import would make every module that touches the gate fail to load on a runtime without
  // it, rather than failing the one call that needs it.
  const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS adminbot_audit_events (
      id TEXT PRIMARY KEY, action_id TEXT, event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL, actor TEXT, event_json TEXT NOT NULL
    );
  `);
  return db;
}

// Bound transports that ignore AbortSignal, and detach the abort listener after settlement.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) {
      abort();
    }
  });
}

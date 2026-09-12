/**
 * The one admission gate in front of the local model.
 *
 * Every caller in this tree that sends a prompt to the GPU -- the privacy broker, the CV scanner,
 * the reimbursement intake, the workshop matcher, the guidebook -- sends it through here, and this
 * module holds the only count of requests in flight. That is the whole design: the recorded
 * incident (workshop-match-llm.ts) was six requests in flight against a server that admits two, each
 * with a timeout already ticking while it waited inside vLLM for a slot. Three callers with a
 * well-behaved pool of two each is exactly that incident, so the pools are gone and the counter is
 * shared.
 *
 * What the gate decides, for a request that arrives:
 *
 *  - A slot is free and nobody is ahead in line: run it now.
 *  - No slot, and the caller asked to wait (or the member's stored preference says always wait):
 *    queue it, durably, and run it when a slot frees -- in arrival order, so a fresh arrival never
 *    steps in front of somebody already waiting.
 *  - No slot, otherwise: shed. The request body is stored anyway, so the status handed back carries a
 *    handle the member can later use to say "wait after all" without re-sending. One row per request
 *    from the moment it arrives; a retry or a wait click finds the row. That is the duplicate guard.
 *
 * The timeout clock starts at admission. The caller passes a duration, and the AbortSignal that
 * enforces it is created here, after the slot is taken -- never before, or time spent waiting in
 * line would count against the model, which is the bug this replaces. The caller's own cancellation
 * signal is separate and is honored while queued.
 *
 * Decisions are typed outcomes, not errors. A caller that gets `shed` back must not retry, and a
 * caller that gets `queued` back must not fall back to another model call: either would turn one
 * request into two. Where a caller's contract cannot carry the outcome, `InferenceDeferredError`
 * wraps it at that boundary, and every catch on the way up rethrows it before any fallback.
 *
 * One permit per HTTP call, released in `finally` after the response body is consumed. The gate holds
 * nothing across a caller's workflow, so two multi-stage callers cannot each hold a slot while waiting
 * for the other's.
 */
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_INFERENCE_GATE_CONFIG, type InferenceGateConfig } from "./config.js";
import {
  InferenceQueueStore,
  type InferenceFailureKind,
  type InferenceQueueRow,
  type InferenceRequestRecord,
  type InferenceResponseRecord,
  type InferenceRowStatus,
  type MemberInferencePreferences,
} from "./queue-store.js";

export type { InferenceRequestRecord, InferenceResponseRecord, InferenceRowStatus };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * The base URL, proven to be on this machine.
 *
 * `purpose` is the whole phrase the message opens with ("guidebook answer", "meeting summary"),
 * because this guard is shared: every model call in the tree runs through the same loopback rule,
 * and an error naming the wrong subsystem sends the operator to the wrong config. Defined here rather
 * than in guidebook/local-client.ts (which re-exports it) because the gate is the last thing that
 * touches a URL before the socket opens, and the guard belongs at the last step.
 */
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
  /** `null` when the server is not healthy: extrapolating a healthy latency during an outage lies. */
  estimated_wait_ms?: number | null;
  /** Whether "wait" is an available choice right now. */
  can_wait: boolean;
  expires_at: string;
  arrived_at: string;
  finished_at?: string;
  outcome?: string;
  error?: string;
  result_available: boolean;
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

/**
 * A queue decision surfacing through a contract that has no room for it.
 *
 * Deliberately an Error subclass and nothing more: the point is to be caught and re-thrown, never
 * handled. A catch that sees one and falls back to another model call has made two requests of one.
 */
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
  db: DatabaseSync;
  config?: InferenceGateConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: InferenceFetch;
  /** Where the health probe goes. Defaults to ADMINBOT_LOCAL_BASE_URL, then the vLLM default. */
  localBaseUrl?: string;
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
  const store = new InferenceQueueStore(options.db);
  const config = options.config ?? DEFAULT_INFERENCE_GATE_CONFIG;
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

  // The wait line, in the order rows joined it. The database is the durable copy; this is the
  // dispatch order and the place a waiting caller's promise lives.
  const waiting: Waiter[] = [];
  // Rows this process is running, keyed by id, so a second submission with the same key can wait on
  // the same call rather than making another.
  const active = new Map<string, Active>();
  let inFlight = 0;
  let started = false;
  let closed = false;
  let sweepTimer: NodeJS.Timeout | undefined;
  let healthTimer: NodeJS.Timeout | undefined;

  // Exponential moving average of service time, for the estimate a queued member is shown.
  let meanServiceMs: number | null = null;
  const health: InferenceHealth = {
    state: "ok",
    consecutive_probe_failures: 0,
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
    if (health.state === "down" || meanServiceMs === null) {
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
        const canWait = ahead < config.queue.maxDepth;
        return {
          ...base,
          ahead,
          estimated_wait_ms: estimate(ahead),
          can_wait: canWait,
          message: canWait
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
          message: `Waiting for the GPU, ${ahead} ahead of you.`,
        };
      }
      case "running":
        return { ...base, can_wait: false, message: "Running on the GPU." };
      case "completed":
        return { ...base, can_wait: false, message: "Done." };
      case "failed":
        return {
          ...base,
          can_wait: false,
          message:
            row.outcome === "interrupted"
              ? "The service restarted while this request was running, so its answer was lost. Resubmit it."
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

  /**
   * Runs one admitted row. The permit is taken by the caller of this function (arrival or pump) and
   * released here, in `finally`, after the body has been read -- so a permit is never held across
   * anything but the HTTP exchange itself.
   */
  async function execute(
    row: InferenceQueueRow,
    fetchImpl: InferenceFetch,
    callerSignal?: AbortSignal,
    apiKeyInMemory?: string,
  ): Promise<InferenceOutcome> {
    const request = row.request;
    const admittedAt = row.admitted_at ?? timestamp();
    const startedAt = Date.now();
    auditRow("inference.admitted", row, {
      wait_ms: waitedMs(row, admittedAt),
      timeout_ms: row.timeout_ms,
    });
    let outcome: InferenceOutcome;
    try {
      if (!request) {
        throw new Error("request body is no longer stored");
      }
      // The timeout starts here, at admission -- see the file header.
      const timeout = AbortSignal.timeout(row.timeout_ms);
      const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
      const base = assertLoopbackUrl(request.baseUrl, `${request.purpose} inference`);
      const apiKey =
        apiKeyInMemory || (request.apiKeyEnv ? env[request.apiKeyEnv]?.trim() : undefined);
      let response: Awaited<ReturnType<InferenceFetch>>;
      let text: string;
      try {
        response = await fetchImpl(`${base}${request.route}`, {
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
        });
        text = await response.text();
      } catch (error) {
        const kind: InferenceFailureKind = callerSignal?.aborted
          ? "cancelled"
          : timeout.aborted
            ? "timeout"
            : "error";
        const message = error instanceof Error ? error.message : String(error);
        outcome = { kind: "failed", id: row.id, failure: kind, error: message, cause: error };
        finishFailed(row, kind, message, undefined, Date.now() - startedAt);
        return outcome;
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
        finishFailed(row, kind, message, record, durationMs);
        return outcome;
      }
      const finishedAt = timestamp();
      store.transaction(() => {
        store.finishCompleted(row.id, finishedAt, record);
        auditRow("inference.completed", row, {
          outcome: "completed",
          wait_ms: waitedMs(row, admittedAt),
          duration_ms: durationMs,
          http_status: response.status,
        });
      });
      meanServiceMs = meanServiceMs === null ? durationMs : meanServiceMs * 0.7 + durationMs * 0.3;
      health.last_inference_ok_at = finishedAt;
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
      finishFailed(row, "error", message, undefined, Date.now() - startedAt);
      return { kind: "failed", id: row.id, failure: "error", error: message, cause: error };
    }
  }

  function finishFailed(
    row: InferenceQueueRow,
    kind: InferenceFailureKind,
    message: string,
    response: InferenceResponseRecord | undefined,
    durationMs: number,
  ) {
    const finishedAt = timestamp();
    store.transaction(() => {
      store.finishFailed(row.id, finishedAt, kind, message, response);
      auditRow("inference.failed", row, {
        outcome: kind,
        // The message, never the prompt: a model error can quote the request back, and the audit
        // table is read by more people than the queue table is.
        error: message.slice(0, 300),
        wait_ms: row.admitted_at ? waitedMs(row, row.admitted_at) : undefined,
        duration_ms: durationMs,
      });
    });
    if (kind === "timeout") {
      health.inference_timeouts += 1;
    } else if (kind !== "cancelled") {
      health.inference_failures += 1;
    }
    if (kind === "timeout" || kind === "error") {
      // Two timeouts with nothing succeeding in between is the shape of a hung server that still
      // answers /v1/models; the probe alone would never notice.
      health.state = health.state === "down" ? "down" : "degraded";
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
    if (closed) {
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
      if (!store.claim(waiter.id, processId, at)) {
        // Somebody else changed the row under us (a sweep expired it, a cancel failed it). Whatever
        // they wrote is the answer.
        const current = store.get(waiter.id);
        const outcome: InferenceOutcome = current
          ? current.status === "completed" && current.result
            ? { kind: "completed", id: current.id, response: current.result, waitMs: 0 }
            : current.status === "expired"
              ? { kind: "expired", id: current.id, status: statusOf(current) }
              : {
                  kind: "failed",
                  id: current.id,
                  failure: (current.outcome as InferenceFailureKind) ?? "error",
                  error: current.error ?? "request was not admitted",
                }
          : { kind: "refused", reason: "request row vanished" };
        for (const resolve of waiter.resolvers) {
          resolve(outcome);
        }
        continue;
      }
      const claimed = { ...row, status: "running" as const, admitted_at: at, claimed_at: at };
      const run = track(
        claimed.id,
        execute(claimed, transportFor(waiter.fetchImpl), waiter.signal, waiter.apiKey),
      );
      for (const resolve of waiter.resolvers) {
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

  function enqueue(row: InferenceQueueRow, request: InferenceGateRequest): Promise<InferenceOutcome> {
    return new Promise<InferenceOutcome>((resolve) => {
      const waiter: Waiter = {
        id: row.id,
        resolvers: [resolve],
        ...(request.fetchImpl ? { fetchImpl: request.fetchImpl } : {}),
        ...(request.apiKey ? { apiKey: request.apiKey } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      };
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
            auditRow("inference.failed", row, { outcome: "cancelled", wait_ms: waitedMs(row, timestamp()) });
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
      waiting.push(waiter);
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
    };

    if (request.signal?.aborted) {
      return { kind: "failed", id: row.id, failure: "cancelled", error: "cancelled before arrival" };
    }

    // Slot free and nobody ahead: run. Somebody ahead means the slot is theirs the moment pump runs.
    if (inFlight < config.capacity && waiting.length === 0) {
      store.transaction(() => {
        store.insertRunning(row, processId);
      });
      const running = { ...row, status: "running" as const, admitted_at: arrivedAt, claimed_at: arrivedAt };
      return track(
        row.id,
        execute(running, transportFor(request.fetchImpl), request.signal, request.apiKey),
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
  function attach(row: InferenceQueueRow, request: InferenceGateRequest): Promise<InferenceOutcome> {
    switch (row.status) {
      case "completed":
        return Promise.resolve(
          row.result
            ? { kind: "completed", id: row.id, response: row.result, waitMs: 0 }
            : { kind: "expired", id: row.id, status: statusOf(row) },
        );
      case "running": {
        const current = active.get(row.id);
        return current ? current.promise : Promise.resolve({ kind: "queued", id: row.id, status: statusOf(row) });
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
          if (converted?.state === "queued") {
            const waiter = waiting.find((entry) => entry.id === row.id);
            if (waiter) {
              return new Promise((resolve) => waiter.resolvers.push(resolve));
            }
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
      if (waiting.length >= config.queue.maxDepth) {
        return false;
      }
      if (!store.convertToQueued(id, at)) {
        return false;
      }
      auditRow("inference.waited", fresh, { position: waiting.length, wait_ms: waitedMs(fresh, at) });
      return true;
    });
    if (converted) {
      const queued = store.get(id) as InferenceQueueRow;
      void enqueue(queued, { owner, caller: queued.caller, request: queued.request as InferenceRequestRecord });
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

  function setPreferences(owner: string, next: MemberInferencePreferences): MemberInferencePreferences {
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
    const at = timestamp();
    let interrupted = 0;
    let expired = 0;
    let readmitted = 0;
    for (const row of store.listByStatus("running")) {
      store.transaction(() => {
        store.finishFailed(row.id, at, "interrupted", "the service restarted while this request was running");
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
    const base = assertLoopbackUrl(localBaseUrl, "inference health probe");
    try {
      const response = await defaultFetch(`${base}models`, {
        method: "GET",
        headers: { Accept: "application/json" },
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
      if (health.state === "down") {
        health.state = health.inference_timeouts > 0 && !recentInferenceSuccess() ? "degraded" : "ok";
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
    const conditions: Array<[InferenceEscalationTrigger, boolean, InferenceEscalation]> = [
      [
        "queue_age",
        (oldestQueuedAgeMs() ?? 0) > config.escalate.queueAgeMs,
        {
          trigger: "queue_age",
          summary: `Inference requests have been waiting more than ${Math.round(config.escalate.queueAgeMs / 1000)}s for the GPU`,
          details: { oldest_queued_age_ms: oldestQueuedAgeMs(), queue_depth: depth(), in_flight: inFlight },
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
        health.consecutive_probe_failures >= config.escalate.healthFailures || health.state === "down",
        {
          trigger: "health",
          summary: `The local model at ${localBaseUrl} has failed ${health.consecutive_probe_failures} health checks in a row`,
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
      if (proposalId) {
        armed.set(trigger, { proposal_id: proposalId });
      }
      store.audit({
        type: "inference.escalation_proposed",
        actor: "system:inference-gate",
        ...(proposalId ? { action_id: proposalId } : {}),
        details: { trigger, summary: escalation.summary, ...escalation.details, queue_depth: depth(), in_flight: inFlight },
      });
    }
  }

  function start(): ReturnType<typeof recover> {
    if (started) {
      return { interrupted: 0, expired: 0, readmitted: 0 };
    }
    started = true;
    const recovered = recover();
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
    stats,
    config,
    processId,
    /** The handle this gate writes to. Exposed so a server can build a durable gate on the same file. */
    database: options.db,
  };
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

/**
 * The gate every caller uses when none is handed to it. The server registers its durable one at
 * startup; a caller built before that (or in a test) gets an in-memory gate with the same counter
 * semantics, so there is never a second counter in the process -- only, at worst, a non-durable one.
 */
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

/**
 * A task owns the application result; model calls are checkpoints, never task completion.
 * Only explicit retry re-enters uncertain non-replay-safe steps. Shutdown bounds even
 * transports that ignore abort; every continuation checks cancellation before SQLite access.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import {
  taskContextStorage,
  taskStepAttemptStorage,
  type TaskContext,
  type TaskStepOptions,
} from "./context.js";
import {
  encode,
  inputHash,
  TaskStore,
  type TaskRecord,
  type TaskStatus,
  type StepRecord,
} from "./store.js";
export type { TaskRecord, TaskStatus } from "./store.js";
export type TaskSubmission = {
  id: string;
  status: TaskStatus;
  task: TaskRecord;
  result?: unknown;
  promise?: Promise<TaskRecord>;
};
export type TaskRuntimeOptions = {
  db?: DatabaseSync;
  persist?: boolean;
  maxRunning?: number;
  maxTasks?: number;
  maxQueued?: number;
  maxInFlightPerOwner?: number;
  maxInputBytes?: number;
  maxResultBytes?: number;
  maxSteps?: number;
  maxRetainedBytes?: number;
  maxAttempts?: number;
  retentionMs?: number;
  canStart?: () => boolean;
  canDispatch?: () => boolean;
  now?: () => number;
};
type Handler = (input: unknown, ctx: TaskContext) => unknown | Promise<unknown>;
const terminal = new Set<TaskStatus>([
  "completed",
  "failed",
  "needs_retry",
  "cancelled",
  "expired",
]);
export class TaskNeedsRetryError extends Error {
  override name = "TaskNeedsRetryError";
}
export class TaskInterruptedError extends Error {
  override name = "TaskInterruptedError";
}
export class TaskRuntime {
  readonly store: TaskStore;
  private readonly options: Required<Omit<TaskRuntimeOptions, "db" | "canStart" | "canDispatch">> &
    Pick<TaskRuntimeOptions, "canStart" | "canDispatch">;
  private readonly handlers = new Map<string, Handler>();
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly waiters = new Map<
    string,
    { promise: Promise<TaskRecord>; resolve: (r: TaskRecord) => void }
  >();
  private readonly ownDb: boolean;
  /** Dispatch sequence number per owner, so the least recently served goes first. */
  private readonly ownerLastServed = new Map<string, number>();
  private dispatchSequence = 0;
  private started = false;
  private paused = false;
  private stopping = false;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(options: TaskRuntimeOptions = {}) {
    this.ownDb = !options.db;
    this.options = {
      persist: false,
      maxRunning: 32,
      maxTasks: 1000,
      maxQueued: 32,
      // A share of the waiting line, not a quota on the member. Eight owners can each hold one
      // share of a 32-deep queue, which is the mix a lab of this size actually produces.
      maxInFlightPerOwner: 4,
      maxInputBytes: 2_000_000,
      maxResultBytes: 4_000_000,
      maxSteps: 10000,
      maxRetainedBytes: 64_000_000,
      maxAttempts: 20000,
      retentionMs: 24 * 60 * 60 * 1000,
      now: Date.now,
      ...options,
    };
    for (const key of [
      "maxRunning",
      "maxTasks",
      "maxQueued",
      "maxInFlightPerOwner",
      "maxInputBytes",
      "maxResultBytes",
      "maxSteps",
      "retentionMs",
      "maxRetainedBytes",
      "maxAttempts",
    ] as const) {
      if (
        !Number.isSafeInteger(this.options[key]) ||
        this.options[key] < (key === "maxQueued" ? 0 : 1)
      ) {
        throw new Error(`Invalid task runtime ${key}`);
      }
    }
    if (this.options.persist && this.ownDb) {
      throw new Error("Durable task runtime requires a file-backed database");
    }
    const db =
      options.db ??
      new (
        createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")
      ).DatabaseSync(":memory:");
    this.store = new TaskStore(db, this.options.persist);
  }
  register<I = unknown, R = unknown>(
    kind: string,
    version: number,
    handler: (input: I, ctx: TaskContext) => R | Promise<R>,
  ): void {
    const key = `${kind}:${version}`;
    if (this.handlers.has(key)) {
      throw new Error(`Task handler already registered: ${key}`);
    }
    this.handlers.set(key, handler as Handler);
  }
  start(): void {
    if (this.started) {
      return;
    }
    if (this.closed) {
      throw new Error("Task runtime closed");
    }
    this.store.acquire();
    this.started = true;
    for (const id of this.store.idsByStatus("running")) {
      const task = this.store.get(id)!;
      if (task.status === "running") {
        let uncertain = false;
        for (const step of this.store.stepsWithStatus(task.id, "running")) {
          if (step.status === "running") {
            if (!step.replaySafe) {
              step.status = "uncertain";
              this.store.saveStep(task.id, step);
              uncertain = true;
            }
          }
        }
        this.update(
          task,
          uncertain ? "needs_retry" : "queued",
          uncertain ? "Process interrupted a step; explicit retry required" : undefined,
        );
      }
    }
    this.timer = setInterval(() => this.drain(), 100);
    this.timer.unref();
    this.drain();
  }
  private assertOpen(): void {
    if (this.closed || this.stopping) {
      throw new Error("Task runtime is shutting down");
    }
    if (!this.started) {
      this.start();
    }
  }
  get(id: string, owner?: string): TaskRecord | undefined {
    if (this.closed) {
      return undefined;
    }
    const task = this.store.get(id);
    if (!task || (owner !== undefined && task.owner !== owner)) {
      return undefined;
    }
    return task;
  }
  list(owner?: string): TaskRecord[] {
    if (this.closed) {
      return [];
    }
    return this.store.all(owner);
  }
  steps(id: string, owner?: string): StepRecord[] {
    return this.get(id, owner) ? this.store.journal(id) : [];
  }
  private update(task: TaskRecord, status: TaskStatus, error?: string): TaskRecord {
    task.status = status;
    task.updatedAt = this.options.now();
    task.error = error?.slice(0, 2000);
    this.store.transaction(() => {
      this.store.save(task);
      this.store.audit(task, `task.${status}`);
    });
    if (terminal.has(status)) {
      this.notify(task);
    }
    return task;
  }
  private notify(task: TaskRecord): void {
    this.waiters.get(task.id)?.resolve(task);
    this.waiters.delete(task.id);
  }
  private submission(task: TaskRecord): TaskSubmission {
    const value: TaskSubmission = { id: task.id, status: task.status, task, result: task.result };
    if (!terminal.has(task.status) && task.status !== "shed") {
      let waiter = this.waiters.get(task.id);
      if (!waiter) {
        let resolve!: (r: TaskRecord) => void;
        const promise = new Promise<TaskRecord>((done) => {
          resolve = done;
        });
        waiter = { promise, resolve };
        this.waiters.set(task.id, waiter);
      }
      value.promise = waiter.promise;
    }
    return value;
  }
  submit(params: {
    kind: string;
    version?: number;
    owner: string;
    key?: string;
    input: unknown;
    wait?: boolean;
  }): TaskSubmission {
    this.assertOpen();
    this.expire();
    if (
      !params.owner ||
      params.owner.length > 512 ||
      !params.kind ||
      params.kind.length > 128 ||
      (params.key !== undefined && !params.key.trim()) ||
      (params.key?.length ?? 0) > 256
    ) {
      throw new Error("Invalid task identity");
    }
    const version = params.version ?? 1;
    const input = JSON.parse(encode(params.input, this.options.maxInputBytes)) as unknown;
    const previous = params.key ? this.store.findSubmission(params.owner, params.key) : undefined;
    if (previous) {
      if (previous.status === "expired") {
        return this.submission(previous);
      }
      if (
        previous.kind !== params.kind ||
        previous.version !== version ||
        inputHash(previous.input) !== inputHash(input)
      ) {
        throw new Error("Submission key already belongs to different task input");
      }
      return this.submission(previous);
    }
    if (this.store.count() >= this.options.maxTasks) {
      throw new Error("Task retention capacity exhausted; retry after expiry");
    }
    if (!this.handlers.has(`${params.kind}:${version}`)) {
      throw new Error(`Unsupported task workflow ${params.kind} version ${version}`);
    }
    const now = this.options.now();
    const task: TaskRecord = {
      id: randomUUID(),
      kind: params.kind,
      version,
      owner: params.owner,
      key: params.key,
      input,
      status: this.admissionStatus(params.owner, params.wait ?? false),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.options.retentionMs,
    };
    this.ensureCapacity(task);
    this.store.transaction(() => {
      this.store.save(task);
      this.store.audit(task, "task.accepted");
    });
    this.drain();
    return this.submission(this.store.get(task.id)!);
  }
  wait(id: string, owner?: string): TaskSubmission | undefined {
    this.assertOpen();
    this.expire();
    const task = this.get(id, owner);
    if (!task) {
      return;
    }
    if (task.status === "shed") {
      this.update(task, this.admissionStatus(task.owner, true));
    }
    this.drain();
    return this.submission(this.store.get(id)!);
  }
  retry(id: string, owner?: string): TaskSubmission | undefined {
    this.assertOpen();
    this.expire();
    const task = this.get(id, owner);
    if (!task) {
      return;
    }
    if (task.status === "needs_retry" || task.status === "failed") {
      this.store.resetUncertain(id);
      this.update(task, this.admissionStatus(task.owner, true));
    }
    this.drain();
    return this.submission(this.store.get(id)!);
  }
  cancel(id: string, owner?: string): TaskRecord | undefined {
    this.assertOpen();
    const task = this.get(id, owner);
    if (!task) {
      return;
    }
    if (!terminal.has(task.status)) {
      this.update(task, "cancelled", "Cancelled by owner");
      this.active.get(id)?.controller.abort(new TaskInterruptedError("Task cancelled"));
    }
    return task;
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.assertOpen();
    this.paused = false;
    this.drain();
  }
  metrics() {
    const storedCounts = this.closed ? {} : this.store.counts();
    const counts = Object.fromEntries(
      (
        [
          "shed",
          "queued",
          "running",
          "completed",
          "failed",
          "needs_retry",
          "cancelled",
          "expired",
        ] as TaskStatus[]
      ).map((status) => [status, storedCounts[status] ?? 0]),
    ) as Record<TaskStatus, number>;
    return {
      persist: this.options.persist,
      paused: this.paused,
      stopping: this.stopping,
      active: this.active.size,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      maxRunning: this.options.maxRunning,
      maxTasks: this.options.maxTasks,
      maxQueued: this.options.maxQueued,
      maxInFlightPerOwner: this.options.maxInFlightPerOwner,
      // Every read here has to survive a call made after shutdown: an operator dashboard polling
      // metrics does not stop the instant the database closes.
      retainedBytes: this.closed ? 0 : this.store.retainedBytes(),
      maxRetainedBytes: this.options.maxRetainedBytes,
      counts,
      ...counts,
    };
  }
  private admissionStatus(owner: string, wait: boolean): "queued" | "shed" {
    // The share binds first, and it binds even when the service is idle. An earlier version let
    // an idle service admit anything, reasoning that a share divides a contended line and there
    // was no line to divide. That is wrong: submit() drains after every admission, so the queue
    // count returns to zero between submissions in one burst, the carve-out re-arms every time,
    // and one owner reaches maxRunning. Measured at 20 running against a share of 4. "Idle right
    // now" is not a reason to let one member take every running slot on a box the lab shares.
    if (this.store.countInFlightForOwner(owner) >= this.options.maxInFlightPerOwner) {
      return "shed";
    }
    const queued = this.store.count("queued");
    const immediate =
      queued === 0 &&
      !this.paused &&
      this.active.size < this.options.maxRunning &&
      (this.options.canStart?.() ?? true);
    if (immediate) {
      return "queued";
    }
    // Past the shared line the task is saved, not refused: the member keeps a row and a Wait,
    // which is the status they would have seen from a full queue.
    return !wait || queued >= this.options.maxQueued ? "shed" : "queued";
  }
  /**
   * Queued ids, ordered least-recently-served owner first rather than by arrival.
   *
   * Without this the share above is not enough: one owner whose burst is already dispatched
   * still puts every later arrival behind all of it.
   *
   * An earlier version tracked only the owner served last and resumed after it. That is wrong
   * whenever that owner has no rows left, which is the common case for anyone who submitted
   * once: the index lookup misses, the cursor falls back to the head of the list, and the head
   * is whoever holds the oldest queued row -- the owner with the standing backlog. Measured, it
   * gave that owner every second dispatch no matter how many others were waiting. Ordering by
   * when each owner was last served has no such fallback, and does not care whether an owner
   * leaves the queue and comes back.
   */
  /**
   * Bound the turn map. An owner with nothing queued and nothing running is not competing, so
   * forgetting them costs only that they count as never-served if they come back -- which is
   * what an idle owner should be. Pruning is O(owners) and runs only when the map is large.
   */
  private forgetIdleOwners(): void {
    if (this.ownerLastServed.size <= this.options.maxTasks) {
      return;
    }
    const competing = new Set<string>();
    for (const id of this.active.keys()) {
      const owner = this.store.get(id)?.owner;
      if (owner) {
        competing.add(owner);
      }
    }
    for (const row of this.store.queuedByOwner()) {
      competing.add(row.owner);
    }
    for (const owner of this.ownerLastServed.keys()) {
      if (!competing.has(owner)) {
        this.ownerLastServed.delete(owner);
      }
    }
  }
  private queuedInTurn(): string[] {
    const byOwner = new Map<string, string[]>();
    for (const row of this.store.queuedByOwner()) {
      const queue = byOwner.get(row.owner);
      if (queue) {
        queue.push(row.id);
      } else {
        byOwner.set(row.owner, [row.id]);
      }
    }
    // Insertion order is arrival order, so a stable sort leaves owners never served before --
    // and owners served in the same pass -- in the order their oldest row arrived.
    const owners = [...byOwner.keys()].sort(
      (a, b) => (this.ownerLastServed.get(a) ?? -1) - (this.ownerLastServed.get(b) ?? -1),
    );
    if (owners.length < 2) {
      return owners.length ? byOwner.get(owners[0]!)! : [];
    }
    const start = 0;
    const order: string[] = [];
    for (let round = 0; ; round += 1) {
      let added = false;
      for (let step = 0; step < owners.length; step += 1) {
        const queue = byOwner.get(owners[(start + step) % owners.length]!)!;
        if (round < queue.length) {
          order.push(queue[round]!);
          added = true;
        }
      }
      if (!added) {
        return order;
      }
    }
  }
  private expire(): void {
    const now = this.options.now();
    for (const metadata of this.store.expirable(now)) {
      if (this.active.has(metadata.id) && !terminal.has(metadata.status)) {
        continue;
      }
      const task = this.store.get(metadata.id)!;
      if (task.status === "expired") {
        this.store.remove(task.id);
      } else {
        task.result = undefined;
        task.input = null;
        task.progress = undefined;
        this.store.clearContent(task.id);
        this.update(task, "expired", "Task expired; resubmit the original input");
        task.expiresAt = now + Math.min(this.options.retentionMs, 60_000);
        this.store.save(task);
      }
    }
  }
  private drain(): void {
    if (!this.started || this.closed || this.stopping) {
      return;
    }
    this.expire();
    if (this.paused) {
      return;
    }
    for (const id of this.queuedInTurn()) {
      // Accepted waiting tasks must reach the model gate's FIFO even while its
      // permits are busy; admission shedding and dispatch pause are separate decisions.
      if (
        this.active.size >= this.options.maxRunning ||
        !((this.options.canDispatch ?? this.options.canStart)?.() ?? true)
      ) {
        break;
      }
      if (this.active.has(id)) {
        continue;
      }
      const task = this.store.get(id)!;
      const handler = this.handlers.get(`${task.kind}:${task.version}`);
      if (!handler) {
        this.update(
          task,
          "needs_retry",
          `Unsupported workflow ${task.kind} version ${task.version}; install its handler before retrying`,
        );
        continue;
      }
      this.update(task, "running");
      this.ownerLastServed.set(task.owner, (this.dispatchSequence += 1));
      this.forgetIdleOwners();
      const controller = new AbortController();
      const done = Promise.resolve()
        .then(() => this.execute(task, handler, controller))
        .finally(() => {
          this.active.delete(task.id);
          this.drain();
        });
      this.active.set(task.id, { controller, done });
    }
  }
  private async execute(
    task: TaskRecord,
    handler: Handler,
    controller: AbortController,
  ): Promise<void> {
    const signal = controller.signal;
    const check = () => {
      if (signal.aborted || this.closed) {
        throw new TaskInterruptedError("Task interrupted");
      }
      if (this.stopping) {
        throw new TaskInterruptedError("Task suspended for shutdown");
      }
    };
    const finish = <T>(step: StepRecord, value: T): T => {
      if (signal.aborted || this.closed) {
        throw new TaskInterruptedError("Task interrupted");
      }
      const result = JSON.parse(encode(value, this.options.maxResultBytes)) as T;
      this.ensureCapacity(result);
      step.status = "completed";
      step.result = result;
      this.store.transaction(() => {
        this.store.saveStep(task.id, step);
        this.store.audit(task, "task.step.completed", step);
      });
      return result;
    };
    const prepare = (key: string, input: unknown, options?: TaskStepOptions): StepRecord => {
      check();
      if (
        options?.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) ||
          options.timeoutMs < 1 ||
          options.timeoutMs > 2_147_483_647)
      ) {
        throw new Error(
          "Task step timeout must be an integer between 1 and 2147483647 milliseconds",
        );
      }
      if (!key || key.length > 512) {
        throw new Error("Invalid checkpoint key");
      }
      const hash = inputHash(input);
      const old = this.store.step(task.id, key);
      if (old) {
        if (old.hash !== hash) {
          throw new Error(`Checkpoint input changed: ${key}`);
        }
        if (old.status === "completed") {
          return old;
        }
        if (!old.replaySafe) {
          throw new TaskNeedsRetryError(`Checkpoint ${key} requires explicit retry`);
        }
      }
      // Bound outstanding continuations as well as journal history. This also reserves
      // enough metadata space to mark every in-flight step uncertain at interruption.
      if (this.store.stepCount(task.id, "running") >= 128) {
        throw new Error("Task concurrent checkpoint limit exceeded");
      }
      if (this.store.attemptCount(task.id) >= this.options.maxAttempts) {
        throw new Error("Task attempt limit exceeded; submit a new task");
      }
      if (!old && this.store.stepCount(task.id) >= this.options.maxSteps) {
        throw new Error("Task checkpoint limit exceeded");
      }
      const prepared: StepRecord = {
        key,
        hash,
        status: "running",
        attempt: randomUUID(),
        replaySafe: options?.replaySafe,
      };
      this.ensureCapacity({ step: prepared, attempt: prepared });
      return prepared;
    };
    const ctx: TaskContext = {
      id: task.id,
      owner: task.owner,
      signal,
      check,
      progress: (value: Record<string, unknown>): void => {
        check();
        this.ensureCapacity(value);
        task.progress = JSON.parse(
          encode(value, Math.min(this.options.maxResultBytes, 64_000)),
        ) as Record<string, unknown>;
        task.updatedAt = this.options.now();
        this.store.save(task);
      },
      step: async <T>(
        key: string,
        input: unknown,
        fn: () => T | Promise<T>,
        options?: TaskStepOptions,
      ): Promise<T> => {
        const step = prepare(key, input, options);
        if (step.status === "completed") {
          return step.result as T;
        }
        this.store.transaction(() => {
          this.store.saveStep(task.id, step);
          this.store.audit(task, "task.step.running", step);
        });
        try {
          const value = await this.bound(
            taskStepAttemptStorage.run(step.attempt, () =>
              Promise.resolve().then(() => {
                check();
                return fn();
              }),
            ),
            signal,
            options?.timeoutMs,
          );
          return finish(step, value);
        } catch (error) {
          if (!this.closed && this.store.step(task.id, step.key)?.attempt === step.attempt) {
            step.status = "uncertain";
            this.store.saveStep(task.id, step);
          }
          if (error instanceof TaskInterruptedError || options?.replaySafe) {
            throw error;
          }
          throw new TaskNeedsRetryError(error instanceof Error ? error.message : String(error));
        }
      },
      commit: <T>(key: string, input: unknown, fn: () => T): T => {
        const step = prepare(key, input, { replaySafe: true });
        if (step.status === "completed") {
          return step.result as T;
        }
        return this.store.transaction(() => {
          check();
          const value = fn();
          if (value && typeof (value as { then?: unknown }).then === "function") {
            throw new Error("Task commits must be synchronous");
          }
          return finish(step, value);
        });
      },
    };
    try {
      check();
      const result = await this.bound(
        taskContextStorage.run(ctx, () => Promise.resolve(handler(task.input, ctx))),
        signal,
      );
      if (signal.aborted || this.closed) {
        return;
      }
      if (this.store.hasUncertainStep(task.id)) {
        throw new TaskNeedsRetryError("Unsettled checkpoint requires explicit retry");
      }
      const encodedResult = JSON.parse(encode(result, this.options.maxResultBytes)) as unknown;
      this.ensureCapacity(encodedResult);
      task.result = encodedResult;
      this.update(task, "completed");
    } catch (error) {
      if (this.closed || this.store.get(task.id)?.status === "cancelled") {
        return;
      }
      controller.abort(new TaskInterruptedError("Task handler stopped"));
      // This is the last error boundary, and every line in it touches SQLite. A store failure
      // here -- SQLITE_BUSY from a maintenance script writing the same file, a full disk --
      // would otherwise reject `done`, which nothing awaits, leaving the task at `running`,
      // absent from `active`, and its waiter unsettled: the member's Wait hangs until restart.
      // Recording `failed` is a second chance to reach a terminal state; if even that fails
      // there is nothing left to write, so say so where an operator will see it.
      try {
        for (const step of this.store.stepsWithStatus(task.id, "running")) {
          if (step.status === "running" && !step.replaySafe) {
            step.status = "uncertain";
            this.store.saveStep(task.id, step);
          }
        }
        const uncertain = this.store.hasUncertainStep(task.id, true);
        const suspended = error instanceof TaskInterruptedError && this.stopping;
        this.update(
          task,
          uncertain ? "needs_retry" : suspended && this.options.persist ? "queued" : "failed",
          error instanceof Error ? error.message : String(error),
        );
      } catch (recordingFailure) {
        try {
          this.update(task, "failed", "The task failed and its outcome could not be recorded");
        } catch {
          console.error(
            `[adminbot] task ${task.id} could not be moved to a terminal state`,
            recordingFailure,
          );
          this.notify(task);
        }
      }
    }
  }
  private ensureCapacity(value: unknown): void {
    // Keep per-task headroom for bounded error text and cancellation/uncertainty status
    // writes so exhausting payload storage never prevents recording the final outcome.
    if (
      this.store.retainedBytes() +
        Buffer.byteLength(encode(value, this.options.maxRetainedBytes)) +
        (this.store.count() + 1) * 2300 >
      this.options.maxRetainedBytes
    ) {
      throw new Error("Task retained content capacity exhausted");
    }
  }
  private bound<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        if (timer) {
          clearTimeout(timer);
        }
      };
      const abort = () => {
        cleanup();
        reject(new TaskInterruptedError("Task interrupted"));
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          reject(new TaskNeedsRetryError("Task step timed out; explicit retry required"));
        }, timeoutMs);
      }
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }
  async shutdown(options: { graceMs?: number | (() => number) } = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    const begin = Date.now();
    const grace = () =>
      Math.max(
        0,
        typeof options.graceMs === "function" ? options.graceMs() : (options.graceMs ?? 360_000),
      );
    while (this.active.size && Date.now() - begin < grace()) {
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(50, Math.max(1, grace() - (Date.now() - begin))));
      });
    }
    for (const entry of this.active.values()) {
      entry.controller.abort(new TaskInterruptedError("Shutdown grace expired"));
    }
    await Promise.all([...this.active.values()].map((a) => a.done));
    const remaining = (["shed", "queued", "running"] as TaskStatus[]).flatMap((status) =>
      this.store.idsByStatus(status),
    );
    for (const id of remaining) {
      const task = this.store.get(id)!;
      if (!terminal.has(task.status)) {
        if (!this.options.persist) {
          this.update(task, "failed", "Service stopped; resubmit input");
        } else {
          this.notify(task);
        }
      }
    }
    this.store.release();
    this.closed = true;
    if (this.ownDb) {
      this.store.db.close();
    }
  }
}

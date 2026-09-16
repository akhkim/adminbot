import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";

export type TaskStatus =
  | "shed"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "needs_retry"
  | "cancelled"
  | "expired";
export type TaskRecord = {
  id: string;
  owner: string;
  kind: string;
  version: number;
  key?: string;
  input: unknown;
  status: TaskStatus;
  result?: unknown;
  progress?: Record<string, unknown>;
  error?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};
export type StepRecord = {
  key: string;
  hash: string;
  status: "running" | "completed" | "uncertain";
  attempt: string;
  replaySafe?: boolean;
  result?: unknown;
};
export function encode(value: unknown, limit: number): string {
  const json = JSON.stringify(value === undefined ? null : value);
  if (json === undefined || Buffer.byteLength(json) > limit) {
    throw new Error("Task content exceeds configured size limit");
  }
  return json;
}
export function inputHash(value: unknown): string {
  const normalize = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .toSorted(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, normalize(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(normalize(value === undefined ? null : value)))
    .digest("hex");
}
function bootIdentity(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return hostname();
  }
}
function processIdentity(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[19];
  } catch {
    return "unknown";
  }
}
export class TaskStore {
  readonly table: string;
  readonly steps: string;
  private readonly lock = randomUUID();
  private ownsLock = false;
  constructor(
    readonly db: DatabaseSync,
    readonly persist = false,
  ) {
    const p = persist ? "" : "TEMP";
    this.table = persist ? "adminbot_tasks" : "adminbot_transient_tasks";
    this.steps = `${this.table}_steps`;
    db.exec(`CREATE ${p} TABLE IF NOT EXISTS ${this.table} (id TEXT PRIMARY KEY, owner TEXT NOT NULL, submission_key TEXT, record TEXT NOT NULL, UNIQUE(owner, submission_key));
      CREATE ${p} TABLE IF NOT EXISTS ${this.steps} (task_id TEXT NOT NULL, step_key TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(task_id,step_key));
      CREATE ${p} TABLE IF NOT EXISTS ${this.steps}_attempts (task_id TEXT NOT NULL, step_key TEXT NOT NULL, attempt TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(task_id,step_key,attempt));`);
    // Expression indexes migrate existing journals without rewriting their serialized
    // contract. Polling and capacity checks read these small index entries, not bodies.
    db.exec(`CREATE INDEX IF NOT EXISTS ${this.table}_status_idx ON ${this.table}(json_extract(record,'$.status'));
      CREATE INDEX IF NOT EXISTS ${this.table}_expiry_idx ON ${this.table}(json_extract(record,'$.expiresAt'),json_extract(record,'$.status'),id);
      CREATE INDEX IF NOT EXISTS ${this.steps}_status_idx ON ${this.steps}(task_id,json_extract(record,'$.status'),json_extract(record,'$.replaySafe'));`);
    for (const table of [this.table, this.steps, `${this.steps}_attempts`]) {
      db.exec(
        `CREATE INDEX IF NOT EXISTS ${table}_bytes_idx ON ${table}(length(CAST(record AS BLOB)))`,
      );
    }
    db.exec(
      "CREATE TABLE IF NOT EXISTS adminbot_audit_events (id TEXT PRIMARY KEY,action_id TEXT,event_type TEXT NOT NULL,timestamp TEXT NOT NULL,actor TEXT,event_json TEXT NOT NULL)",
    );
    if (persist) {
      db.exec(
        "CREATE TABLE IF NOT EXISTS adminbot_task_runner_lock (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL,pid INTEGER NOT NULL,boot TEXT NOT NULL,process TEXT NOT NULL)",
      );
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT adminbot_task_commit");
    try {
      const value = fn();
      this.db.exec("RELEASE adminbot_task_commit");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK TO adminbot_task_commit; RELEASE adminbot_task_commit");
      throw error;
    }
  }
  acquire(): void {
    if (this.ownsLock) {
      return;
    }
    if (!this.persist) {
      this.ownsLock = true;
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM adminbot_task_runner_lock WHERE id=1").get() as
        | { pid: number; boot: string; process: string }
        | undefined;
      if (row && row.boot === bootIdentity()) {
        let alive = true;
        try {
          process.kill(row.pid, 0);
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
        }
        if (
          alive &&
          (row.process === "unknown" ||
            processIdentity(row.pid) === "unknown" ||
            row.process === processIdentity(row.pid))
        ) {
          throw new Error("Another live process owns the durable task runtime");
        }
      }
      this.db
        .prepare("INSERT OR REPLACE INTO adminbot_task_runner_lock VALUES(1,?,?,?,?)")
        .run(this.lock, process.pid, bootIdentity(), processIdentity(process.pid));
      this.db.exec("COMMIT");
      this.ownsLock = true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  release(): void {
    if (this.persist && this.ownsLock) {
      this.db.prepare("DELETE FROM adminbot_task_runner_lock WHERE token=?").run(this.lock);
    }
    this.ownsLock = false;
  }
  all(owner?: string): TaskRecord[] {
    return (
      (owner === undefined
        ? this.db.prepare(`SELECT record FROM ${this.table} ORDER BY rowid`).all()
        : this.db
            .prepare(`SELECT record FROM ${this.table} WHERE owner=? ORDER BY rowid`)
            .all(owner)) as {
        record: string;
      }[]
    ).map((r) => JSON.parse(r.record) as TaskRecord);
  }
  findSubmission(owner: string, key: string): TaskRecord | undefined {
    const row = this.db
      .prepare(`SELECT record FROM ${this.table} WHERE owner=? AND submission_key=?`)
      .get(owner, key) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as TaskRecord) : undefined;
  }
  count(status?: TaskStatus): number {
    const row =
      status === undefined
        ? this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.table}`).get()
        : this.db
            .prepare(
              `SELECT COUNT(*) AS n FROM ${this.table} WHERE json_extract(record,'$.status')=?`,
            )
            .get(status);
    return (row as { n: number }).n;
  }
  counts(): Partial<Record<TaskStatus, number>> {
    const rows = this.db
      .prepare(
        `SELECT json_extract(record,'$.status') AS status, COUNT(*) AS n FROM ${this.table} GROUP BY json_extract(record,'$.status')`,
      )
      .all() as { status: TaskStatus; n: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.n]));
  }
  idsByStatus(status: TaskStatus): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM ${this.table} WHERE json_extract(record,'$.status')=? ORDER BY rowid`,
        )
        .all(status) as { id: string }[]
    ).map((row) => row.id);
  }
  expirable(now: number): { id: string; status: TaskStatus }[] {
    return this.db
      .prepare(
        `SELECT id,json_extract(record,'$.status') AS status FROM ${this.table} WHERE json_extract(record,'$.expiresAt')<=?`,
      )
      .all(now) as { id: string; status: TaskStatus }[];
  }
  get(id: string): TaskRecord | undefined {
    const row = this.db.prepare(`SELECT record FROM ${this.table} WHERE id=?`).get(id) as
      | { record: string }
      | undefined;
    return row ? (JSON.parse(row.record) as TaskRecord) : undefined;
  }
  save(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO ${this.table} VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record`,
      )
      .run(task.id, task.owner, task.key ?? null, JSON.stringify(task));
  }
  remove(id: string): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM ${this.steps}_attempts WHERE task_id=?`).run(id);
      this.db.prepare(`DELETE FROM ${this.steps} WHERE task_id=?`).run(id);
      this.db.prepare(`DELETE FROM ${this.table} WHERE id=?`).run(id);
    });
  }
  step(id: string, key: string): StepRecord | undefined {
    const row = this.db
      .prepare(`SELECT record FROM ${this.steps} WHERE task_id=? AND step_key=?`)
      .get(id, key) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as StepRecord) : undefined;
  }
  journal(id: string): StepRecord[] {
    return (
      this.db.prepare(`SELECT record FROM ${this.steps} WHERE task_id=?`).all(id) as {
        record: string;
      }[]
    ).map((r) => JSON.parse(r.record) as StepRecord);
  }
  stepCount(id: string, status?: StepRecord["status"]): number {
    const row =
      status === undefined
        ? this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.steps} WHERE task_id=?`).get(id)
        : this.db
            .prepare(
              `SELECT COUNT(*) AS n FROM ${this.steps} WHERE task_id=? AND json_extract(record,'$.status')=?`,
            )
            .get(id, status);
    return (row as { n: number }).n;
  }
  stepsWithStatus(id: string, status: StepRecord["status"]): StepRecord[] {
    return (
      this.db
        .prepare(
          `SELECT record FROM ${this.steps} WHERE task_id=? AND json_extract(record,'$.status')=?`,
        )
        .all(id, status) as { record: string }[]
    ).map((row) => JSON.parse(row.record) as StepRecord);
  }
  hasUncertainStep(id: string, onlyUncertain = false): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM ${this.steps} WHERE task_id=? AND json_extract(record,'$.status') IN (${onlyUncertain ? "'uncertain'" : "'running','uncertain'"}) AND COALESCE(json_extract(record,'$.replaySafe'),0)=0 LIMIT 1`,
        )
        .get(id) !== undefined
    );
  }
  saveStep(id: string, step: StepRecord): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO ${this.steps} VALUES(?,?,?)`)
      .run(id, step.key, JSON.stringify(step));
    this.db
      .prepare(`INSERT OR REPLACE INTO ${this.steps}_attempts VALUES(?,?,?,?)`)
      .run(id, step.key, step.attempt, JSON.stringify({ ...step, result: undefined }));
  }
  retainedBytes(): number {
    return [this.table, this.steps, `${this.steps}_attempts`].reduce((sum, table) => {
      const row = this.db
        .prepare(
          `SELECT COALESCE(SUM(length(CAST(record AS BLOB))),0) AS n FROM ${table} INDEXED BY ${table}_bytes_idx`,
        )
        .get() as { n: number };
      return sum + row.n;
    }, 0);
  }
  attemptCount(id: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM ${this.steps}_attempts WHERE task_id=?`)
        .get(id) as { n: number }
    ).n;
  }
  clearContent(id: string): void {
    this.db.prepare(`DELETE FROM ${this.steps} WHERE task_id=?`).run(id);
    this.db.prepare(`DELETE FROM ${this.steps}_attempts WHERE task_id=?`).run(id);
  }
  audit(task: TaskRecord, event: string, step?: StepRecord): void {
    const entry = {
      id: `aud_${randomUUID()}`,
      type: "inference.control_changed",
      timestamp: new Date().toISOString(),
      actor: task.owner,
      details: {
        task_event: event,
        task_id: task.id,
        kind: task.kind,
        version: task.version,
        status: task.status,
        ...(step ? { step_key: step.key, attempt: step.attempt, step_status: step.status } : {}),
      },
    };
    this.db
      .prepare(
        "INSERT INTO adminbot_audit_events (id,action_id,event_type,timestamp,actor,event_json) VALUES(?,NULL,?,?,?,?)",
      )
      .run(entry.id, entry.type, entry.timestamp, entry.actor, JSON.stringify(entry));
  }
  resetUncertain(id: string): void {
    this.db
      .prepare(
        `DELETE FROM ${this.steps} WHERE task_id=? AND json_extract(record,'$.status') != 'completed'`,
      )
      .run(id);
  }
}

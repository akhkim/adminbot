/**
 * SQLite storage for inference requests. The gate pairs transitions with audit events
 * in one transaction.
 *
 * arrival -> running | queued | shed
 * shed -> queued; queued -> running
 * running -> completed | failed; queued -> failed (cancellation)
 * queued | shed -> expired
 *
 * Recovery fails interrupted running rows rather than replaying them. Shed is nonterminal.
 * Retention removes request, result, and error content from terminal rows; SQLite pages,
 * WAL files, and backups may still contain it.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AdminBotAuditEvent } from "../contracts/actions.js";

export type InferenceRowStatus = "queued" | "shed" | "running" | "completed" | "failed" | "expired";

/** How a `failed` row failed. `interrupted` is the one a crash produces and the one to look at first. */
export type InferenceFailureKind =
  | "error"
  | "timeout"
  | "cancelled"
  | "interrupted"
  | `http_${number}`;

/** Store the credential variable name, never its value. Recovery resolves it from the new process environment. */
export type InferenceRequestRecord = {
  route: "chat/completions" | "embeddings";
  baseUrl: string;
  body: Record<string, unknown>;
  purpose: string;
  apiKeyEnv?: string;
};

export type InferenceResponseRecord = {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
};

/**
 * Where one request sits inside a multi-step task, for callers that make several GPU calls per
 * task (the privacy broker: classify, then finalize or a local run). `task` groups the steps under
 * the caller's task identity; `final` marks the step whose completion means the task itself is
 * done. Without this a shed classification that is later waited on would report "Done" for a task
 * that never ran -- the step finished, the task did not, and the status has to say which.
 */
export type InferenceStage = { name: string; task: string; final: boolean };

export type InferenceQueueRow = {
  id: string;
  owner_id: string;
  submission_key: string;
  payload_hash: string;
  caller: string;
  stage: InferenceStage | null;
  status: InferenceRowStatus;
  arrived_at: string;
  expires_at: string;
  queued_at: string | null;
  admitted_at: string | null;
  finished_at: string | null;
  claimed_at: string | null;
  claimed_by: string | null;
  timeout_ms: number;
  request: InferenceRequestRecord | null;
  request_bytes: number;
  result: InferenceResponseRecord | null;
  result_bytes: number;
  outcome: string | null;
  /** Raw failure text. Private-content retention applies: the sweep strips it with the bodies. */
  error: string | null;
  /** Whether a completed row's result was kept. False when the retained-bytes ceiling refused it. */
  result_retained: boolean;
};

export type MemberInferencePreferences = {
  /** Wait for a slot by default instead of being offered the choice. */
  inference_always_wait?: boolean;
};

export type InferenceAuditType = Extract<AdminBotAuditEvent["type"], `inference.${string}`>;

type AuditInput = {
  type: InferenceAuditType;
  actor?: string;
  action_id?: string;
  details: Record<string, unknown>;
};

export function ensureInferenceQueueSchema(db: DatabaseSync, temporary = false): void {
  const schema = temporary ? "temp" : "main";
  db.exec(`
    CREATE ${temporary ? "TEMP " : ""}TABLE IF NOT EXISTS adminbot_inference_queue (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      submission_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      caller TEXT NOT NULL,
      status TEXT NOT NULL,
      arrived_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      queued_at TEXT,
      admitted_at TEXT,
      finished_at TEXT,
      claimed_at TEXT,
      claimed_by TEXT,
      timeout_ms INTEGER NOT NULL,
      request_json TEXT,
      request_bytes INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      result_bytes INTEGER NOT NULL DEFAULT 0,
      outcome TEXT,
      error TEXT,
      stage_name TEXT,
      stage_task TEXT,
      stage_final INTEGER,
      result_retained INTEGER NOT NULL DEFAULT 1
    );

    -- The wait line is read in arrival-to-the-line order, and the sweep reads by status.
    CREATE INDEX IF NOT EXISTS ${schema}.adminbot_inference_queue_status_idx
      ON adminbot_inference_queue(status, queued_at, arrived_at);

    -- "Did this task's final step complete" is answered per (owner, task).
    CREATE INDEX IF NOT EXISTS ${schema}.adminbot_inference_queue_task_idx
      ON adminbot_inference_queue(owner_id, stage_task, stage_final, status);

    -- Reserve keys for active rows and retained terminal rows. Purging the request releases the key.
    DROP INDEX IF EXISTS ${schema}.adminbot_inference_queue_submission_idx;
    CREATE UNIQUE INDEX IF NOT EXISTS ${schema}.adminbot_inference_queue_submission_v2_idx
      ON adminbot_inference_queue(owner_id, submission_key)
      WHERE status IN ('queued', 'shed', 'running') OR request_json IS NOT NULL;

    CREATE TABLE IF NOT EXISTS adminbot_member_preferences (
      member_id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
}

const ROW_COLUMNS = `id, owner_id, submission_key, payload_hash, caller, status, arrived_at, expires_at,
  queued_at, admitted_at, finished_at, claimed_at, claimed_by, timeout_ms, request_json, request_bytes,
  result_json, result_bytes, outcome, error, stage_name, stage_task, stage_final, result_retained`;

type RawRow = Omit<InferenceQueueRow, "request" | "result" | "stage" | "result_retained"> & {
  request_json: string | null;
  result_json: string | null;
  stage_name: string | null;
  stage_task: string | null;
  stage_final: number | null;
  result_retained: number;
};

export class InferenceQueueStore {
  constructor(
    private readonly db: DatabaseSync,
    temporary = false,
  ) {
    // TEMP queue rows disappear with the connection; audit and preferences remain in main.
    ensureInferenceQueueSchema(db, temporary);
  }

  /** Runs `fn` in one transaction. Nested calls join the outer one rather than opening a second. */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      return fn();
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  private inTransaction = false;

  /**
   * The audit row, written with the same column layout `AdminBotSqliteStore.recordAudit` uses so
   * `listAuditEvents()` reads it back as an ordinary event. Written here rather than through the
   * store so it can sit inside the same transaction as the queue row it describes.
   */
  audit(input: AuditInput): AdminBotAuditEvent {
    const event: AdminBotAuditEvent = {
      id: `aud_${randomUUID()}`,
      type: input.type,
      timestamp: new Date().toISOString(),
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.action_id ? { action_id: input.action_id } : {}),
      details: input.details,
    };
    this.db
      .prepare(
        `INSERT INTO adminbot_audit_events (id, action_id, event_type, timestamp, actor, event_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.action_id ?? null,
        event.type,
        event.timestamp,
        event.actor ?? null,
        JSON.stringify(event),
      );
    return event;
  }

  insert(row: InferenceQueueRow): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_inference_queue (${ROW_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.owner_id,
        row.submission_key,
        row.payload_hash,
        row.caller,
        row.status,
        row.arrived_at,
        row.expires_at,
        row.queued_at,
        row.admitted_at,
        row.finished_at,
        row.claimed_at,
        row.claimed_by,
        row.timeout_ms,
        row.request ? JSON.stringify(row.request) : null,
        row.request_bytes,
        row.result ? JSON.stringify(row.result) : null,
        row.result_bytes,
        row.outcome,
        row.error,
        row.stage?.name ?? null,
        row.stage?.task ?? null,
        row.stage ? (row.stage.final ? 1 : 0) : null,
        row.result_retained ? 1 : 0,
      );
  }

  get(id: string): InferenceQueueRow | undefined {
    const raw = this.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM adminbot_inference_queue WHERE id = ?`)
      .get(id) as RawRow | undefined;
    return raw ? fromRaw(raw) : undefined;
  }

  /** The row a retry with this key should find, under the same rule as the unique index. */
  findReusable(ownerId: string, submissionKey: string): InferenceQueueRow | undefined {
    const raw = this.db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM adminbot_inference_queue
          WHERE owner_id = ? AND submission_key = ?
            AND (status IN ('queued', 'shed', 'running') OR request_json IS NOT NULL)
          ORDER BY arrived_at DESC LIMIT 1`,
      )
      .get(ownerId, submissionKey) as RawRow | undefined;
    return raw ? fromRaw(raw) : undefined;
  }

  /** Whether some final step of this owner's task has completed. */
  taskCompleted(ownerId: string, task: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM adminbot_inference_queue
          WHERE owner_id = ? AND stage_task = ? AND stage_final = 1 AND status = 'completed'
          LIMIT 1`,
      )
      .get(ownerId, task) as { hit?: number } | undefined;
    return Boolean(row?.hit);
  }

  listByStatus(...statuses: InferenceRowStatus[]): InferenceQueueRow[] {
    const marks = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM adminbot_inference_queue
          WHERE status IN (${marks})
          ORDER BY queued_at ASC, arrived_at ASC`,
      )
      .all(...statuses) as RawRow[];
    return rows.map(fromRaw);
  }

  listForOwner(ownerId: string, limit = 50): InferenceQueueRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM adminbot_inference_queue
          WHERE owner_id = ? ORDER BY arrived_at DESC LIMIT ?`,
      )
      .all(ownerId, limit) as RawRow[];
    return rows.map(fromRaw);
  }

  /**
   * Takes a queued row for dispatch. One UPDATE guarded on the current status, so two dispatchers
   * -- or one dispatcher and a sweep expiring the same row -- cannot both win.
   */
  claim(id: string, claimedBy: string, at: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE adminbot_inference_queue
            SET status = 'running', claimed_at = ?, claimed_by = ?, admitted_at = ?
          WHERE id = ? AND status = 'queued' AND claimed_at IS NULL`,
      )
      .run(at, claimedBy, at, id);
    return result.changes === 1;
  }

  /** The arrival path when a slot is free: the row is born running, with its claim already on it. */
  insertRunning(row: InferenceQueueRow, claimedBy: string): void {
    this.insert({
      ...row,
      status: "running",
      admitted_at: row.arrived_at,
      claimed_at: row.arrived_at,
      claimed_by: claimedBy,
    });
  }

  /** shed -> queued, guarded on the row still being shed. */
  convertToQueued(id: string, at: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE adminbot_inference_queue SET status = 'queued', queued_at = ?
          WHERE id = ? AND status = 'shed'`,
      )
      .run(at, id);
    return result.changes === 1;
  }

  /**
   * running -> completed. `result` may be omitted when the retained-bytes ceiling has no room for
   * it: the caller still receives the answer in memory, and the row says the result was not kept
   * rather than pretending nothing was answered.
   */
  finishCompleted(id: string, at: string, result: InferenceResponseRecord | undefined): boolean {
    const json = result ? JSON.stringify(result) : null;
    const changed = this.db
      .prepare(
        `UPDATE adminbot_inference_queue
            SET status = 'completed', finished_at = ?, result_json = ?, result_bytes = ?,
                result_retained = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(at, json, json ? Buffer.byteLength(json) : 0, json ? 1 : 0, id);
    return changed.changes === 1;
  }

  finishFailed(
    id: string,
    at: string,
    kind: InferenceFailureKind,
    error: string,
    result?: InferenceResponseRecord,
  ): boolean {
    const json = result ? JSON.stringify(result) : null;
    const changed = this.db
      .prepare(
        `UPDATE adminbot_inference_queue
            SET status = 'failed', finished_at = ?, outcome = ?, error = ?,
                result_json = ?, result_bytes = ?
          WHERE id = ? AND status IN ('running', 'queued')`,
      )
      .run(at, kind, error.slice(0, 500), json, json ? Buffer.byteLength(json) : 0, id);
    return changed.changes === 1;
  }

  cancelPending(id: string, at: string): boolean {
    return (
      this.db
        .prepare(`UPDATE adminbot_inference_queue
      SET status = 'failed', finished_at = ?, outcome = 'cancelled', error = 'Cancelled by operator'
      WHERE id = ? AND status IN ('queued', 'shed')`)
        .run(at, id).changes === 1
    );
  }

  expire(id: string, at: string): boolean {
    const changed = this.db
      .prepare(
        `UPDATE adminbot_inference_queue
            SET status = 'expired', finished_at = ?, outcome = 'expired'
          WHERE id = ? AND status IN ('queued', 'shed')`,
      )
      .run(at, id);
    return changed.changes === 1;
  }

  /**
   * Strips bodies from finished rows older than `cutoff`. Status metadata stays, so "what happened
   * to my request" remains answerable after the content that made it private is gone.
   */
  purgeBodiesBefore(cutoff: string): number {
    // `error` goes with the bodies: a model's error text can quote the prompt back, so it is
    // private content under the same retention as the prompt itself.
    const changed = this.db
      .prepare(
        `UPDATE adminbot_inference_queue
            SET request_json = NULL, request_bytes = 0, result_json = NULL, result_bytes = 0,
                error = NULL
          WHERE status IN ('completed', 'failed', 'expired')
            AND finished_at IS NOT NULL AND finished_at < ?
            AND (request_json IS NOT NULL OR result_json IS NOT NULL OR error IS NOT NULL)`,
      )
      .run(cutoff);
    return Number(changed.changes ?? 0);
  }

  retainedBytes(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(request_bytes), 0) + COALESCE(SUM(result_bytes), 0) AS bytes
           FROM adminbot_inference_queue`,
      )
      .get() as { bytes: number };
    return Number(row.bytes ?? 0);
  }

  countByStatus(): Record<InferenceRowStatus, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM adminbot_inference_queue GROUP BY status`)
      .all() as Array<{ status: InferenceRowStatus; n: number }>;
    const counts: Record<InferenceRowStatus, number> = {
      queued: 0,
      shed: 0,
      running: 0,
      completed: 0,
      failed: 0,
      expired: 0,
    };
    for (const row of rows) {
      counts[row.status] = Number(row.n);
    }
    return counts;
  }

  getPreferences(memberId: string): MemberInferencePreferences {
    const row = this.db
      .prepare("SELECT payload_json FROM adminbot_member_preferences WHERE member_id = ?")
      .get(memberId) as { payload_json?: string } | undefined;
    return row?.payload_json ? (JSON.parse(row.payload_json) as MemberInferencePreferences) : {};
  }

  savePreferences(memberId: string, preferences: MemberInferencePreferences): void {
    const merged = { ...this.getPreferences(memberId), ...preferences };
    this.db
      .prepare(
        `INSERT INTO adminbot_member_preferences (member_id, updated_at, payload_json)
         VALUES (?, ?, ?)
         ON CONFLICT(member_id) DO UPDATE SET
           updated_at = excluded.updated_at, payload_json = excluded.payload_json`,
      )
      .run(memberId, new Date().toISOString(), JSON.stringify(merged));
  }
}

function fromRaw(raw: RawRow): InferenceQueueRow {
  const {
    request_json,
    result_json,
    stage_name,
    stage_task,
    stage_final,
    result_retained,
    ...rest
  } = raw;
  return {
    ...rest,
    timeout_ms: Number(rest.timeout_ms),
    request_bytes: Number(rest.request_bytes),
    result_bytes: Number(rest.result_bytes),
    request: request_json ? (JSON.parse(request_json) as InferenceRequestRecord) : null,
    result: result_json ? (JSON.parse(result_json) as InferenceResponseRecord) : null,
    stage:
      stage_name && stage_task
        ? { name: stage_name, task: stage_task, final: Number(stage_final) === 1 }
        : null,
    result_retained: Number(result_retained) === 1,
  };
}

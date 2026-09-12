/**
 * The durable half of the inference gate: one SQLite row per request, from arrival to the end.
 *
 * Every state change here is one transaction that writes the row and its audit event together, so
 * the audit table can never say a request completed that the queue table says is still running, and
 * a crash between the two cannot leave a request with no record of what happened to it. That pairing
 * is what the load simulation reconciles against, and it only holds if no code path writes one
 * without the other -- which is why nothing outside this module touches the table.
 *
 * The states, and the only moves between them:
 *
 *   arrival --> running   (a slot was free)
 *   arrival --> queued    (the member is waiting for a slot)
 *   arrival --> shed      (no slot; the body is kept so the member can choose to wait later)
 *   shed    --> queued    (the member chose to wait)
 *   queued  --> running   (a slot freed; the claim is atomic)
 *   running --> completed | failed
 *   queued | shed --> expired
 *   running --> failed    (found running at startup: the process that held the claim died)
 *
 * `completed`, `failed` and `expired` are terminal and each is written exactly once. `shed` is not
 * terminal -- it is "awaiting the member's choice" -- so a request that is shed, then waited for,
 * then answered has one terminal event, not two.
 *
 * Request bodies and results are the private content of the lab (CVs, receipts, tasks). They are
 * stored so a shed request can be resumed without re-sending, and they are stripped by the retention
 * sweep once nobody could plausibly still come back for them. This is logical deletion: SQLite does
 * not zero freed pages and the WAL keeps recent content until checkpoint, so the write-up describes
 * it as such rather than as erasure.
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

/**
 * What the gate needs to make the call, and nothing it must not keep.
 *
 * No credential is stored: `apiKeyEnv` names the variable to read at dispatch, so a row re-admitted
 * after a restart authenticates with whatever the environment holds then, and a database copy carries
 * no bearer token.
 */
export type InferenceRequestRecord = {
  route: "chat/completions" | "embeddings";
  baseUrl: string;
  body: Record<string, unknown>;
  purpose: string;
  apiKeyEnv?: string;
  apiKeyFallback?: string;
};

export type InferenceResponseRecord = {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
};

export type InferenceQueueRow = {
  id: string;
  owner_id: string;
  submission_key: string;
  payload_hash: string;
  caller: string;
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
  error: string | null;
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

export function ensureInferenceQueueSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adminbot_inference_queue (
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
      error TEXT
    );

    -- The wait line is read in arrival-to-the-line order, and the sweep reads by status.
    CREATE INDEX IF NOT EXISTS adminbot_inference_queue_status_idx
      ON adminbot_inference_queue(status, queued_at, arrived_at);

    -- A member's retry must find the row it made, not make another. Partial, so the key is only
    -- reserved while the row can still answer: live rows, and completed rows whose result is still
    -- retained. Once the sweep strips a result the same key may be submitted again -- at that point
    -- it is a resubmission, and the row it creates says so by being new.
    CREATE UNIQUE INDEX IF NOT EXISTS adminbot_inference_queue_submission_idx
      ON adminbot_inference_queue(owner_id, submission_key)
      WHERE status IN ('queued', 'shed', 'running')
         OR (status = 'completed' AND result_json IS NOT NULL);

    CREATE TABLE IF NOT EXISTS adminbot_member_preferences (
      member_id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
}

const ROW_COLUMNS = `id, owner_id, submission_key, payload_hash, caller, status, arrived_at, expires_at,
  queued_at, admitted_at, finished_at, claimed_at, claimed_by, timeout_ms, request_json, request_bytes,
  result_json, result_bytes, outcome, error`;

type RawRow = Omit<InferenceQueueRow, "request" | "result"> & {
  request_json: string | null;
  result_json: string | null;
};

export class InferenceQueueStore {
  constructor(private readonly db: DatabaseSync) {
    ensureInferenceQueueSchema(db);
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            AND (status IN ('queued', 'shed', 'running')
                 OR (status = 'completed' AND result_json IS NOT NULL))
          ORDER BY arrived_at DESC LIMIT 1`,
      )
      .get(ownerId, submissionKey) as RawRow | undefined;
    return raw ? fromRaw(raw) : undefined;
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

  finishCompleted(id: string, at: string, result: InferenceResponseRecord): boolean {
    const json = JSON.stringify(result);
    const changed = this.db
      .prepare(
        `UPDATE adminbot_inference_queue
            SET status = 'completed', finished_at = ?, result_json = ?, result_bytes = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(at, json, Buffer.byteLength(json), id);
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
    const changed = this.db
      .prepare(
        `UPDATE adminbot_inference_queue
            SET request_json = NULL, request_bytes = 0, result_json = NULL, result_bytes = 0
          WHERE status IN ('completed', 'failed', 'expired')
            AND finished_at IS NOT NULL AND finished_at < ?
            AND (request_json IS NOT NULL OR result_json IS NOT NULL)`,
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
  const { request_json, result_json, ...rest } = raw;
  return {
    ...rest,
    timeout_ms: Number(rest.timeout_ms),
    request_bytes: Number(rest.request_bytes),
    result_bytes: Number(rest.result_bytes),
    request: request_json ? (JSON.parse(request_json) as InferenceRequestRecord) : null,
    result: result_json ? (JSON.parse(result_json) as InferenceResponseRecord) : null,
  };
}

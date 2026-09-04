import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type {
  AdminBotFailedExternalRequest,
  AdminBotFailedExternalRequestStatus,
} from "../contracts/resilience.js";

const require = createRequire(import.meta.url);

const FAILED_REQUEST_SCHEMA = `
  CREATE TABLE IF NOT EXISTS adminbot_failed_external_requests (
    id TEXT PRIMARY KEY,
    service_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    error_message TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS adminbot_failed_external_requests_updated_idx
    ON adminbot_failed_external_requests(updated_at DESC);
`;

export type FailedExternalRequestLedger = {
  record(input: {
    serviceType: string;
    payload: Record<string, unknown>;
    errorMessage: string;
    status?: AdminBotFailedExternalRequestStatus;
  }): AdminBotFailedExternalRequest;
  update(
    id: string,
    patch: Partial<Pick<AdminBotFailedExternalRequest, "status" | "error_message" | "attempt_count">>,
  ): AdminBotFailedExternalRequest | undefined;
  list(limit?: number): AdminBotFailedExternalRequest[];
};

export function createMemoryFailedRequestLedger(): FailedExternalRequestLedger {
  const rows = new Map<string, AdminBotFailedExternalRequest>();
  return {
    record(input) {
      const now = new Date().toISOString();
      const row: AdminBotFailedExternalRequest = {
        id: `fail_${randomUUID()}`,
        service_type: input.serviceType,
        payload: input.payload,
        error_message: input.errorMessage,
        status: input.status ?? "recorded",
        attempt_count: 1,
        created_at: now,
        updated_at: now,
      };
      rows.set(row.id, row);
      return row;
    },
    update(id, patch) {
      const existing = rows.get(id);
      if (!existing) {
        return undefined;
      }
      const next = {
        ...existing,
        ...patch,
        updated_at: new Date().toISOString(),
      };
      rows.set(id, next);
      return next;
    },
    list(limit = 50) {
      return [...rows.values()]
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, limit);
    },
  };
}

export function createSqliteFailedRequestLedger(databasePath: string): FailedExternalRequestLedger {
  const sqlite = require("node:sqlite") as typeof import("node:sqlite");
  const db = new sqlite.DatabaseSync(databasePath);
  db.exec(FAILED_REQUEST_SCHEMA);
  return createFailedRequestLedgerFromDatabase(db);
}

export function createFailedRequestLedgerFromDatabase(db: DatabaseSync): FailedExternalRequestLedger {
  const insert = db.prepare(`
    INSERT INTO adminbot_failed_external_requests
      (id, service_type, payload_json, error_message, status, attempt_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE adminbot_failed_external_requests
    SET status = ?, error_message = ?, attempt_count = ?, updated_at = ?
    WHERE id = ?
  `);
  const get = db.prepare(`SELECT * FROM adminbot_failed_external_requests WHERE id = ?`);
  const list = db.prepare(`
    SELECT * FROM adminbot_failed_external_requests ORDER BY updated_at DESC LIMIT ?
  `);
  return {
    record(input) {
      const now = new Date().toISOString();
      const row: AdminBotFailedExternalRequest = {
        id: `fail_${randomUUID()}`,
        service_type: input.serviceType,
        payload: input.payload,
        error_message: input.errorMessage,
        status: input.status ?? "recorded",
        attempt_count: 1,
        created_at: now,
        updated_at: now,
      };
      insert.run(
        row.id,
        row.service_type,
        JSON.stringify(row.payload),
        row.error_message,
        row.status,
        row.attempt_count,
        row.created_at,
        row.updated_at,
      );
      return row;
    },
    update(id, patch) {
      const existing = rowFromSqlite(get.get(id));
      if (!existing) {
        return undefined;
      }
      const next = {
        ...existing,
        ...patch,
        updated_at: new Date().toISOString(),
      };
      update.run(next.status, next.error_message, next.attempt_count, next.updated_at, id);
      return next;
    },
    list(limit = 50) {
      return (list.all(limit) as unknown[]).map((entry) => rowFromSqlite(entry)!);
    },
  };
}

function rowFromSqlite(raw: unknown): AdminBotFailedExternalRequest | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string") {
    return undefined;
  }
  return {
    id: row.id,
    service_type: String(row.service_type),
    payload: parsePayload(row.payload_json),
    error_message: String(row.error_message),
    status: row.status as AdminBotFailedExternalRequestStatus,
    attempt_count: Number(row.attempt_count) || 1,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function parsePayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

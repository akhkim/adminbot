// Where API usage lives: a row per request and a rollup per day.
//
// Shaped like the error log next door: a small object the route context carries, with a memory
// form for tests and a SQLite form that shares the store's database. See contracts/api-usage.ts
// for what a row holds and, more to the point, what it never holds.
//
// Recording has to cost a request nothing it would notice. `record` only appends to a buffer; the
// buffer is written in one transaction when it fills or a couple of seconds pass, and the old rows
// are pruned at most once an hour from inside that same write. A crash loses the last few seconds
// of telemetry, which is the right trade for something no decision rests on.
import type { DatabaseSync } from "node:sqlite";
import {
  adminBotApiUsageRetentionDays,
  type AdminBotApiUsageCount,
  type AdminBotApiUsageEntry,
  type AdminBotApiUsageSummary,
} from "../contracts/api-usage.js";

const API_USAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS adminbot_api_usage (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    member_id TEXT,
    auth TEXT NOT NULL,
    token_id TEXT,
    client TEXT NOT NULL,
    client_version TEXT,
    operation TEXT NOT NULL,
    method TEXT NOT NULL,
    status INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    metrics_json TEXT
  );
  CREATE INDEX IF NOT EXISTS adminbot_api_usage_at_idx ON adminbot_api_usage(at);
  CREATE INDEX IF NOT EXISTS adminbot_api_usage_member_idx ON adminbot_api_usage(member_id, at);
  CREATE TABLE IF NOT EXISTS adminbot_api_usage_daily (
    day TEXT NOT NULL,
    member_id TEXT NOT NULL,
    auth TEXT NOT NULL,
    token_id TEXT NOT NULL,
    client TEXT NOT NULL,
    client_version TEXT NOT NULL,
    operation TEXT NOT NULL,
    method TEXT NOT NULL,
    requests INTEGER NOT NULL,
    client_errors INTEGER NOT NULL,
    server_errors INTEGER NOT NULL,
    total_ms INTEGER NOT NULL,
    max_ms INTEGER NOT NULL,
    last_at TEXT NOT NULL,
    PRIMARY KEY (day, member_id, auth, token_id, client, client_version, operation, method)
  );
`;

/** A request is written at most this long after it finished. */
const FLUSH_DELAY_MS = 2_000;
/** ...or as soon as this many are waiting. */
const FLUSH_BATCH = 200;
/** A buffer that cannot be written (a locked or broken database) stops growing here. */
const BUFFER_CAP = 5_000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export type ApiUsageLog = {
  /** Queue one request. Never throws, never blocks on the database. */
  record(entry: AdminBotApiUsageEntry): void;
  /** Write whatever is queued. The timer calls it; tests and shutdown call it directly. */
  flush(now?: Date): void;
  summary(options?: { days?: number; now?: Date }): AdminBotApiUsageSummary;
  /** Newest first, for one member or everybody. */
  recent(options?: { memberId?: string; limit?: number }): AdminBotApiUsageEntry[];
  /** Service-token requests since `from`, oldest first: what the automation report reads. */
  serviceRuns(from: string): AdminBotApiUsageEntry[];
  close(): void;
};

/** One rollup cell: a day, a caller, a client, an operation. */
export type ApiUsageRollupRow = {
  day: string;
  member_id: string;
  auth: AdminBotApiUsageEntry["auth"];
  token_id: string;
  client: string;
  client_version: string;
  operation: string;
  method: string;
  requests: number;
  client_errors: number;
  server_errors: number;
  total_ms: number;
  max_ms: number;
  last_at: string;
};

function cutoffDay(now: Date, days: number): string {
  return new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

function clampDays(days: number | undefined): number {
  const value = Math.trunc(days ?? 30) || 30;
  return Math.min(Math.max(value, 1), adminBotApiUsageRetentionDays);
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 100) || 100, 1), 500);
}

function rollupKey(
  entry: AdminBotApiUsageEntry,
): Omit<
  ApiUsageRollupRow,
  "requests" | "client_errors" | "server_errors" | "total_ms" | "max_ms" | "last_at"
> {
  return {
    day: entry.at.slice(0, 10),
    member_id: entry.member_id ?? "",
    auth: entry.auth,
    token_id: entry.token_id ?? "",
    client: entry.client,
    client_version: entry.client_version ?? "",
    operation: entry.operation,
    method: entry.method,
  };
}

function errorCounts(status: number): { client_errors: number; server_errors: number } {
  return {
    client_errors: status >= 400 && status < 500 ? 1 : 0,
    server_errors: status >= 500 ? 1 : 0,
  };
}

type Accumulator = {
  requests: number;
  client_errors: number;
  server_errors: number;
  total_ms: number;
  max_ms: number;
};

function emptyAccumulator(): Accumulator {
  return { requests: 0, client_errors: 0, server_errors: 0, total_ms: 0, max_ms: 0 };
}

function add(into: Accumulator, row: ApiUsageRollupRow): void {
  into.requests += row.requests;
  into.client_errors += row.client_errors;
  into.server_errors += row.server_errors;
  into.total_ms += row.total_ms;
  into.max_ms = Math.max(into.max_ms, row.max_ms);
}

function counted(value: Accumulator): AdminBotApiUsageCount {
  return {
    requests: value.requests,
    client_errors: value.client_errors,
    server_errors: value.server_errors,
    avg_ms: value.requests ? Math.round(value.total_ms / value.requests) : 0,
    max_ms: value.max_ms,
  };
}

function groupBy<K extends string, T extends Record<string, unknown>>(
  rows: readonly ApiUsageRollupRow[],
  key: (row: ApiUsageRollupRow) => K,
  extra: (row: ApiUsageRollupRow) => T,
  more?: (into: T, row: ApiUsageRollupRow) => void,
): Array<AdminBotApiUsageCount & T> {
  const groups = new Map<K, { acc: Accumulator; extra: T }>();
  for (const row of rows) {
    const id = key(row);
    let group = groups.get(id);
    if (!group) {
      group = { acc: emptyAccumulator(), extra: extra(row) };
      groups.set(id, group);
    }
    add(group.acc, row);
    more?.(group.extra, row);
  }
  return [...groups.values()]
    .map((group) => ({ ...counted(group.acc), ...group.extra }))
    .toSorted((left, right) => right.requests - left.requests);
}

/** The admin page's numbers, from the rollup rows of the window. Shared by both stores. */
export function summarizeApiUsage(
  rows: readonly ApiUsageRollupRow[],
  options: { from: string; days: number },
): AdminBotApiUsageSummary {
  const total = emptyAccumulator();
  const members = new Set<string>();
  for (const row of rows) {
    add(total, row);
    if (row.member_id) {
      members.add(row.member_id);
    }
  }
  const byDay = groupBy(
    rows,
    (row) => row.day,
    (row) => ({ day: row.day }),
  ).toSorted((left, right) => left.day.localeCompare(right.day));
  const byMember = groupBy(
    rows.filter((row) => row.member_id),
    (row) => row.member_id,
    (row) => ({ member_id: row.member_id, last_at: "", cli_requests: 0, token_requests: 0 }),
    (into, row) => {
      if (row.last_at > into.last_at) {
        into.last_at = row.last_at;
      }
      if (row.client === "cli") {
        into.cli_requests += row.requests;
      }
      if (row.auth === "api_token") {
        into.token_requests += row.requests;
      }
    },
  );
  const byOperation = groupBy(
    rows,
    (row) => `${row.method} ${row.operation}`,
    (row) => ({ operation: row.operation, method: row.method }),
  );
  const byClient = groupBy(
    rows,
    (row) => `${row.client} ${row.client_version}`,
    (row) => ({
      client: row.client,
      ...(row.client_version ? { client_version: row.client_version } : {}),
    }),
  );
  const byAuth = groupBy(
    rows,
    (row) => row.auth,
    (row) => ({ auth: row.auth }),
  );
  return {
    from: options.from,
    days: options.days,
    totals: { ...counted(total), members: members.size },
    by_day: byDay,
    by_member: byMember,
    by_operation: byOperation,
    by_client: byClient,
    by_auth: byAuth,
  };
}

/**
 * The buffer and its timer, shared by both stores so the memory one behaves like the real one in
 * tests: nothing is visible to `summary` until it has been flushed.
 */
function createBuffer(write: (entries: AdminBotApiUsageEntry[], now: Date) => void) {
  let pending: AdminBotApiUsageEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (now = new Date()) => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.length === 0) {
      return;
    }
    const batch = pending;
    pending = [];
    try {
      write(batch, now);
    } catch {
      // Telemetry never fails the request it describes, and a database that cannot take this
      // batch now is unlikely to take it on a retry loop either. The batch is dropped.
    }
  };
  return {
    record(entry: AdminBotApiUsageEntry) {
      if (pending.length >= BUFFER_CAP) {
        return;
      }
      pending.push(entry);
      if (pending.length >= FLUSH_BATCH) {
        flush();
        return;
      }
      if (!timer) {
        timer = setTimeout(() => flush(), FLUSH_DELAY_MS);
        timer.unref?.();
      }
    },
    flush,
    close() {
      flush();
    },
  };
}

export function createMemoryApiUsageLog(): ApiUsageLog {
  const requests: AdminBotApiUsageEntry[] = [];
  const rollup = new Map<string, ApiUsageRollupRow>();
  const buffer = createBuffer((entries) => {
    for (const entry of entries) {
      requests.push(entry);
      const key = rollupKey(entry);
      const id = Object.values(key).join("\u0000");
      const row = rollup.get(id) ?? {
        ...key,
        ...emptyAccumulator(),
        last_at: entry.at,
      };
      const errors = errorCounts(entry.status);
      rollup.set(id, {
        ...row,
        requests: row.requests + 1,
        client_errors: row.client_errors + errors.client_errors,
        server_errors: row.server_errors + errors.server_errors,
        total_ms: row.total_ms + entry.duration_ms,
        max_ms: Math.max(row.max_ms, entry.duration_ms),
        last_at: entry.at > row.last_at ? entry.at : row.last_at,
      });
    }
  });
  return {
    record: buffer.record,
    flush: buffer.flush,
    close: buffer.close,
    summary(options = {}) {
      const days = clampDays(options.days);
      const from = cutoffDay(options.now ?? new Date(), days);
      return summarizeApiUsage(
        [...rollup.values()].filter((row) => row.day >= from),
        { from, days },
      );
    },
    recent(options = {}) {
      return requests
        .filter((entry) => !options.memberId || entry.member_id === options.memberId)
        .toSorted((left, right) => right.at.localeCompare(left.at))
        .slice(0, clampLimit(options.limit));
    },
    serviceRuns(from) {
      return requests.filter((entry) => entry.auth === "service" && entry.at >= from);
    },
  };
}

export function createApiUsageLogFromDatabase(db: DatabaseSync): ApiUsageLog {
  db.exec(API_USAGE_SCHEMA);
  const insert = db.prepare(`
    INSERT INTO adminbot_api_usage
      (at, member_id, auth, token_id, client, client_version, operation, method, status, duration_ms,
       metrics_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsert = db.prepare(`
    INSERT INTO adminbot_api_usage_daily
      (day, member_id, auth, token_id, client, client_version, operation, method,
       requests, client_errors, server_errors, total_ms, max_ms, last_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(day, member_id, auth, token_id, client, client_version, operation, method)
    DO UPDATE SET
      requests = requests + 1,
      client_errors = client_errors + excluded.client_errors,
      server_errors = server_errors + excluded.server_errors,
      total_ms = total_ms + excluded.total_ms,
      max_ms = MAX(max_ms, excluded.max_ms),
      last_at = MAX(last_at, excluded.last_at)
  `);
  const pruneRequests = db.prepare(`DELETE FROM adminbot_api_usage WHERE at < ?`);
  const pruneDaily = db.prepare(`DELETE FROM adminbot_api_usage_daily WHERE day < ?`);
  const rollupSince = db.prepare(`SELECT * FROM adminbot_api_usage_daily WHERE day >= ?`);
  const recentAll = db.prepare(`SELECT * FROM adminbot_api_usage ORDER BY at DESC LIMIT ?`);
  const recentForMember = db.prepare(
    `SELECT * FROM adminbot_api_usage WHERE member_id = ? ORDER BY at DESC LIMIT ?`,
  );
  const serviceSince = db.prepare(
    `SELECT * FROM adminbot_api_usage WHERE auth = 'service' AND at >= ? ORDER BY at`,
  );
  let prunedAt = 0;
  const buffer = createBuffer((entries, now) => {
    db.exec("BEGIN");
    try {
      for (const entry of entries) {
        const key = rollupKey(entry);
        const errors = errorCounts(entry.status);
        insert.run(
          entry.at,
          entry.member_id ?? null,
          entry.auth,
          entry.token_id ?? null,
          entry.client,
          entry.client_version ?? null,
          entry.operation,
          entry.method,
          entry.status,
          entry.duration_ms,
          entry.metrics ? JSON.stringify(entry.metrics) : null,
        );
        upsert.run(
          key.day,
          key.member_id,
          key.auth,
          key.token_id,
          key.client,
          key.client_version,
          key.operation,
          key.method,
          errors.client_errors,
          errors.server_errors,
          entry.duration_ms,
          entry.duration_ms,
          entry.at,
        );
      }
      if (now.getTime() - prunedAt >= PRUNE_EVERY_MS) {
        prunedAt = now.getTime();
        const cutoff = new Date(now.getTime() - adminBotApiUsageRetentionDays * 86_400_000);
        pruneRequests.run(cutoff.toISOString());
        pruneDaily.run(cutoff.toISOString().slice(0, 10));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  return {
    record: buffer.record,
    flush: buffer.flush,
    close: buffer.close,
    summary(options = {}) {
      const days = clampDays(options.days);
      const from = cutoffDay(options.now ?? new Date(), days);
      const rows = (rollupSince.all(from) as Array<Record<string, unknown>>).map(rollupFromSqlite);
      return summarizeApiUsage(rows, { from, days });
    },
    recent(options = {}) {
      const limit = clampLimit(options.limit);
      const rows = (
        options.memberId ? recentForMember.all(options.memberId, limit) : recentAll.all(limit)
      ) as Array<Record<string, unknown>>;
      return rows.map(entryFromSqlite);
    },
    serviceRuns(from) {
      return (serviceSince.all(from) as Array<Record<string, unknown>>).map(entryFromSqlite);
    },
  };
}

function rollupFromSqlite(row: Record<string, unknown>): ApiUsageRollupRow {
  return {
    day: String(row.day),
    member_id: String(row.member_id ?? ""),
    auth: String(row.auth) as ApiUsageRollupRow["auth"],
    token_id: String(row.token_id ?? ""),
    client: String(row.client),
    client_version: String(row.client_version ?? ""),
    operation: String(row.operation),
    method: String(row.method),
    requests: Number(row.requests) || 0,
    client_errors: Number(row.client_errors) || 0,
    server_errors: Number(row.server_errors) || 0,
    total_ms: Number(row.total_ms) || 0,
    max_ms: Number(row.max_ms) || 0,
    last_at: String(row.last_at),
  };
}

function entryFromSqlite(row: Record<string, unknown>): AdminBotApiUsageEntry {
  return {
    at: String(row.at),
    ...(typeof row.member_id === "string" ? { member_id: row.member_id } : {}),
    auth: String(row.auth) as AdminBotApiUsageEntry["auth"],
    ...(typeof row.token_id === "string" ? { token_id: row.token_id } : {}),
    client: String(row.client) as AdminBotApiUsageEntry["client"],
    ...(typeof row.client_version === "string" ? { client_version: row.client_version } : {}),
    operation: String(row.operation),
    method: String(row.method),
    status: Number(row.status) || 0,
    duration_ms: Number(row.duration_ms) || 0,
    ...metricsFromSqlite(row.metrics_json),
  };
}

function metricsFromSqlite(raw: unknown): { metrics?: Record<string, number> } {
  if (typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { metrics: parsed as Record<string, number> }
      : {};
  } catch {
    return {};
  }
}

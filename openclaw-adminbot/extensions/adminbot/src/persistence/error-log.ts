// Where the error log lives: one row per problem, bounded in every direction.
//
// Shaped like the failed-request ledger next door -- a small object the route context carries,
// with a memory form for tests and a SQLite form that shares the store's database -- rather than
// as more methods on the service. Nothing here is a lab record or an action: it is the service's
// own diagnostics, and it has to keep working when the thing it is describing is the service.
import type { DatabaseSync } from "node:sqlite";
import {
  adminBotErrorFingerprint,
  adminBotErrorGroupCap,
  adminBotErrorReportsPerMinute,
  adminBotErrorRetentionDays,
  mergeAdminBotErrorReport,
  type AdminBotErrorGroup,
  type AdminBotErrorReport,
} from "../contracts/error-log.js";

const ERROR_LOG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS adminbot_error_groups (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS adminbot_error_groups_last_seen_idx
    ON adminbot_error_groups(last_seen_at DESC);
`;

export type ErrorLog = {
  /**
   * Whether this reporter may file another report right now.
   *
   * The browser caps itself, but a cap the client enforces is a courtesy. This is the one that
   * holds when a tab is stuck in a loop on an old build, or when somebody posts by hand.
   */
  accepts(reporter: string, now?: Date): boolean;
  record(
    report: AdminBotErrorReport,
    options?: { memberId?: string; now?: Date },
  ): AdminBotErrorGroup;
  /** Most recently seen first. Resolved groups are left out unless asked for. */
  list(options?: { limit?: number; includeResolved?: boolean }): AdminBotErrorGroup[];
  resolve(id: string, by: string, now?: Date): AdminBotErrorGroup | undefined;
};

function createReportLimiter(): ErrorLog["accepts"] {
  const windows = new Map<string, { startedAt: number; count: number }>();
  return (reporter, now = new Date()) => {
    const at = now.getTime();
    const current = windows.get(reporter);
    if (!current || at - current.startedAt >= 60_000) {
      // The map is only ever as large as the number of people reporting in one minute, but a
      // long-lived process still should not keep a window for everyone who ever did.
      if (windows.size > 1000) {
        windows.clear();
      }
      windows.set(reporter, { startedAt: at, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= adminBotErrorReportsPerMinute;
  };
}

function retentionCutoff(now: Date): string {
  return new Date(now.getTime() - adminBotErrorRetentionDays * 86_400_000).toISOString();
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 100) || 100, 1), adminBotErrorGroupCap);
}

function resolved(group: AdminBotErrorGroup, by: string, now: Date): AdminBotErrorGroup {
  return { ...group, resolved_at: now.toISOString(), resolved_by: by };
}

export function createMemoryErrorLog(): ErrorLog {
  const groups = new Map<string, AdminBotErrorGroup>();
  const newestFirst = () =>
    [...groups.values()].toSorted((left, right) =>
      right.last_seen_at.localeCompare(left.last_seen_at),
    );
  return {
    accepts: createReportLimiter(),
    record(report, options = {}) {
      const now = options.now ?? new Date();
      const id = adminBotErrorFingerprint(report);
      const isNew = !groups.has(id);
      const group = mergeAdminBotErrorReport(groups.get(id), report, {
        id,
        now: now.toISOString(),
        ...(options.memberId ? { memberId: options.memberId } : {}),
      });
      groups.set(id, group);
      if (isNew) {
        const cutoff = retentionCutoff(now);
        for (const [index, stale] of newestFirst().entries()) {
          if (index >= adminBotErrorGroupCap || stale.last_seen_at < cutoff) {
            groups.delete(stale.id);
          }
        }
      }
      return group;
    },
    list(options = {}) {
      return newestFirst()
        .filter((group) => options.includeResolved || !group.resolved_at)
        .slice(0, clampLimit(options.limit));
    },
    resolve(id, by, now = new Date()) {
      const group = groups.get(id);
      if (!group) {
        return undefined;
      }
      const next = resolved(group, by, now);
      groups.set(id, next);
      return next;
    },
  };
}

export function createErrorLogFromDatabase(db: DatabaseSync): ErrorLog {
  db.exec(ERROR_LOG_SCHEMA);
  const get = db.prepare(`SELECT payload_json FROM adminbot_error_groups WHERE id = ?`);
  const upsert = db.prepare(`
    INSERT INTO adminbot_error_groups (id, payload_json, last_seen_at, resolved_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload_json = excluded.payload_json,
      last_seen_at = excluded.last_seen_at,
      resolved_at = excluded.resolved_at
  `);
  const listOpen = db.prepare(`
    SELECT payload_json FROM adminbot_error_groups
    WHERE resolved_at IS NULL ORDER BY last_seen_at DESC LIMIT ?
  `);
  const listAll = db.prepare(`
    SELECT payload_json FROM adminbot_error_groups ORDER BY last_seen_at DESC LIMIT ?
  `);
  const dropStale = db.prepare(`DELETE FROM adminbot_error_groups WHERE last_seen_at < ?`);
  const dropOverflow = db.prepare(`
    DELETE FROM adminbot_error_groups WHERE id IN (
      SELECT id FROM adminbot_error_groups ORDER BY last_seen_at DESC LIMIT -1 OFFSET ?
    )
  `);
  const read = (id: string): AdminBotErrorGroup | undefined => {
    const row = get.get(id) as { payload_json?: unknown } | undefined;
    return typeof row?.payload_json === "string" ? parseGroup(row.payload_json) : undefined;
  };
  const write = (group: AdminBotErrorGroup) => {
    upsert.run(group.id, JSON.stringify(group), group.last_seen_at, group.resolved_at ?? null);
  };
  return {
    accepts: createReportLimiter(),
    record(report, options = {}) {
      const now = options.now ?? new Date();
      const id = adminBotErrorFingerprint(report);
      const existing = read(id);
      const group = mergeAdminBotErrorReport(existing, report, {
        id,
        now: now.toISOString(),
        ...(options.memberId ? { memberId: options.memberId } : {}),
      });
      write(group);
      // Pruned only when the table grew: a repeat of a known problem is the hot path (a render
      // loop files the same one over and over) and cannot have pushed anything past either cap.
      if (!existing) {
        dropStale.run(retentionCutoff(now));
        dropOverflow.run(adminBotErrorGroupCap);
      }
      return group;
    },
    list(options = {}) {
      const rows = (options.includeResolved ? listAll : listOpen).all(
        clampLimit(options.limit),
      ) as Array<{ payload_json?: unknown }>;
      return rows.flatMap((row) => {
        const group =
          typeof row.payload_json === "string" ? parseGroup(row.payload_json) : undefined;
        return group ? [group] : [];
      });
    },
    resolve(id, by, now = new Date()) {
      const group = read(id);
      if (!group) {
        return undefined;
      }
      const next = resolved(group, by, now);
      write(next);
      return next;
    },
  };
}

function parseGroup(raw: string): AdminBotErrorGroup | undefined {
  try {
    const parsed = JSON.parse(raw) as AdminBotErrorGroup;
    return parsed && typeof parsed.id === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

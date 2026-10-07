import type { DatabaseSync } from "node:sqlite";
import type { AdminBotAuditEvent } from "../contracts/actions.js";
import { registerSqliteCacheInvalidator } from "./sqlite.cache-invalidation.js";

/**
 * The parsed audit log, in timestamp order, kept across reads.
 *
 * A month of audit on Aurora is ~10k events and 2.7MB of JSON, and profile, onboarding and nudge
 * reads walk all of it. Events recorded through the store are appended in place (they almost
 * always arrive in order); anything else -- a prune, a late timestamp, a commit from another
 * connection seen through `PRAGMA data_version` -- drops the list to be re-read.
 *
 * Events are shared objects, as in the in-memory store: read them, do not change them.
 */
export class SqliteAuditLog {
  private snapshot: { version: number; events: AdminBotAuditEvent[] } | undefined;

  constructor(private readonly db: DatabaseSync) {
    // Writers on this same connection outside the store (inference gate, task runner) call
    // invalidateSqliteCaches; data_version only sees other connections' commits.
    registerSqliteCacheInvalidator(db, () => this.invalidate());
  }

  /** For writes made on this connection without going through `record`. */
  invalidate(): void {
    this.snapshot = undefined;
  }

  list(): AdminBotAuditEvent[] {
    const version = this.version();
    if (this.snapshot?.version !== version) {
      const rows = this.db
        .prepare("SELECT event_json FROM adminbot_audit_events ORDER BY timestamp ASC")
        .all() as Array<{ event_json: string }>;
      this.snapshot = {
        version,
        events: rows.map((row) => JSON.parse(row.event_json) as AdminBotAuditEvent),
      };
    }
    return [...this.snapshot.events];
  }

  record(event: AdminBotAuditEvent): void {
    const json = JSON.stringify(event);
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
        json,
      );
    // This connection's own commits leave data_version alone, so the list is extended here. A copy
    // parsed from what was stored, so a caller later editing its event changes nothing in the log.
    const events = this.snapshot?.events;
    const last = events?.at(-1);
    if (events && (!last || last.timestamp <= event.timestamp)) {
      events.push(JSON.parse(json) as AdminBotAuditEvent);
    } else {
      this.snapshot = undefined;
    }
  }

  pruneBefore(cutoffIso: string): number {
    const { changes } = this.db
      .prepare("DELETE FROM adminbot_audit_events WHERE timestamp < ?")
      .run(cutoffIso);
    if (Number(changes) > 0) {
      this.snapshot = undefined;
    }
    return Number(changes ?? 0);
  }

  private version(): number {
    return (this.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
  }
}

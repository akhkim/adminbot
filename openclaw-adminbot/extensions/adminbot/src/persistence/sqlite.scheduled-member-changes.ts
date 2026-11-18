import type { DatabaseSync } from "node:sqlite";
import type {
  AdminBotScheduledMemberChange,
  AdminBotScheduledMemberChangeStatus,
} from "../contracts/scheduled-member-changes.js";

/**
 * Member Type changes waiting for their day.
 *
 * Kept out of sqlite.ts, which is at its size ratchet. The table owns its own schema: it is new,
 * has no migration history to share with the main block, and `IF NOT EXISTS` makes the create
 * safe on every open. The sweep reads the pending rows by due date, which is what the index serves.
 */
export class SqliteScheduledMemberChanges {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS adminbot_scheduled_member_changes (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        status TEXT NOT NULL,
        due_on TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS adminbot_scheduled_member_changes_due_idx
        ON adminbot_scheduled_member_changes(status, due_on);
    `);
  }

  save(change: AdminBotScheduledMemberChange): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_scheduled_member_changes (
          id, member_id, status, due_on, created_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          member_id = excluded.member_id,
          status = excluded.status,
          due_on = excluded.due_on,
          created_at = excluded.created_at,
          payload_json = excluded.payload_json`,
      )
      .run(
        change.id,
        change.member_id,
        change.status,
        change.due_on,
        change.created_at,
        JSON.stringify(change),
      );
  }

  list(status?: AdminBotScheduledMemberChangeStatus): AdminBotScheduledMemberChange[] {
    const where = status ? "WHERE status = ?" : "";
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM adminbot_scheduled_member_changes ${where}
          ORDER BY due_on ASC, created_at ASC`,
      )
      .all(...(status ? [status] : [])) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as AdminBotScheduledMemberChange);
  }
}

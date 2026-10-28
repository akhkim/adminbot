import type { DatabaseSync } from "node:sqlite";

/** IDs deliberately retired by a human merge must outlive the prunable audit log. */
export class SqliteMemberRetirements {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS adminbot_member_retirements (
        member_id TEXT PRIMARY KEY,
        survivor_id TEXT NOT NULL,
        retired_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO adminbot_member_retirements (member_id, survivor_id, retired_at)
        SELECT json_extract(event_json, '$.details.duplicate_id'),
               json_extract(event_json, '$.details.survivor_id'), timestamp
        FROM adminbot_audit_events
        WHERE event_type = 'lab_member.merged'
          AND json_type(event_json, '$.details.duplicate_id') = 'text'
          AND json_type(event_json, '$.details.survivor_id') = 'text'
        ORDER BY timestamp DESC;
    `);
  }

  target(memberId: string): string | undefined {
    return (
      this.db
        .prepare("SELECT survivor_id FROM adminbot_member_retirements WHERE member_id = ?")
        .get(memberId) as { survivor_id: string } | undefined
    )?.survivor_id;
  }

  retire(memberId: string, survivorId: string, at: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`INSERT INTO adminbot_member_retirements (member_id, survivor_id, retired_at)
        VALUES (?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET
        survivor_id = excluded.survivor_id, retired_at = excluded.retired_at`)
        .run(memberId, survivorId, at);
      this.db.prepare("DELETE FROM adminbot_lab_members WHERE id = ?").run(memberId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

import type { DatabaseSync } from "node:sqlite";
import type { AdminBotRecLetterFreezeIncident } from "../contracts/rec-letter-freezes.js";

/**
 * Recommendation-letter freezes, as an admin entered them.
 *
 * Kept out of sqlite.ts, which is at its size ratchet. The table owns its own schema: it is new,
 * has no migration history to share with the main block, and `IF NOT EXISTS` makes the create
 * safe on every open. Read per member by the eligibility check and whole by the admin list, and
 * both want the latest incident first, which is what the index serves.
 */
export class SqliteRecLetterFreezeIncidents {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS adminbot_rec_letter_freeze_incidents (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        occurred_on TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS adminbot_rec_letter_freeze_incidents_member_idx
        ON adminbot_rec_letter_freeze_incidents(member_id, occurred_on DESC);
    `);
  }

  save(incident: AdminBotRecLetterFreezeIncident): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_rec_letter_freeze_incidents (
          id, member_id, occurred_on, created_at, payload_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          member_id = excluded.member_id,
          occurred_on = excluded.occurred_on,
          created_at = excluded.created_at,
          payload_json = excluded.payload_json`,
      )
      .run(
        incident.id,
        incident.member_id,
        incident.occurred_on,
        incident.created_at,
        JSON.stringify(incident),
      );
  }

  list(memberId?: string): AdminBotRecLetterFreezeIncident[] {
    const where = memberId ? "WHERE member_id = ?" : "";
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM adminbot_rec_letter_freeze_incidents ${where}
          ORDER BY occurred_on DESC, created_at DESC`,
      )
      .all(...(memberId ? [memberId] : [])) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as AdminBotRecLetterFreezeIncident);
  }

  delete(incidentId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM adminbot_rec_letter_freeze_incidents WHERE id = ?")
        .run(incidentId).changes > 0
    );
  }
}

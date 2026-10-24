import type { DatabaseSync } from "node:sqlite";
import type { AdminBotRecLetterAttestation } from "../contracts/rec-letter-attestations.js";

/**
 * Recommendation-letter attestations, as an admin entered them.
 *
 * Kept out of sqlite.ts, which is at its size ratchet, the same way the freeze incidents are: a new
 * table with no migration history, created with `IF NOT EXISTS` on every open.
 */
export class SqliteRecLetterAttestations {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS adminbot_rec_letter_attestations (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        criterion TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS adminbot_rec_letter_attestations_member_idx
        ON adminbot_rec_letter_attestations(member_id, created_at DESC);
    `);
  }

  save(attestation: AdminBotRecLetterAttestation): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_rec_letter_attestations (
          id, member_id, criterion, created_at, payload_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          member_id = excluded.member_id,
          criterion = excluded.criterion,
          created_at = excluded.created_at,
          payload_json = excluded.payload_json`,
      )
      .run(
        attestation.id,
        attestation.member_id,
        attestation.criterion,
        attestation.created_at,
        JSON.stringify(attestation),
      );
  }

  list(memberId?: string): AdminBotRecLetterAttestation[] {
    const where = memberId ? "WHERE member_id = ?" : "";
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM adminbot_rec_letter_attestations ${where}
          ORDER BY created_at DESC, id DESC`,
      )
      .all(...(memberId ? [memberId] : [])) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as AdminBotRecLetterAttestation);
  }

  delete(attestationId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM adminbot_rec_letter_attestations WHERE id = ?")
        .run(attestationId).changes > 0
    );
  }
}

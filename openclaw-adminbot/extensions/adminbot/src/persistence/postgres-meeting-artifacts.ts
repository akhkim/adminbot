import type { Pool } from "pg";
import type { AdminBotMeetingArtifactRecord } from "../kernel/service.js";

/** The meeting artifact checkpoint slice of the future PostgreSQL service store. */
export class AdminBotPostgresMeetingArtifacts {
  private readonly table: string;

  constructor(
    private readonly pool: Pool,
    schema: string,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(schema) || Buffer.byteLength(schema) > 63) {
      throw new Error("invalid PostgreSQL schema name");
    }
    this.table = `"${schema}"."adminbot_meeting_artifacts"`;
  }

  async hasAttachedMeetingArtifact(fileId: string): Promise<boolean> {
    const result = await this.pool.query<{ status: string }>(
      `SELECT status FROM ${this.table} WHERE file_id = $1`,
      [fileId],
    );
    return result.rows[0]?.status === "attached";
  }

  async recordMeetingArtifact(record: AdminBotMeetingArtifactRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table} (file_id, file_name, meeting_id, status, processed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (file_id) DO UPDATE SET
         meeting_id = EXCLUDED.meeting_id,
         status = EXCLUDED.status,
         processed_at = EXCLUDED.processed_at`,
      [
        record.file_id,
        record.file_name,
        record.meeting_id ?? null,
        record.status,
        record.processed_at,
      ],
    );
  }
}

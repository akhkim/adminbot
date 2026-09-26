import type { Pool } from "pg";
import type { AdminBotMeetingRecord } from "../contracts/actions.js";

/** Staging adapter for meeting records; the live service still uses SQLite. */
export class AdminBotPostgresMeetings {
  private readonly table: string;

  constructor(
    private readonly pool: Pool,
    schema: string,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(schema) || Buffer.byteLength(schema) > 63) {
      throw new Error("invalid PostgreSQL schema name");
    }
    this.table = `"${schema}"."adminbot_meetings"`;
  }

  async saveMeeting(meeting: AdminBotMeetingRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table} (id, started_at, updated_at, payload_json)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         started_at = EXCLUDED.started_at,
         updated_at = EXCLUDED.updated_at,
         payload_json = EXCLUDED.payload_json`,
      [meeting.id, meeting.started_at, meeting.updated_at, JSON.stringify(meeting)],
    );
  }

  async getMeeting(meetingId: string): Promise<AdminBotMeetingRecord | undefined> {
    const result = await this.pool.query<{ payload_json: string }>(
      `SELECT payload_json FROM ${this.table} WHERE id = $1`,
      [meetingId],
    );
    return result.rows[0]
      ? (JSON.parse(result.rows[0].payload_json) as AdminBotMeetingRecord)
      : undefined;
  }

  async listMeetings(): Promise<AdminBotMeetingRecord[]> {
    const result = await this.pool.query<{ payload_json: string }>(
      `SELECT payload_json FROM ${this.table} ORDER BY started_at COLLATE "C" DESC`,
    );
    return result.rows.map((row) => JSON.parse(row.payload_json) as AdminBotMeetingRecord);
  }

  async deleteMeeting(meetingId: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM ${this.table} WHERE id = $1`, [meetingId]);
    return (result.rowCount ?? 0) > 0;
  }
}

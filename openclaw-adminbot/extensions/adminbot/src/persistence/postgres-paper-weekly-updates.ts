import type { Pool } from "pg";
import type { AdminBotPaperWeeklyUpdate } from "../contracts/paper-weekly-updates.js";

/** Staging adapter; the live weekly-update service still uses SQLite. */
export class AdminBotPostgresPaperWeeklyUpdates {
  private readonly table: string;

  constructor(
    private readonly pool: Pool,
    schema: string,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(schema) || Buffer.byteLength(schema) > 63) {
      throw new Error("invalid PostgreSQL schema name");
    }
    this.table = `"${schema}"."adminbot_paper_weekly_updates"`;
  }

  async savePaperWeeklyUpdate(update: AdminBotPaperWeeklyUpdate): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table} (paper_id, member_id, week_start, updated_at, payload_json)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (paper_id, member_id, week_start) DO UPDATE SET
         updated_at = EXCLUDED.updated_at,
         payload_json = EXCLUDED.payload_json`,
      [
        update.paper_id,
        update.member_id,
        update.week_start,
        update.updated_at,
        JSON.stringify(update),
      ],
    );
  }

  async listPaperWeeklyUpdates(params?: {
    paperId?: string;
    weekStart?: string;
  }): Promise<AdminBotPaperWeeklyUpdate[]> {
    const clauses: string[] = [];
    const values: string[] = [];
    if (params?.paperId) {
      values.push(params.paperId);
      clauses.push(`paper_id = $${values.length}`);
    }
    if (params?.weekStart) {
      values.push(params.weekStart);
      clauses.push(`week_start = $${values.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.pool.query<{ payload_json: string }>(
      `SELECT payload_json FROM ${this.table}
       ${where}
       ORDER BY week_start COLLATE "C" DESC, member_id COLLATE "C"`,
      values,
    );
    return result.rows.map((row) => JSON.parse(row.payload_json) as AdminBotPaperWeeklyUpdate);
  }
}

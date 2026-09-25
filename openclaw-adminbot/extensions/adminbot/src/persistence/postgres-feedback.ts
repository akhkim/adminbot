import type { Pool } from "pg";
import type { AdminBotFeedbackEntry } from "../contracts/feedback.js";

/** Staging adapter for feedback; the live service still uses SQLite. */
export class AdminBotPostgresFeedback {
  private readonly table: string;

  constructor(
    private readonly pool: Pool,
    schema: string,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(schema) || Buffer.byteLength(schema) > 63) {
      throw new Error("invalid PostgreSQL schema name");
    }
    this.table = `"${schema}"."adminbot_feedback"`;
  }

  async saveFeedback(entry: AdminBotFeedbackEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table} (id, feature_id, rating, member_id, updated_at, payload_json)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         feature_id = EXCLUDED.feature_id,
         rating = EXCLUDED.rating,
         member_id = EXCLUDED.member_id,
         updated_at = EXCLUDED.updated_at,
         payload_json = EXCLUDED.payload_json`,
      [
        Buffer.from(entry.id, "utf8"),
        entry.feature_id,
        entry.rating,
        entry.member_id ?? null,
        entry.updated_at,
        JSON.stringify(entry),
      ],
    );
  }

  async listFeedback(featureId?: string): Promise<AdminBotFeedbackEntry[]> {
    const result = await this.pool.query<{ payload_json: string }>(
      featureId
        ? `SELECT payload_json FROM ${this.table} WHERE feature_id = $1 ORDER BY updated_at COLLATE "C" DESC`
        : `SELECT payload_json FROM ${this.table} ORDER BY updated_at COLLATE "C" DESC`,
      featureId ? [featureId] : [],
    );
    return result.rows.map((row) => JSON.parse(row.payload_json) as AdminBotFeedbackEntry);
  }
}

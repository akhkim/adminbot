import type { Pool } from "pg";
import type {
  AdminBotEmailReviewItem,
  AdminBotEmailReviewResolution,
  AdminBotResolvedEmailReviewItem,
} from "../contracts/email-review.js";
import { adminBotEmailReviewFromRow, adminBotResolvedEmailReviewFromRow } from "./email-review.js";

/** Staging review-queue slice of the future PostgreSQL service store. */
export class AdminBotPostgresEmailReviews {
  private readonly table: string;

  constructor(
    private readonly pool: Pool,
    schema: string,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(schema) || Buffer.byteLength(schema) > 63) {
      throw new Error("invalid PostgreSQL schema name");
    }
    this.table = `"${schema}"."adminbot_email_messages"`;
  }

  async saveEmailReview(review: AdminBotEmailReviewItem): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table}
        (message_id, thread_id, sender, subject, category, status, reason, attempts,
         received_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'needs_review', $6, 1, $7, $8)
       ON CONFLICT (message_id) DO UPDATE SET
         thread_id = EXCLUDED.thread_id, sender = EXCLUDED.sender,
         subject = EXCLUDED.subject, category = EXCLUDED.category,
         status = 'needs_review', reason = EXCLUDED.reason,
         received_at = EXCLUDED.received_at,
         resolved_at = NULL, resolved_by = NULL, resolution = NULL,
         updated_at = EXCLUDED.updated_at`,
      [
        review.message_id,
        review.thread_id,
        review.sender,
        review.subject ?? null,
        review.category,
        review.reason ?? null,
        review.received_at ?? null,
        review.updated_at,
      ],
    );
  }

  async listEmailReviews(): Promise<AdminBotEmailReviewItem[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT message_id, thread_id, sender, subject, category,
              COALESCE(NULLIF(TRIM(last_error), ''), reason) AS reason, received_at, updated_at
       FROM ${this.table} WHERE status = 'needs_review' ORDER BY updated_at DESC`,
    );
    return result.rows.map(adminBotEmailReviewFromRow);
  }

  async getEmailReview(messageId: string): Promise<AdminBotEmailReviewItem | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT message_id, thread_id, sender, subject, category,
              COALESCE(NULLIF(TRIM(last_error), ''), reason) AS reason, received_at, updated_at
       FROM ${this.table} WHERE message_id = $1 AND status = 'needs_review'`,
      [messageId],
    );
    return result.rows[0] ? adminBotEmailReviewFromRow(result.rows[0]) : undefined;
  }

  async listResolvedEmailReviews(limit: number): Promise<AdminBotResolvedEmailReviewItem[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT message_id, thread_id, sender, subject, category,
              COALESCE(NULLIF(TRIM(last_error), ''), reason) AS reason, received_at, updated_at,
              resolution, resolved_at, resolved_by
       FROM ${this.table}
       WHERE status = 'reviewed' AND resolution IN ('paperflow_evidence', 'dismissed')
         AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL
       ORDER BY resolved_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(adminBotResolvedEmailReviewFromRow);
  }

  async resolveEmailReview(params: {
    messageId: string;
    resolution: AdminBotEmailReviewResolution["kind"];
    resolvedBy: string;
    resolvedAt: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${this.table}
       SET status = 'reviewed', resolved_at = $1, resolved_by = $2,
           resolution = $3, updated_at = $1
       WHERE message_id = $4 AND status = 'needs_review'`,
      [params.resolvedAt, params.resolvedBy, params.resolution, params.messageId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

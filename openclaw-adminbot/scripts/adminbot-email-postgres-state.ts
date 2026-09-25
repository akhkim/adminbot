import type { Pool } from "pg";
import type { EmailMessage } from "./adminbot-email-automation.js";

/** Staging replacement for the email job's SQLite checkpoints and message claims. */
export class AdminBotPostgresEmailState {
  private readonly scanTable: string;
  private readonly messageTable: string;

  constructor(
    private readonly pool: Pool,
    schema: string,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(schema) || Buffer.byteLength(schema) > 63) {
      throw new Error("invalid PostgreSQL schema name");
    }
    this.scanTable = `"${schema}"."adminbot_email_scan"`;
    this.messageTable = `"${schema}"."adminbot_email_messages"`;
  }

  async scannedThrough(): Promise<Date | undefined> {
    const result = await this.pool.query<{ scanned_through: string }>(
      `SELECT scanned_through FROM ${this.scanTable} WHERE id = 1`,
    );
    const at = Date.parse(result.rows[0]?.scanned_through ?? "");
    return Number.isNaN(at) ? undefined : new Date(at);
  }

  async markScannedThrough(at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.scanTable} AS scan (id, scanned_through) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET scanned_through = EXCLUDED.scanned_through
       WHERE EXCLUDED.scanned_through > scan.scanned_through`,
      [at.toISOString()],
    );
  }

  async isSettled(messageId: string): Promise<boolean> {
    const result = await this.pool.query<{ status: string }>(
      `SELECT status FROM ${this.messageTable} WHERE message_id = $1`,
      [messageId],
    );
    return ["completed", "needs_review", "reviewed"].includes(result.rows[0]?.status ?? "");
  }

  async hasInProgressMessages(): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM ${this.messageTable} WHERE status = 'processing' LIMIT 1`,
    );
    return result.rowCount !== 0;
  }

  async begin(
    message: EmailMessage,
    classification: { category: string; reason: string },
  ): Promise<boolean> {
    const receivedAt =
      message.internalDate && Number.isFinite(Number(message.internalDate))
        ? new Date(Number(message.internalDate)).toISOString()
        : null;
    const result = await this.pool.query(
      `INSERT INTO ${this.messageTable} AS email
        (message_id, thread_id, sender, subject, category, status, reason, attempts,
         received_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'processing', $6, 1, $7, $8)
       ON CONFLICT (message_id) DO UPDATE SET status = 'processing',
         category = EXCLUDED.category, thread_id = EXCLUDED.thread_id,
         sender = EXCLUDED.sender, subject = EXCLUDED.subject,
         reason = EXCLUDED.reason,
         received_at = COALESCE(EXCLUDED.received_at, email.received_at),
         attempts = email.attempts + 1, last_error = NULL,
         resolved_at = NULL, resolved_by = NULL, resolution = NULL,
         updated_at = EXCLUDED.updated_at
       WHERE email.status NOT IN ('completed', 'needs_review', 'reviewed', 'processing')`,
      [
        message.id,
        message.threadId,
        message.from,
        message.subject,
        classification.category,
        classification.reason,
        receivedAt,
        new Date().toISOString(),
      ],
    );
    return result.rowCount === 1;
  }

  async finish(
    messageId: string,
    status: "completed" | "failed" | "needs_review",
    error?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.messageTable} SET status = $1, last_error = $2, updated_at = $3
       WHERE message_id = $4`,
      [status, error ?? null, new Date().toISOString(), messageId],
    );
  }
}

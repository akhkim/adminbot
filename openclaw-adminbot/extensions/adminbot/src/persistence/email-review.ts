import type { DatabaseSync } from "node:sqlite";
import type {
  AdminBotEmailReviewItem,
  AdminBotResolvedEmailReviewItem,
} from "../contracts/email-review.js";

/**
 * Keep the email automation's table readable by both the hourly script and the long-running API.
 *
 * The table predates the review inbox and therefore exists on production databases without the
 * subject, received, and resolution columns. `CREATE TABLE IF NOT EXISTS` cannot upgrade that
 * shape, so each additive column is migrated explicitly and without rewriting the live rows.
 */
export function ensureAdminBotEmailReviewSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adminbot_email_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      subject TEXT,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      received_at TEXT,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS adminbot_email_messages_review_idx
      ON adminbot_email_messages(status, updated_at DESC);
  `);
  const columns = new Set(
    (db.prepare("PRAGMA table_info(adminbot_email_messages)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  for (const name of ["subject", "received_at", "resolved_at", "resolved_by", "resolution"]) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE adminbot_email_messages ADD COLUMN ${name} TEXT`);
    }
  }
}

export function adminBotEmailReviewFromRow(row: Record<string, unknown>): AdminBotEmailReviewItem {
  const item: AdminBotEmailReviewItem = {
    message_id: String(row.message_id),
    thread_id: String(row.thread_id),
    sender: String(row.sender),
    category: String(row.category),
    updated_at: String(row.updated_at),
  };
  for (const key of ["subject", "reason", "received_at"] as const) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) {
      item[key] = value;
    }
  }
  return item;
}

export function adminBotResolvedEmailReviewFromRow(
  row: Record<string, unknown>,
): AdminBotResolvedEmailReviewItem {
  return {
    ...adminBotEmailReviewFromRow(row),
    resolution: String(row.resolution) as AdminBotResolvedEmailReviewItem["resolution"],
    resolved_at: String(row.resolved_at),
    resolved_by: String(row.resolved_by),
  };
}

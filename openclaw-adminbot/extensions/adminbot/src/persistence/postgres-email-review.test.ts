import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { AdminBotEmailReviewItem } from "../contracts/email-review.js";
import { AdminBotPostgresEmailReviews } from "./postgres-email-review.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const url = process.env.ADMINBOT_TEST_POSTGRES_URL;

describe.skipIf(!url)("PostgreSQL email review queue", () => {
  it("matches SQLite review, resolution, and reopening behavior", async () => {
    const target = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
      throw new Error("email review test requires local PostgreSQL");
    }
    const schema = `adminbot_migration_review_${randomUUID().replaceAll("-", "")}`;
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 });
    const sqlite = new AdminBotSqliteStore(":memory:");
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE "${schema}".adminbot_email_messages (
        message_id text PRIMARY KEY, thread_id text NOT NULL, sender text NOT NULL,
        subject text, category text NOT NULL, status text NOT NULL, reason text,
        attempts bigint NOT NULL DEFAULT 0, last_error text, received_at text,
        resolved_at text, resolved_by text, resolution text, updated_at text NOT NULL
      )`);
      const postgres = new AdminBotPostgresEmailReviews(pool, schema);
      const review: AdminBotEmailReviewItem = {
        message_id: "fictional-review",
        thread_id: "fictional-thread",
        sender: "venue@invalid.test",
        subject: "Paper decision",
        category: "paperflow_bcc",
        reason: "Needs human review",
        received_at: "2026-09-24T09:00:00.000Z",
        updated_at: "2026-09-24T10:00:00.000Z",
      };
      expect(await postgres.getEmailReview(review.message_id)).toEqual(
        sqlite.getEmailReview(review.message_id),
      );
      sqlite.saveEmailReview(review);
      await postgres.saveEmailReview(review);
      expect(await postgres.listEmailReviews()).toEqual(sqlite.listEmailReviews());
      expect(await postgres.getEmailReview(review.message_id)).toEqual(
        sqlite.getEmailReview(review.message_id),
      );

      await pool.query(
        `UPDATE "${schema}".adminbot_email_messages SET last_error = $1 WHERE message_id = $2`,
        ["Processing failed", review.message_id],
      );
      expect((await postgres.getEmailReview(review.message_id))?.reason).toBe("Processing failed");
      await pool.query(
        `UPDATE "${schema}".adminbot_email_messages SET last_error = NULL WHERE message_id = $1`,
        [review.message_id],
      );

      const resolution = {
        messageId: review.message_id,
        resolution: "dismissed" as const,
        resolvedBy: "fictional-admin",
        resolvedAt: "2026-09-24T11:00:00.000Z",
      };
      expect(await postgres.resolveEmailReview(resolution)).toBe(
        sqlite.resolveEmailReview(resolution),
      );
      expect(await postgres.resolveEmailReview(resolution)).toBe(
        sqlite.resolveEmailReview(resolution),
      );
      expect(await postgres.listEmailReviews()).toEqual(sqlite.listEmailReviews());
      expect(await postgres.listResolvedEmailReviews(20)).toEqual(
        sqlite.listResolvedEmailReviews(20),
      );

      sqlite.saveEmailReview({ ...review, updated_at: "2026-09-24T12:00:00.000Z" });
      await postgres.saveEmailReview({ ...review, updated_at: "2026-09-24T12:00:00.000Z" });
      expect(await postgres.listResolvedEmailReviews(20)).toEqual(
        sqlite.listResolvedEmailReviews(20),
      );
      expect(await postgres.listEmailReviews()).toEqual(sqlite.listEmailReviews());
    } finally {
      sqlite.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});

import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { adminBotFeedbackId, type AdminBotFeedbackEntry } from "../contracts/feedback.js";
import { AdminBotPostgresFeedback } from "./postgres-feedback.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const url = process.env.ADMINBOT_TEST_POSTGRES_URL;

describe.skipIf(!url)("PostgreSQL feedback", () => {
  it("matches SQLite upsert and filtered listing, including NUL-bearing keys", async () => {
    const target = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
      throw new Error("feedback test requires local PostgreSQL");
    }
    const schema = `adminbot_migration_feedback_${randomUUID().replaceAll("-", "")}`;
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 });
    const sqlite = new AdminBotSqliteStore(":memory:");
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE "${schema}".adminbot_feedback (
        id bytea PRIMARY KEY, feature_id text NOT NULL, rating integer NOT NULL,
        member_id text, updated_at text NOT NULL, payload_json text NOT NULL
      )`);
      const postgres = new AdminBotPostgresFeedback(pool, schema);
      const entry = (
        featureId: string,
        memberId: string | undefined,
        rating: number,
        updatedAt: string,
      ): AdminBotFeedbackEntry => ({
        id: adminBotFeedbackId(featureId, memberId),
        feature_id: featureId,
        rating,
        ...(memberId ? { member_id: memberId } : {}),
        comment: "Synthetic feedback",
        submitted_at: "2026-09-24T00:00:00.000Z",
        updated_at: updatedAt,
      });
      const rows = [
        entry("meetings", "member-é", 2, "2026-09-24T10:00:00.000Z"),
        entry("meetings", undefined, 3, "2026-09-24T11:00:00.000Z"),
        entry("papers", "member-é", 5, "2026-09-24T12:00:00.000Z"),
      ];
      for (const row of rows) {
        sqlite.saveFeedback(row);
        await postgres.saveFeedback(row);
      }
      expect(await postgres.listFeedback()).toEqual(sqlite.listFeedback());
      expect(await postgres.listFeedback("meetings")).toEqual(sqlite.listFeedback("meetings"));
      expect(await postgres.listFeedback("missing")).toEqual([]);

      const changed = entry("meetings", "member-é", 4, "2026-09-24T13:00:00.000Z");
      sqlite.saveFeedback(changed);
      await postgres.saveFeedback(changed);
      expect(await postgres.listFeedback("meetings")).toEqual(sqlite.listFeedback("meetings"));
      expect(await postgres.listFeedback()).toHaveLength(3);
    } finally {
      sqlite.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});

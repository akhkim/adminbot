import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { AdminBotPaperWeeklyUpdate } from "../contracts/paper-weekly-updates.js";
import { AdminBotPostgresPaperWeeklyUpdates } from "./postgres-paper-weekly-updates.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const url = process.env.ADMINBOT_TEST_POSTGRES_URL;

describe.skipIf(!url)("PostgreSQL paper weekly updates", () => {
  it("matches SQLite upsert, ordering, and each filter combination", async () => {
    const target = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
      throw new Error("weekly-update test requires local PostgreSQL");
    }
    const schema = `adminbot_migration_weekly_${randomUUID().replaceAll("-", "")}`;
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 });
    const sqlite = new AdminBotSqliteStore(":memory:");
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE "${schema}".adminbot_paper_weekly_updates (
        paper_id text NOT NULL, member_id text NOT NULL, week_start text NOT NULL,
        updated_at text NOT NULL, payload_json text NOT NULL,
        PRIMARY KEY (paper_id, member_id, week_start)
      )`);
      const postgres = new AdminBotPostgresPaperWeeklyUpdates(pool, schema);
      const entry = (
        paperId: string,
        memberId: string,
        week: string,
        body: string,
      ): AdminBotPaperWeeklyUpdate => ({
        paper_id: paperId,
        member_id: memberId,
        week_start: week,
        body,
        created_at: "2026-09-20T00:00:00.000Z",
        updated_at: "2026-09-24T00:00:00.000Z",
      });
      for (const row of [
        entry("paper-a", "member-z", "2026-09-14", "First"),
        entry("paper-a", "member-a", "2026-09-14", "Second"),
        entry("paper-a", "member-a", "2026-09-21", "Third"),
        entry("paper-b", "member-b", "2026-09-21", "Fourth"),
      ]) {
        sqlite.savePaperWeeklyUpdate(row);
        await postgres.savePaperWeeklyUpdate(row);
      }
      for (const filter of [
        undefined,
        { paperId: "paper-a" },
        { weekStart: "2026-09-21" },
        { paperId: "paper-a", weekStart: "2026-09-14" },
      ]) {
        expect(await postgres.listPaperWeeklyUpdates(filter)).toEqual(
          sqlite.listPaperWeeklyUpdates(filter),
        );
      }
      const revised = entry("paper-a", "member-z", "2026-09-14", "Revised");
      sqlite.savePaperWeeklyUpdate(revised);
      await postgres.savePaperWeeklyUpdate(revised);
      expect(await postgres.listPaperWeeklyUpdates()).toEqual(sqlite.listPaperWeeklyUpdates());
      expect(await postgres.listPaperWeeklyUpdates()).toHaveLength(4);
    } finally {
      sqlite.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});

import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { AdminBotSettings } from "../contracts/actions.js";
import { AdminBotPostgresAuthStore } from "./postgres-auth.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const url = process.env.ADMINBOT_TEST_POSTGRES_URL;

describe.skipIf(!url)("PostgreSQL settings", () => {
  it("matches SQLite when the singleton settings row is first saved and then replaced", async () => {
    const target = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
      throw new Error("settings test requires local PostgreSQL");
    }
    const schema = `adminbot_migration_settings_${randomUUID().replaceAll("-", "")}`;
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 });
    const sqlite = new AdminBotSqliteStore(":memory:");
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE "${schema}".adminbot_settings (
        id text PRIMARY KEY, updated_at text NOT NULL, payload_json text NOT NULL
      )`);
      const postgres = new AdminBotPostgresAuthStore(pool, schema);
      expect(await postgres.getSettings()).toEqual(sqlite.getSettings());
      const first: AdminBotSettings = {
        paper_escalation_business_days: 3,
        cv_recency_window_months: 6,
        updated_at: "2026-09-24T00:00:00.000Z",
      };
      const next = {
        ...first,
        cv_recency_window_months: 12,
        updated_at: "2026-09-25T00:00:00.000Z",
      };
      for (const settings of [first, next]) {
        sqlite.saveSettings(settings);
        await postgres.saveSettings(settings);
        expect(await postgres.getSettings()).toEqual(sqlite.getSettings());
      }
      const rows = await pool.query(`SELECT id FROM "${schema}".adminbot_settings`);
      expect(rows.rows).toEqual([{ id: "default" }]);
    } finally {
      sqlite.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});

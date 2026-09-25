import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../scripts/adminbot-email-automation.js";
import { AdminBotPostgresEmailScan } from "../../scripts/adminbot-email-postgres-scan.js";

const url = process.env.ADMINBOT_TEST_POSTGRES_URL;

describe.skipIf(!url)("PostgreSQL email scan watermark", () => {
  it("matches SQLite on empty, advancing, stale and concurrent checkpoints", async () => {
    const target = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
      throw new Error("email scan test requires local PostgreSQL");
    }
    const schema = `adminbot_migration_email_${randomUUID().replaceAll("-", "")}`;
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 });
    const sqlite = new StateStore(":memory:");
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE "${schema}".adminbot_email_scan (
        id bigint PRIMARY KEY CHECK (id = 1), scanned_through text COLLATE "C" NOT NULL
      )`);
      const postgres = new AdminBotPostgresEmailScan(pool, schema);
      expect(await postgres.scannedThrough()).toEqual(sqlite.scannedThrough());
      const first = new Date("2026-09-24T10:00:00.000Z");
      const later = new Date("2026-09-24T11:00:00.000Z");
      sqlite.markScannedThrough(first);
      await postgres.markScannedThrough(first);
      await Promise.all([postgres.markScannedThrough(later), postgres.markScannedThrough(first)]);
      sqlite.markScannedThrough(later);
      sqlite.markScannedThrough(first);
      expect(await postgres.scannedThrough()).toEqual(sqlite.scannedThrough());
    } finally {
      sqlite.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});

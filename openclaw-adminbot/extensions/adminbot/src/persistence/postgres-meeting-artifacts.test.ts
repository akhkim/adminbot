import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { AdminBotMeetingArtifactRecord } from "../kernel/service.js";
import { AdminBotPostgresMeetingArtifacts } from "./postgres-meeting-artifacts.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const url = process.env.ADMINBOT_TEST_POSTGRES_URL;

describe.skipIf(!url)("PostgreSQL meeting artifact checkpoint", () => {
  it("matches SQLite retries and keeps one file row under concurrent upserts", async () => {
    const target = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
      throw new Error("meeting-artifact test requires local PostgreSQL");
    }
    const schema = `adminbot_migration_artifact_${randomUUID().replaceAll("-", "")}`;
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 });
    const sqlite = new AdminBotSqliteStore(":memory:");
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE "${schema}".adminbot_meeting_artifacts (
        file_id text PRIMARY KEY, file_name text NOT NULL, meeting_id text,
        status text NOT NULL, processed_at text NOT NULL
      )`);
      const postgres = new AdminBotPostgresMeetingArtifacts(pool, schema);
      const record: AdminBotMeetingArtifactRecord = {
        file_id: "fictional-drive-file",
        file_name: "participants.csv",
        meeting_id: "meeting-1",
        status: "unmatched",
        processed_at: "2026-09-24T00:00:00.000Z",
      };
      expect(await postgres.hasAttachedMeetingArtifact(record.file_id)).toBe(
        sqlite.hasAttachedMeetingArtifact(record.file_id),
      );
      for (const status of ["unmatched", "empty", "attached", "unmatched"] as const) {
        const next = { ...record, status };
        sqlite.recordMeetingArtifact(next);
        await postgres.recordMeetingArtifact(next);
        expect(await postgres.hasAttachedMeetingArtifact(record.file_id)).toBe(
          sqlite.hasAttachedMeetingArtifact(record.file_id),
        );
      }
      const attached = { ...record, status: "attached" as const, file_name: "renamed.csv" };
      await Promise.all([
        postgres.recordMeetingArtifact(attached),
        postgres.recordMeetingArtifact(attached),
      ]);
      const rows = await pool.query<{ file_name: string; status: string }>(
        `SELECT file_name, status FROM "${schema}".adminbot_meeting_artifacts WHERE file_id = $1`,
        [record.file_id],
      );
      expect(rows.rows).toEqual([{ file_name: record.file_name, status: "attached" }]);
    } finally {
      sqlite.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});

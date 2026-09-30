import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { AdminBotMeetingRecord } from "../contracts/actions.js";
import { AdminBotPostgresMeetings } from "./postgres-meetings.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const url = process.env.ADMINBOT_TEST_POSTGRES_URL;

describe.skipIf(!url)("PostgreSQL meetings", () => {
  it("matches SQLite save, list, update, and delete behavior", async () => {
    const target = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
      throw new Error("meeting test requires local PostgreSQL");
    }
    const schema = `adminbot_migration_meetings_${randomUUID().replaceAll("-", "")}`;
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 });
    const sqlite = new AdminBotSqliteStore(":memory:");
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE "${schema}".adminbot_meetings (
        id text PRIMARY KEY, started_at text NOT NULL, updated_at text NOT NULL,
        payload_json text NOT NULL
      )`);
      const postgres = new AdminBotPostgresMeetings(pool, schema);
      const meeting = (id: string, startedAt: string): AdminBotMeetingRecord => ({
        id,
        topic: `Synthetic ${id}`,
        started_at: startedAt,
        source: "manual",
        recording: { share_url: `https://example.test/${id}` },
        created_at: "2026-09-24T00:00:00.000Z",
        updated_at: "2026-09-24T00:00:00.000Z",
      });
      const older = meeting("older", "2026-09-10T12:00:00.000Z");
      const newer = meeting("newer", "2026-09-11T12:00:00.000Z");
      const historical = meeting("historical", "not-a-date");
      for (const row of [older, newer, historical]) {
        sqlite.saveMeeting(row);
        await postgres.saveMeeting(row);
      }
      expect(await postgres.getMeeting("missing")).toBe(sqlite.getMeeting("missing"));
      expect(await postgres.listMeetings()).toEqual(sqlite.listMeetings());

      const changed = {
        ...older,
        topic: "Updated synthetic meeting",
        started_at: "2026-09-12T12:00:00.000Z",
      };
      sqlite.saveMeeting(changed);
      await postgres.saveMeeting(changed);
      expect(await postgres.getMeeting(changed.id)).toEqual(sqlite.getMeeting(changed.id));
      expect(await postgres.listMeetings()).toEqual(sqlite.listMeetings());
      expect(await postgres.deleteMeeting(newer.id)).toBe(sqlite.deleteMeeting(newer.id));
      expect(await postgres.deleteMeeting(newer.id)).toBe(sqlite.deleteMeeting(newer.id));
      expect(await postgres.listMeetings()).toEqual(sqlite.listMeetings());
    } finally {
      sqlite.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});

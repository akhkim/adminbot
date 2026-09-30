import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { StateStore, type EmailMessage } from "../../scripts/adminbot-email-automation.js";
import { AdminBotPostgresEmailState } from "../../scripts/adminbot-email-postgres-state.js";

const url = process.env.ADMINBOT_TEST_POSTGRES_URL;

describe.skipIf(!url)("PostgreSQL email job state", () => {
  it("matches SQLite checkpoints and message claim/retry rules", async () => {
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
      await pool.query(`CREATE TABLE "${schema}".adminbot_email_messages (
        message_id text PRIMARY KEY, thread_id text NOT NULL, sender text NOT NULL,
        subject text, category text NOT NULL, status text NOT NULL, reason text,
        attempts bigint NOT NULL DEFAULT 0, last_error text, received_at text,
        resolved_at text, resolved_by text, resolution text, updated_at text NOT NULL
      )`);
      await pool.query(`CREATE TABLE "${schema}".adminbot_onboarding_threads (
        thread_id text PRIMARY KEY, candidate_email text NOT NULL, decision text NOT NULL,
        source_message_id text NOT NULL, status text NOT NULL, updated_at text NOT NULL
      )`);
      await pool.query(`CREATE TABLE "${schema}".adminbot_email_effects (
        message_id text NOT NULL, effect_key text NOT NULL, status text NOT NULL,
        result_json text, updated_at text NOT NULL, PRIMARY KEY (message_id, effect_key)
      )`);
      const postgres = new AdminBotPostgresEmailState(pool, schema);
      expect(await postgres.scannedThrough()).toEqual(sqlite.scannedThrough());
      const first = new Date("2026-09-24T10:00:00.000Z");
      const later = new Date("2026-09-24T11:00:00.000Z");
      sqlite.markScannedThrough(first);
      await postgres.markScannedThrough(first);
      await Promise.all([postgres.markScannedThrough(later), postgres.markScannedThrough(first)]);
      sqlite.markScannedThrough(later);
      sqlite.markScannedThrough(first);
      expect(await postgres.scannedThrough()).toEqual(sqlite.scannedThrough());

      const message: EmailMessage = {
        id: "fictional-email",
        threadId: "fictional-thread",
        from: "example@invalid.test",
        subject: "Question",
        body: "Synthetic test message",
        internalDate: "1789754400000",
      };
      const classification = { category: "unknown", reason: "synthetic" };
      expect(await postgres.status(message.id)).toBe(sqlite.status(message.id));
      expect(await postgres.isSettled(message.id)).toBe(sqlite.isSettled(message.id));
      expect(await postgres.hasInProgressMessages()).toBe(sqlite.hasInProgressMessages());
      expect(await postgres.status(message.id)).toBe(sqlite.status(message.id));
      expect(await postgres.begin(message, classification)).toBe(
        sqlite.begin(message, classification),
      );
      expect(await postgres.begin(message, classification)).toBe(
        sqlite.begin(message, classification),
      );
      expect(await postgres.hasInProgressMessages()).toBe(sqlite.hasInProgressMessages());
      sqlite.finish(message.id, "failed", "retry");
      await postgres.finish(message.id, "failed", "retry");
      expect(await postgres.begin(message, classification)).toBe(
        sqlite.begin(message, classification),
      );
      sqlite.finish(message.id, "completed");
      await postgres.finish(message.id, "completed");
      expect(await postgres.status(message.id)).toBe(sqlite.status(message.id));
      expect(await postgres.isSettled(message.id)).toBe(sqlite.isSettled(message.id));
      expect(await postgres.hasInProgressMessages()).toBe(sqlite.hasInProgressMessages());
      expect(await postgres.begin(message, classification)).toBe(
        sqlite.begin(message, classification),
      );
      const row = await pool.query<{ attempts: string; status: string }>(
        `SELECT attempts, status FROM "${schema}".adminbot_email_messages WHERE message_id = $1`,
        [message.id],
      );
      expect(row.rows[0]).toEqual({ attempts: "2", status: "completed" });

      const simultaneous = { ...message, id: "parallel-fictional-email" };
      expect(
        (
          await Promise.all([
            postgres.begin(simultaneous, classification),
            postgres.begin(simultaneous, classification),
          ])
        ).toSorted(),
      ).toEqual([false, true]);

      expect(await postgres.getOnboarding("thread-1")).toEqual(sqlite.getOnboarding("thread-1"));
      sqlite.saveOnboarding("thread-1", "student@invalid.test", "trial", message.id);
      await postgres.saveOnboarding("thread-1", "student@invalid.test", "trial", message.id);
      expect(await postgres.getOnboarding("student@invalid.test")).toEqual(
        sqlite.getOnboarding("student@invalid.test"),
      );
      sqlite.saveOnboarding("thread-1", "student@invalid.test", "direct", message.id);
      await postgres.saveOnboarding("thread-1", "student@invalid.test", "direct", message.id);
      expect(await postgres.getOnboarding("thread-1")).toEqual(sqlite.getOnboarding("thread-1"));

      let calls = 0;
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const operation = async () => {
        calls += 1;
        started.resolve();
        await release.promise;
        return "synthetic-result";
      };
      const firstEffect = postgres.effect(message.id, "send", operation);
      await started.promise;
      await expect(postgres.effect(message.id, "send", operation)).rejects.toThrow(
        "manual review prevents a duplicate",
      );
      release.resolve();
      expect(await firstEffect).toBe("synthetic-result");
      expect(await postgres.effect(message.id, "send", operation)).toBe(
        await sqlite.effect(message.id, "send", async () => "synthetic-result"),
      );
      expect(calls).toBe(1);
      await expect(
        postgres.effect(message.id, "uncertain", async () => {
          throw new Error("synthetic failure after claim");
        }),
      ).rejects.toThrow("synthetic failure after claim");
      await expect(postgres.effect(message.id, "uncertain", operation)).rejects.toThrow(
        "manual review prevents a duplicate",
      );
    } finally {
      sqlite.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});

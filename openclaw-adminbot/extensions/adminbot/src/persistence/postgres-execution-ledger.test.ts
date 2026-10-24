import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { AdminBotExecutionResult } from "../contracts/actions.js";
import { AdminBotPostgresExecutionLedger } from "./postgres-execution-ledger.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const url = process.env.ADMINBOT_TEST_POSTGRES_URL;

describe.skipIf(!url)("PostgreSQL execution ledger", () => {
  it("matches SQLite claims and results, with one winner across two pools", async () => {
    const target = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
      throw new Error("execution-ledger test requires local PostgreSQL");
    }
    const schema = `adminbot_migration_exec_${randomUUID().replaceAll("-", "")}`;
    const firstPool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000 });
    const secondPool = new pg.Pool({
      connectionString: url,
      max: 1,
      connectionTimeoutMillis: 3000,
    });
    const sqlite = new AdminBotSqliteStore(":memory:");
    try {
      await firstPool.query(`CREATE SCHEMA "${schema}"`);
      await firstPool.query(`
        CREATE TABLE "${schema}".adminbot_execution_claims (
          effect_key text PRIMARY KEY, action_id text NOT NULL, claimed_at text NOT NULL
        );
        CREATE TABLE "${schema}".adminbot_executions (
          action_id text PRIMARY KEY, idempotency_key text UNIQUE, status text NOT NULL,
          dry_run bigint NOT NULL, executed_at text NOT NULL, result_json text NOT NULL
        );
      `);
      const first = new AdminBotPostgresExecutionLedger(firstPool, schema);
      const second = new AdminBotPostgresExecutionLedger(secondPool, schema);
      const at = "2026-09-24T00:00:00.000Z";
      const later = "2026-09-24T02:00:00.000Z";
      const staleBefore = "2026-09-24T01:00:00.000Z";

      expect(await first.claimExecution("effect", "action-a", at, staleBefore)).toBe(
        sqlite.claimExecution("effect", "action-a", at, staleBefore),
      );
      expect(await second.claimExecution("effect", "action-b", at, staleBefore)).toBe(
        sqlite.claimExecution("effect", "action-b", at, staleBefore),
      );
      expect(await second.claimExecution("effect", "action-b", later, staleBefore)).toBe(
        sqlite.claimExecution("effect", "action-b", later, staleBefore),
      );
      await first.releaseExecutionClaim("effect", "action-a");
      sqlite.releaseExecutionClaim("effect", "action-a");
      expect(await first.claimExecution("effect", "action-a", later, staleBefore)).toBe(
        sqlite.claimExecution("effect", "action-a", later, staleBefore),
      );

      const [one, two] = await Promise.all([
        first.claimExecution("parallel", "action-a", later, staleBefore),
        second.claimExecution("parallel", "action-b", later, staleBefore),
      ]);
      expect([one, two].sort()).toEqual([false, true]);

      const result: AdminBotExecutionResult = {
        action_id: "action-b",
        idempotency_key: "request-1",
        status: "executed",
        dry_run: false,
        executed_at: later,
      };
      await first.saveExecutionResult(result);
      sqlite.saveExecutionResult(result);
      expect(await second.getExecutionResult("action-b")).toEqual(
        sqlite.getExecutionResult("action-b"),
      );
      expect(await second.getExecutionResultByIdempotencyKey("request-1")).toEqual(
        sqlite.getExecutionResultByIdempotencyKey("request-1"),
      );
      await expect(
        second.saveExecutionResult({ ...result, action_id: "another-action" }),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      sqlite.close();
      await firstPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  });
});

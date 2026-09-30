import type { Pool } from "pg";
import type { AdminBotExecutionResult } from "../contracts/actions.js";

/** PostgreSQL's cross-process execution claim and durable result slice. */
export class AdminBotPostgresExecutionLedger {
  private readonly schema: string;

  constructor(
    private readonly pool: Pool,
    schema: string,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(schema) || Buffer.byteLength(schema) > 63) {
      throw new Error("invalid PostgreSQL schema name");
    }
    this.schema = `"${schema}"`;
  }

  private table(name: string): string {
    return `${this.schema}."${name}"`;
  }

  async claimExecution(
    effectKey: string,
    actionId: string,
    claimedAt: string,
    staleBefore: string,
  ): Promise<boolean> {
    // One statement replaces SQLite's delete-then-insert so separate app processes cannot both
    // take the same stale claim. A completed result is checked by the service before execution.
    const result = await this.pool.query(
      `INSERT INTO ${this.table("adminbot_execution_claims")} AS claim
         (effect_key, action_id, claimed_at) VALUES ($1, $2, $3)
       ON CONFLICT (effect_key) DO UPDATE
         SET action_id = EXCLUDED.action_id, claimed_at = EXCLUDED.claimed_at
         WHERE claim.claimed_at < $4
       RETURNING effect_key`,
      [effectKey, actionId, claimedAt, staleBefore],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async releaseExecutionClaim(effectKey: string, actionId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this.table("adminbot_execution_claims")}
       WHERE effect_key = $1 AND action_id = $2`,
      [effectKey, actionId],
    );
  }

  async saveExecutionResult(result: AdminBotExecutionResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table("adminbot_executions")}
         (action_id, idempotency_key, status, dry_run, executed_at, result_json)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        result.action_id,
        result.idempotency_key ?? null,
        result.status,
        result.dry_run ? 1 : 0,
        result.executed_at,
        JSON.stringify(result),
      ],
    );
  }

  async getExecutionResult(actionId: string): Promise<AdminBotExecutionResult | undefined> {
    const row = await this.pool.query<{ result_json: string }>(
      `SELECT result_json FROM ${this.table("adminbot_executions")} WHERE action_id = $1`,
      [actionId],
    );
    return row.rows[0]
      ? (JSON.parse(row.rows[0].result_json) as AdminBotExecutionResult)
      : undefined;
  }

  async getExecutionResultByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<AdminBotExecutionResult | undefined> {
    const row = await this.pool.query<{ result_json: string }>(
      `SELECT result_json FROM ${this.table("adminbot_executions")}
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return row.rows[0]
      ? (JSON.parse(row.rows[0].result_json) as AdminBotExecutionResult)
      : undefined;
  }
}

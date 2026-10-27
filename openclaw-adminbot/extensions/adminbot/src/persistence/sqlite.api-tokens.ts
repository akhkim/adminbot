import type { DatabaseSync } from "node:sqlite";
import type { AdminBotApiToken, AdminBotApiTokenUsage } from "../contracts/api-tokens.js";
import {
  API_TOKEN_COLUMNS,
  apiTokenValues,
  rowToApiToken,
  type ApiTokenRow,
} from "./api-token-rows.js";

/**
 * Personal API tokens (docs/adminbot/api-tokens.md). Only the SHA-256 of each secret is stored.
 *
 * Kept out of sqlite.ts, which is at its size ratchet, and owns its own schema the same way the
 * rec-letter tables do: the table is new, and `IF NOT EXISTS` makes the create safe on every open.
 * The member index serves the token list; the unique hash serves every authenticated request.
 */
export class SqliteApiTokens {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS adminbot_api_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        member_id TEXT NOT NULL,
        name TEXT NOT NULL,
        hint TEXT NOT NULL,
        scopes_json TEXT NOT NULL DEFAULT '["*"]',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_ip TEXT,
        last_used_at TEXT,
        last_used_ip TEXT,
        last_used_place TEXT,
        seen_ips_json TEXT NOT NULL DEFAULT '[]',
        revoked_at TEXT,
        revoked_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS adminbot_api_tokens_member_idx
        ON adminbot_api_tokens(member_id, created_at);
    `);
  }

  save(token: AdminBotApiToken): void {
    this.db
      .prepare(
        `INSERT INTO adminbot_api_tokens (${API_TOKEN_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...apiTokenValues(token));
  }

  byHash(tokenHash: string): AdminBotApiToken | undefined {
    const row = this.db
      .prepare(`SELECT ${API_TOKEN_COLUMNS} FROM adminbot_api_tokens WHERE token_hash = ?`)
      .get(tokenHash) as ApiTokenRow | undefined;
    return row ? rowToApiToken(row) : undefined;
  }

  byId(id: string): AdminBotApiToken | undefined {
    const row = this.db
      .prepare(`SELECT ${API_TOKEN_COLUMNS} FROM adminbot_api_tokens WHERE id = ?`)
      .get(id) as ApiTokenRow | undefined;
    return row ? rowToApiToken(row) : undefined;
  }

  forMember(memberId: string): AdminBotApiToken[] {
    const rows = this.db
      .prepare(
        `SELECT ${API_TOKEN_COLUMNS} FROM adminbot_api_tokens
         WHERE member_id = ? ORDER BY created_at DESC`,
      )
      .all(memberId) as ApiTokenRow[];
    return rows.map(rowToApiToken);
  }

  touch(id: string, usage: AdminBotApiTokenUsage): void {
    this.db
      .prepare(
        `UPDATE adminbot_api_tokens
         SET last_used_at = ?, last_used_ip = ?, last_used_place = ?, seen_ips_json = ?
         WHERE id = ?`,
      )
      .run(
        usage.last_used_at,
        usage.last_used_ip ?? null,
        usage.last_used_place ?? null,
        JSON.stringify(usage.seen_ips),
        id,
      );
  }

  /** True when this call revoked it; false when it was missing or already revoked. */
  revoke(id: string, revokedAt: string, reason: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE adminbot_api_tokens SET revoked_at = ?, revoked_reason = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, reason, id);
    return Number(result.changes ?? 0) > 0;
  }

  revokeForMember(memberId: string, revokedAt: string, reason: string): number {
    const result = this.db
      .prepare(
        `UPDATE adminbot_api_tokens SET revoked_at = ?, revoked_reason = ?
         WHERE member_id = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, reason, memberId);
    return Number(result.changes ?? 0);
  }
}

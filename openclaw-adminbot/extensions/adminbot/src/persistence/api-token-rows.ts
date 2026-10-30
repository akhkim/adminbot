// The `adminbot_api_tokens` row shape, shared by the SQLite store and the PostgreSQL auth slice so
// both read the same columns the same way. Scopes and seen IPs are JSON text: the table is copied
// to PostgreSQL by the generic migration script, which keeps SQLite's column types.
import type { AdminBotApiToken } from "../contracts/api-tokens.js";

export const API_TOKEN_COLUMNS = `id, token_hash, member_id, name, hint, scopes_json, created_at,
  expires_at, created_ip, last_used_at, last_used_ip, last_used_place, seen_ips_json, revoked_at,
  revoked_reason`;

export type ApiTokenRow = {
  id: string;
  token_hash: string;
  member_id: string;
  name: string;
  hint: string;
  scopes_json: string;
  created_at: string;
  expires_at: string;
  created_ip: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  last_used_place: string | null;
  seen_ips_json: string;
  revoked_at: string | null;
  revoked_reason: string | null;
};

function stringList(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function rowToApiToken(row: ApiTokenRow): AdminBotApiToken {
  return {
    id: row.id,
    token_hash: row.token_hash,
    member_id: row.member_id,
    name: row.name,
    hint: row.hint,
    scopes: stringList(row.scopes_json),
    created_at: row.created_at,
    expires_at: row.expires_at,
    seen_ips: stringList(row.seen_ips_json),
    ...(row.created_ip ? { created_ip: row.created_ip } : {}),
    ...(row.last_used_at ? { last_used_at: row.last_used_at } : {}),
    ...(row.last_used_ip ? { last_used_ip: row.last_used_ip } : {}),
    ...(row.last_used_place ? { last_used_place: row.last_used_place } : {}),
    ...(row.revoked_at ? { revoked_at: row.revoked_at } : {}),
    ...(row.revoked_reason ? { revoked_reason: row.revoked_reason } : {}),
  };
}

/** Insert values in API_TOKEN_COLUMNS order. */
export function apiTokenValues(token: AdminBotApiToken): Array<string | null> {
  return [
    token.id,
    token.token_hash,
    token.member_id,
    token.name,
    token.hint,
    JSON.stringify(token.scopes),
    token.created_at,
    token.expires_at,
    token.created_ip ?? null,
    token.last_used_at ?? null,
    token.last_used_ip ?? null,
    token.last_used_place ?? null,
    JSON.stringify(token.seen_ips),
    token.revoked_at ?? null,
    token.revoked_reason ?? null,
  ];
}

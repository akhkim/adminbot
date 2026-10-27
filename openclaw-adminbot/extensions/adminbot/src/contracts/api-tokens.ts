// The stored shape of a personal API token. See docs/adminbot/api-tokens.md.

/**
 * A personal API token: a named, expiring credential a member mints for a script, a CI job or a
 * coding agent. Only the SHA-256 of the secret is stored; `id` is the public handle the token list
 * and revocation use. See docs/adminbot/api-tokens.md.
 */
export type AdminBotApiToken = {
  id: string;
  token_hash: string;
  member_id: string;
  name: string;
  /** Last four characters of the secret, so two tokens in a list can be told apart. */
  hint: string;
  /** Always ["*"] today: a token acts as its owner. Stored so narrower scopes need no migration. */
  scopes: string[];
  created_at: string;
  expires_at: string;
  created_ip?: string;
  last_used_at?: string;
  last_used_ip?: string;
  /** "City, Country" from the IP database at last use, when one is configured. */
  last_used_place?: string;
  /** Every address the token has been used from, most recent first, capped. Drives new-IP flags. */
  seen_ips: string[];
  revoked_at?: string;
  revoked_reason?: string;
};

/** What a request records on its token: written at most every few minutes, and on a new IP. */
export type AdminBotApiTokenUsage = {
  last_used_at: string;
  last_used_ip?: string;
  last_used_place?: string;
  seen_ips: string[];
};

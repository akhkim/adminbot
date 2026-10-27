// The shape of an API token and the small pure rules around it: how one is minted, recognised and
// hashed, who may hold one, and how many requests a minute it may make. Kept apart from the token
// service so the tests can use the same definitions without a store. scripts/check-secrets.mjs
// repeats the checksum (it runs in the pre-commit hook without tsx); a test keeps the two in step.
//
// See docs/adminbot/api-tokens.md for the design.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  adminBotPrivilegeLevels,
  type AdminBotLabMember,
  type AdminBotPrivilegeLevel,
} from "../../contracts/actions.js";

export const API_TOKEN_PREFIX = "abt_";
const SECRET_BYTES = 32;
// 32 bytes of base64url is 43 characters; the checksum is 8 hex digits of CRC32.

/** The longest fixed lifetime a token can ask for. Without one a token lives until it sits idle. */
export const API_TOKEN_MAX_DAYS = 365;
/**
 * The `expires_at` of a token with no fixed lifetime, as gh and Modal tokens have. Stored as a date
 * rather than null so every `expires_at <= now` comparison and the NOT NULL column stay as they are.
 */
export const API_TOKEN_NO_EXPIRY = "9999-12-31T23:59:59.999Z";
/** A token nobody has used for this long is revoked the next time it is presented. */
export const API_TOKEN_IDLE_REVOKE_MS = 90 * 24 * 60 * 60 * 1000;
export const API_TOKEN_NAME_MAX = 64;
export const API_TOKEN_REQUESTS_PER_MINUTE = 600;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Hex(text: string): string {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, "utf8")) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

export function mintApiTokenSecret(): string {
  const body = `${API_TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return `${body}_${crc32Hex(body)}`;
}

export function newApiTokenId(): string {
  return `tok_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

/**
 * Whether a string is shaped like a token *and* its checksum matches. Used to route a bearer to
 * the token table rather than the session table, and by the secret scanner to tell a real leak from
 * a string that merely starts with `abt_`.
 */
export function isApiTokenShaped(value: string): boolean {
  const match = /^abt_([A-Za-z0-9_-]{43})_([0-9a-f]{8})$/u.exec(value);
  return Boolean(match) && crc32Hex(value.slice(0, -9)) === match![2];
}

/** Same digest as a session token: the secret is 256 random bits, so a slow hash adds nothing. */
export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The last four characters, shown in the token list so a member can tell two tokens apart. */
export function apiTokenHint(token: string): string {
  return token.slice(-4);
}

/**
 * Which privilege levels may hold a token. Admins only by default; a deployment widens it with
 * ADMINBOT_API_TOKEN_LEVELS (e.g. "admin,member") without a code change. Unknown names are ignored
 * so a typo narrows rather than widens.
 */
export function apiTokenLevels(raw: string | undefined): Set<AdminBotPrivilegeLevel> {
  const named = (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is AdminBotPrivilegeLevel =>
      (adminBotPrivilegeLevels as readonly string[]).includes(part),
    );
  return new Set(named.length ? named : ["admin"]);
}

export function apiTokensAllowed(
  member: Pick<AdminBotLabMember, "privilege_level">,
  levels: Set<AdminBotPrivilegeLevel>,
): boolean {
  return levels.has(member.privilege_level);
}

/**
 * Days until expiry, clamped to 1..365, or undefined for no fixed expiry (the default): absent,
 * null, empty or unparseable all mean "until it sits idle".
 */
export function clampApiTokenDays(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const days = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(days) || days <= 0) {
    return undefined;
  }
  return Math.min(API_TOKEN_MAX_DAYS, Math.max(1, Math.floor(days)));
}

/** A display name: printable, trimmed, at most 64 characters. Empty means invalid. */
export function cleanApiTokenName(value: unknown): string {
  return typeof value === "string"
    ? value
        // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
        .replace(/[\u0000-\u001f\u007f]/gu, "")
        .trim()
        .slice(0, API_TOKEN_NAME_MAX)
    : "";
}

/**
 * A fixed one-minute window per token. In memory: a restart resets every window, which only ever
 * errs towards allowing a request, and one service process owns all of them.
 */
export class ApiTokenRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly perMinute = API_TOKEN_REQUESTS_PER_MINUTE) {}

  /** Seconds to wait, or 0 when the request may go ahead. */
  take(tokenId: string, nowMs: number): number {
    const window = this.windows.get(tokenId);
    if (!window || nowMs - window.start >= 60_000) {
      this.windows.set(tokenId, { start: nowMs, count: 1 });
      if (this.windows.size > 10_000) {
        this.sweep(nowMs);
      }
      return 0;
    }
    window.count += 1;
    if (window.count <= this.perMinute) {
      return 0;
    }
    return Math.max(1, Math.ceil((window.start + 60_000 - nowMs) / 1000));
  }

  private sweep(nowMs: number): void {
    for (const [id, window] of this.windows) {
      if (nowMs - window.start >= 60_000) {
        this.windows.delete(id);
      }
    }
  }
}

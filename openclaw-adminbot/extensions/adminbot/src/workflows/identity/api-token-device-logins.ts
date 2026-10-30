// Pending "adminbot login" requests: the browser-approval handshake after RFC 8628.
//
// Kept in memory: a request lives ten minutes, the service runs as one process, and a restart just
// asks the person at the terminal to run `adminbot login` again. The store is an interface so a
// shared table can replace it if the service is ever scaled out.
//
// Nothing secret is held here. The CLI's device code is stored as its SHA-256, and no token exists
// until the CLI collects it (see AdminBotApiTokenService.pollDeviceLogin), so an approval nobody
// picks up leaves nothing behind.
import { createHash, randomBytes, randomInt } from "node:crypto";

export const DEVICE_LOGIN_TTL_MS = 10 * 60 * 1000;
export const DEVICE_LOGIN_POLL_SECONDS = 5;
// A bound on memory, not a rate limit (that is per IP, in the service). Past it, new requests are
// refused until old ones expire rather than evicting somebody's in-progress sign-in.
const MAX_PENDING_DEVICE_LOGINS = 500;

// No vowels (so no words), and none of 0/O, 1/I/L, 5/S, 2/Z that are misread off a screen.
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRTVWXY";

export type DeviceLoginStatus = "pending" | "approved" | "denied";

export type DeviceLogin = {
  device_code_hash: string;
  /** Normalised: eight letters, no dash. Shown to people as XXXX-XXXX. */
  user_code: string;
  name: string;
  /** Undefined: no fixed expiry. */
  expires_in_days?: number;
  requested_ip?: string;
  created_at: string;
  expires_at: string;
  status: DeviceLoginStatus;
  /** Who approved it. Set with status "approved". */
  member_id?: string;
  last_polled_ms?: number;
};

export interface DeviceLoginStore {
  add(login: DeviceLogin): boolean;
  byUserCode(userCode: string): DeviceLogin | undefined;
  byDeviceCodeHash(hash: string): DeviceLogin | undefined;
  remove(deviceCodeHash: string): void;
}

export class MemoryDeviceLoginStore implements DeviceLoginStore {
  private readonly byDevice = new Map<string, DeviceLogin>();
  private readonly byUser = new Map<string, string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  add(login: DeviceLogin): boolean {
    this.sweep();
    if (this.byDevice.size >= MAX_PENDING_DEVICE_LOGINS || this.byUser.has(login.user_code)) {
      return false;
    }
    this.byDevice.set(login.device_code_hash, login);
    this.byUser.set(login.user_code, login.device_code_hash);
    return true;
  }

  byUserCode(userCode: string): DeviceLogin | undefined {
    const hash = this.byUser.get(userCode);
    return hash ? this.live(hash) : undefined;
  }

  byDeviceCodeHash(hash: string): DeviceLogin | undefined {
    return this.live(hash);
  }

  remove(deviceCodeHash: string): void {
    const login = this.byDevice.get(deviceCodeHash);
    if (login) {
      this.byUser.delete(login.user_code);
    }
    this.byDevice.delete(deviceCodeHash);
  }

  private live(hash: string): DeviceLogin | undefined {
    const login = this.byDevice.get(hash);
    if (login && login.expires_at <= this.now().toISOString()) {
      this.remove(hash);
      return undefined;
    }
    return login;
  }

  private sweep(): void {
    const nowIso = this.now().toISOString();
    for (const [hash, login] of this.byDevice) {
      if (login.expires_at <= nowIso) {
        this.remove(hash);
      }
    }
  }
}

export function newDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

export function hashDeviceCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function newUserCode(): string {
  let code = "";
  for (let i = 0; i < 8; i += 1) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
}

/** What a person typed or a link carried, reduced to the stored form; undefined if it cannot be one. */
export function normalizeUserCode(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const code = value.toUpperCase().replace(/[^A-Z]/gu, "");
  return code.length === 8 && [...code].every((c) => USER_CODE_ALPHABET.includes(c))
    ? code
    : undefined;
}

export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

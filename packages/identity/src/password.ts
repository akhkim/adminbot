import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_BYTES = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(serialized: string, password: string): Promise<boolean>;
}

/**
 * Uses the same serialized format and parameters as v1 so migrated hashes remain usable. Work is
 * asynchronous so password derivation does not block the service event loop.
 */
export class ScryptPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SCRYPT_SALT_BYTES);
    const derived = await derive(password, salt);
    return [
      "scrypt",
      SCRYPT_N,
      SCRYPT_R,
      SCRYPT_P,
      salt.toString("base64url"),
      derived.toString("base64url"),
    ].join("$");
  }

  async verify(serialized: string, password: string): Promise<boolean> {
    const parsed = parseSerializedHash(serialized);
    if (parsed === undefined) return false;
    const derived = await derive(password, parsed.salt);
    return timingSafeEqual(parsed.expected, derived);
  }
}

export function isSupportedScryptHash(serialized: string): boolean {
  return parseSerializedHash(serialized) !== undefined;
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

function parseSerializedHash(
  serialized: string,
): { readonly salt: Buffer; readonly expected: Buffer } | undefined {
  const [algorithm, n, r, p, encodedSalt, encodedHash, ...extra] = serialized.split("$");
  if (
    extra.length !== 0 ||
    algorithm !== "scrypt" ||
    n !== String(SCRYPT_N) ||
    r !== String(SCRYPT_R) ||
    p !== String(SCRYPT_P) ||
    encodedSalt === undefined ||
    encodedHash === undefined
  ) {
    return undefined;
  }
  const salt = decodeBase64Url(encodedSalt, SCRYPT_SALT_BYTES);
  const expected = decodeBase64Url(encodedHash, SCRYPT_KEY_LENGTH);
  return salt === undefined || expected === undefined ? undefined : { salt, expected };
}

function decodeBase64Url(encoded: string, expectedLength: number): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== expectedLength || decoded.toString("base64url") !== encoded) {
    return undefined;
  }
  return decoded;
}

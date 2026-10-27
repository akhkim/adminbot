import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ApiError } from "./client.mjs";
import { keychainAvailable, keychainDelete, keychainRead, keychainSave } from "./keychain.mjs";

// The file holds one credential for one origin: a member session from `auth login --email`, or a
// personal API token from `auth login`. A token's secret lives in the macOS Keychain when there is
// one ("keychain": true), and the file then holds only which origin, id and expiry it belongs to.
// Where the Keychain refuses (a sandboxed agent, a locked keychain, --insecure-storage), the token
// goes in the file itself, which only this user can read, as `gh` does.

export async function readSession(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw new ApiError("CREDENTIALS_ERROR", "Cannot read saved credentials");
  }
}
export async function saveSession(file, data) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
/** Before a new login replaces the file: drop the Keychain item the old record pointed at. */
export async function forgetSavedSecret(file, env = process.env) {
  const saved = await readSession(file).catch(() => undefined);
  if (saved?.keychain && typeof saved.url === "string") {
    await keychainDelete(saved.url, env);
  }
}
export async function saveApiToken(file, url, token, apiToken, env = process.env) {
  await forgetSavedSecret(file, env);
  const record = { url, kind: "api_token", id: apiToken.id, expires_at: apiToken.expires_at };
  if (keychainAvailable(env)) {
    try {
      await keychainSave(url, token, env);
      await saveSession(file, { ...record, keychain: true });
      return "keychain";
    } catch {
      // Fall through to the private file rather than lose an approved login.
    }
  }
  await saveSession(file, { ...record, token });
  return "file";
}
export async function clearSession(file, url, token, env = process.env) {
  const saved = await readSession(file);
  if (saved?.url === url && (await savedToken(saved, env)) === token) {
    if (saved.keychain) {
      await keychainDelete(url, env);
    }
    await rm(file, { force: true });
  }
}
async function savedToken(saved, env) {
  return saved.keychain ? keychainRead(saved.url, env).catch(() => undefined) : saved.token;
}
export async function sessionToken(file, url, override, env = process.env) {
  if (override?.trim()) {
    return override.trim();
  }
  const saved = await readSession(file);
  if (saved?.url !== url) {
    return undefined;
  }
  if (
    !Number.isFinite(Date.parse(saved.expires_at)) ||
    Date.parse(saved.expires_at) <= Date.now()
  ) {
    throw new ApiError("SESSION_EXPIRED", "Signed-in session expired. Run: adminbot login", 401);
  }
  const token = await savedToken(saved, env);
  if (!token) {
    throw new ApiError(
      "CREDENTIALS_ERROR",
      "Cannot read the saved token from the macOS Keychain (sandboxed agents often cannot). " +
        "Run: adminbot login --insecure-storage, or set ADMINBOT_TOKEN",
      401,
    );
  }
  return token;
}

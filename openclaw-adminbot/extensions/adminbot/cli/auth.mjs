import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ApiError } from "./client.mjs";

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
export async function clearSession(file, url, token) {
  const saved = await readSession(file);
  if (saved?.url === url && saved.token === token) {
    await rm(file, { force: true });
  }
}
export async function sessionToken(file, url, override) {
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
    throw new ApiError("SESSION_EXPIRED", "Session expired; run auth login", 401);
  }
  return saved.token;
}

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";

export function createBackupPath(directory: string, label: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `${label}-${randomUUID()}.sqlite`);
}

export async function backupSqlite(sourcePath: string, backupPath: string): Promise<void> {
  if (existsSync(backupPath)) throw new Error("refusing to overwrite a SQLite backup");
  const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await database.backup(backupPath);
  } finally {
    database.close();
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function safeBackupLabel(path: string, kind: "source" | "destination"): string {
  const stem = basename(path).replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 80);
  return `legacy-${kind}-${stem || "database"}`;
}

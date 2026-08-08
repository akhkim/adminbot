import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";

const stateDirectory = "/app/state";
const sourcePath = join(stateDirectory, "adminbot-v2.sqlite");
const backupDirectory = join(stateDirectory, "backups");
const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const finalPath = join(backupDirectory, `adminbot-v2-${timestamp}.sqlite`);
const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
const backupPattern = /^adminbot-v2-\d{4}-\d{2}-\d{2}T.*Z\.sqlite$/u;
const retainedBackups = 14;

await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
try {
  await database.backup(temporaryPath);
} finally {
  database.close();
}

await chmod(temporaryPath, 0o600);
await rename(temporaryPath, finalPath);

const backups = (await readdir(backupDirectory))
  .filter((name) => backupPattern.test(name))
  .sort()
  .reverse();
for (const expired of backups.slice(retainedBackups)) {
  await rm(join(backupDirectory, expired));
}

console.log(JSON.stringify({ event: "sqlite.backup_completed", retained: Math.min(backups.length, retainedBackups) }));

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

const snapshotScript = path.join(process.cwd(), "scripts/snapshot-sqlite.mjs");

it("snapshots committed WAL rows and verifies the resulting database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-snapshot-"));
  const source = path.join(directory, "source.sqlite");
  const destination = path.join(directory, "snapshot.sqlite");
  const writer = new DatabaseSync(source);
  try {
    writer.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; " +
        "CREATE TABLE members (id TEXT PRIMARY KEY); INSERT INTO members VALUES ('fictional-member')",
    );
    expect(fs.existsSync(`${source}-wal`)).toBe(true);
    execFileSync(process.execPath, [snapshotScript, source, destination, "--verify"]);
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT id FROM members").get()).toEqual({ id: "fictional-member" });
      expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      snapshot.close();
    }
  } finally {
    writer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("refuses a malformed source rather than producing a seed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-snapshot-"));
  try {
    const source = path.join(directory, "source.sqlite");
    const destination = path.join(directory, "snapshot.sqlite");
    fs.writeFileSync(source, "not a database");
    const result = spawnSync(process.execPath, [snapshotScript, source, destination, "--verify"]);
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(destination)).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

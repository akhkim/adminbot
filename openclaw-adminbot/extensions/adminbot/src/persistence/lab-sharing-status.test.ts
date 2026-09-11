import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  ensureDirectorStatusSchema,
  listDirectorStatusHistory,
  readDirectorStatus,
  saveDirectorStatus,
} from "./lab-sharing-status.js";

const row = {
  id: "bcast_one",
  availability: "busy" as const,
  message: "Synthetic review",
  expires_at: "2026-09-08T00:00:00Z",
  updated_at: "2026-09-07T00:00:00Z",
  updated_by: "synthetic-admin",
};

it("preserves existing data and keeps every broadcast across restarts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "director-status-"));
  const file = path.join(dir, "ledger.sqlite");
  let db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE existing (value TEXT); INSERT INTO existing VALUES ('keep')");
    ensureDirectorStatusSchema(db);
    ensureDirectorStatusSchema(db);
    expect(readDirectorStatus(db)).toBeNull();

    saveDirectorStatus(db, row);
    saveDirectorStatus(db, {
      ...row,
      id: "bcast_two",
      message: "Second broadcast",
      updated_at: "2026-09-08T00:00:00Z",
    });
    db.close();
    db = new DatabaseSync(file);

    // The newest is current; the first is still on the record. This is what the single-row table
    // could not do -- publishing the second one used to erase the first.
    expect(readDirectorStatus(db)?.message).toBe("Second broadcast");
    expect(listDirectorStatusHistory(db).map((entry) => entry.message)).toEqual([
      "Second broadcast",
      "Synthetic review",
    ]);

    saveDirectorStatus(db, null);
    db.close();
    db = new DatabaseSync(file);
    // Retracted, not deleted.
    expect(readDirectorStatus(db)?.retracted_at).toBeTruthy();
    expect(listDirectorStatusHistory(db)).toHaveLength(2);
    expect(db.prepare("SELECT value FROM existing").get()?.value).toBe("keep");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// An installation that has been running carries a current status in the pre-history table. Losing
// it on upgrade would blank the banner for whatever it was saying.
it("carries a pre-history row into the archive and leaves the old table empty", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "director-status-migrate-"));
  const file = path.join(dir, "ledger.sqlite");
  let db = new DatabaseSync(file);
  try {
    // Exactly the shape the old schema wrote: one row, and no id on the payload.
    db.exec(`CREATE TABLE IF NOT EXISTS adminbot_director_status (
      id INTEGER PRIMARY KEY CHECK (id = 1), payload_json TEXT NOT NULL
    )`);
    const legacy = { ...row, id: undefined };
    delete (legacy as { id?: string }).id;
    db.prepare("INSERT INTO adminbot_director_status (id, payload_json) VALUES (1, ?)").run(
      JSON.stringify(legacy),
    );

    ensureDirectorStatusSchema(db);
    const migrated = readDirectorStatus(db);
    expect(migrated?.message).toBe("Synthetic review");
    // Minted on the way through, so every archive entry is addressable.
    expect(migrated?.id).toBeTruthy();
    // One source of truth afterwards: a populated legacy table is how a later reader picks wrong.
    expect(db.prepare("SELECT count(*) AS count FROM adminbot_director_status").get()?.count).toBe(
      0,
    );

    // Idempotent -- reopening the database must not duplicate the migrated entry.
    ensureDirectorStatusSchema(db);
    db.close();
    db = new DatabaseSync(file);
    ensureDirectorStatusSchema(db);
    expect(listDirectorStatusHistory(db)).toHaveLength(1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("drops an unreadable pre-history row rather than failing every open", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "director-status-bad-"));
  const file = path.join(dir, "ledger.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS adminbot_director_status (
      id INTEGER PRIMARY KEY CHECK (id = 1), payload_json TEXT NOT NULL
    )`);
    db.prepare("INSERT INTO adminbot_director_status (id, payload_json) VALUES (1, ?)").run("{not json");
    expect(() => ensureDirectorStatusSchema(db)).not.toThrow();
    expect(listDirectorStatusHistory(db)).toHaveLength(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

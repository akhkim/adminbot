import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  ensureDirectorStatusSchema,
  readDirectorStatus,
  saveDirectorStatus,
} from "./lab-sharing-status.js";

it("preserves existing data and persists status replacement and clearing through restarts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "director-status-"));
  const file = path.join(dir, "ledger.sqlite");
  let db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE existing (value TEXT); INSERT INTO existing VALUES ('keep')");
    ensureDirectorStatusSchema(db);
    ensureDirectorStatusSchema(db);
    expect(readDirectorStatus(db)).toBeNull();
    const row = {
      availability: "busy" as const,
      message: "Synthetic review",
      expires_at: "2026-09-08T00:00:00Z",
      updated_at: "2026-09-07T00:00:00Z",
      updated_by: "synthetic-admin",
    };
    saveDirectorStatus(db, row);
    saveDirectorStatus(db, { ...row, message: "Updated synthetic status" });
    db.close();
    db = new DatabaseSync(file);
    expect(readDirectorStatus(db)).toEqual({ ...row, message: "Updated synthetic status" });
    expect(db.prepare("SELECT count(*) AS count FROM adminbot_director_status").get()?.count).toBe(
      1,
    );
    saveDirectorStatus(db, null);
    db.close();
    db = new DatabaseSync(file);
    expect(readDirectorStatus(db)).toBeNull();
    expect(db.prepare("SELECT value FROM existing").get()?.value).toBe("keep");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

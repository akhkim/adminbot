import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { batchReadsPerTick, isReadOnlySql } from "./sqlite.read-batch.js";

const dirs: string[] = [];
function database() {
  const dir = mkdtempSync(path.join(tmpdir(), "read-batch-"));
  dirs.push(dir);
  const file = path.join(dir, "db.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  return { db, file };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function manualSchedule() {
  const pending: Array<() => void> = [];
  return {
    schedule: (run: () => void) => void pending.push(run),
    endTurn: () => pending.splice(0).forEach((run) => run()),
  };
}

describe("isReadOnlySql", () => {
  it("lets plain reads join and keeps writes and setting pragmas out", () => {
    expect(isReadOnlySql("  -- note\n SELECT 1")).toBe(true);
    expect(isReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
    expect(isReadOnlySql("PRAGMA schema_version")).toBe(true);
    expect(isReadOnlySql("PRAGMA table_info(t)")).toBe(true);
    expect(isReadOnlySql("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x")).toBe(false);
    expect(isReadOnlySql("INSERT INTO t (v) VALUES ('a') RETURNING id")).toBe(false);
    expect(isReadOnlySql("PRAGMA foreign_keys = ON")).toBe(false);
    expect(isReadOnlySql("PRAGMA wal_checkpoint")).toBe(false);
  });
});

describe("batchReadsPerTick", () => {
  it("runs a turn's reads in one transaction and commits when the turn ends", () => {
    const { db } = database();
    const turn = manualSchedule();
    batchReadsPerTick(db, { schedule: turn.schedule });
    db.prepare("SELECT * FROM t").all();
    expect(db.isTransaction).toBe(true);
    turn.endTurn();
    expect(db.isTransaction).toBe(false);
  });

  it("commits the batch before a write, so the write still commits on its own", () => {
    const { db, file } = database();
    const turn = manualSchedule();
    batchReadsPerTick(db, { schedule: turn.schedule });
    db.prepare("SELECT * FROM t").all();
    db.prepare("INSERT INTO t (v) VALUES (?)").run("a");
    expect(db.isTransaction).toBe(false);
    const other = new DatabaseSync(file);
    expect(other.prepare("SELECT count(*) AS c FROM t").get()).toEqual({ c: 1 });
    other.close();
  });

  it("leaves explicit transactions to their own BEGIN and COMMIT", () => {
    const { db } = database();
    const turn = manualSchedule();
    batchReadsPerTick(db, { schedule: turn.schedule });
    db.prepare("SELECT * FROM t").all();
    db.exec("BEGIN IMMEDIATE");
    db.prepare("SELECT * FROM t").all();
    db.prepare("INSERT INTO t (v) VALUES (?)").run("a");
    db.exec("ROLLBACK");
    turn.endTurn();
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT count(*) AS c FROM t").get()).toEqual({ c: 0 });
  });

  it("shows another connection's write from the next turn", () => {
    const { db, file } = database();
    const turn = manualSchedule();
    batchReadsPerTick(db, { schedule: turn.schedule });
    const count = () => db.prepare("SELECT count(*) AS c FROM t").get();
    expect(count()).toEqual({ c: 0 });
    const other = new DatabaseSync(file);
    other.prepare("INSERT INTO t (v) VALUES ('b')").run();
    other.close();
    expect(count()).toEqual({ c: 0 });
    turn.endTurn();
    expect(count()).toEqual({ c: 1 });
  });

  it("commits on close", () => {
    const { db } = database();
    batchReadsPerTick(db, { schedule: () => {} });
    db.prepare("SELECT 1").get();
    expect(() => db.close()).not.toThrow();
  });
});

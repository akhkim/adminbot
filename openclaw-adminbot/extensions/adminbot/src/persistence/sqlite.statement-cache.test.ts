import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AdminBotSqliteStore } from "./sqlite.js";
import { cacheStatements } from "./sqlite.statement-cache.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("cacheStatements", () => {
  it("compiles each SQL string once and never carries a binding into the next call", () => {
    const db = new DatabaseSync(":memory:");
    cacheStatements(db);
    const statement = db.prepare("SELECT ? AS a, ? AS b");
    expect(db.prepare("SELECT ? AS a, ? AS b")).toBe(statement);
    expect(statement.get(1, 2)).toEqual({ a: 1, b: 2 });
    expect(db.prepare("SELECT ? AS a, ? AS b").get(5)).toEqual({ a: 5, b: null });
    expect(db.prepare("SELECT ? AS a", { readBigInts: true })).not.toBe(
      db.prepare("SELECT ? AS a"),
    );
    db.close();
  });

  it("sees a column added after the statement was first compiled", () => {
    const db = new DatabaseSync(":memory:");
    cacheStatements(db);
    db.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('x')");
    expect(db.prepare("SELECT * FROM t").all()).toEqual([{ a: "x" }]);
    db.exec("ALTER TABLE t ADD COLUMN b TEXT");
    expect(db.prepare("SELECT * FROM t").all()).toEqual([{ a: "x", b: null }]);
    db.close();
  });

  it("sees a column another connection added", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-statements-"));
    dirs.push(dir);
    const file = path.join(dir, "shared.sqlite");
    const db = new DatabaseSync(file);
    cacheStatements(db);
    db.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('x')");
    expect(db.prepare("SELECT * FROM t").all()).toEqual([{ a: "x" }]);
    const other = new DatabaseSync(file);
    other.exec("ALTER TABLE t ADD COLUMN b TEXT");
    other.close();
    expect(db.prepare("SELECT * FROM t").all()).toEqual([{ a: "x", b: null }]);
    db.close();
  });

  it("is on for the store: a repeated read compiles nothing new", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-statements-"));
    dirs.push(dir);
    const store = new AdminBotSqliteStore(path.join(dir, "adminbot.sqlite"));
    store.saveProposal({
      id: "prop1",
      type: "paper.upsert",
      status: "pending",
      risk_tier: "low",
      payload_hash: "h",
      payload: {},
      created_at: "2026-03-01T00:00:00.000Z",
      updated_at: "2026-03-01T00:00:00.000Z",
    } as never);
    const first = store.listPending(25, 0);
    const second = store.listPending(25, 0);
    expect(second).toEqual(first);
    expect(first).toHaveLength(1);
    const db = (store as unknown as { db: DatabaseSync }).db;
    const sql = "SELECT 1 AS one";
    expect(db.prepare(sql)).toBe(db.prepare(sql));
    store.close();
  });
});

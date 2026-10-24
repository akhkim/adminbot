import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdminBotSqliteStore } from "./sqlite.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type Db = { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } };

function open(): { store: AdminBotSqliteStore; db: Db } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-plans-"));
  dirs.push(dir);
  const store = new AdminBotSqliteStore(path.join(dir, "adminbot.sqlite"));
  return { store, db: (store as unknown as { db: Db }).db };
}

function plan(db: Db, sql: string, ...args: unknown[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join("\n");
}

// Rows written out of key order, with ties, so neither the index nor the table order is free.
const TIMES = ["2026-03-02", "2026-03-01", "2026-03-02", "2026-03-03", "2026-03-01", "2026-03-02"];

describe("indexes behind the unbounded reads", () => {
  it("reads one proposal type through an index, in the order the full scan sorted to", () => {
    const { store, db } = open();
    TIMES.forEach((day, index) => {
      store.saveProposal({
        id: `prop${index}`,
        type: index % 2 ? "paper.upsert" : "deadline.upsert",
        status: "pending",
        risk_tier: "low",
        payload_hash: `h${index}`,
        payload: {},
        created_at: `${day}T00:00:00.000Z`,
        updated_at: `${day}T00:00:00.000Z`,
      } as never);
    });
    const sql =
      "SELECT payload_json FROM adminbot_proposals WHERE action_type = ? ORDER BY created_at ASC";
    const shown = plan(db, sql, "deadline.upsert");
    expect(shown).toContain("adminbot_proposals_type_idx");
    expect(shown).not.toContain("TEMP B-TREE");
    for (const type of ["deadline.upsert", "paper.upsert"] as const) {
      const scanned = db
        .prepare(sql.replace("adminbot_proposals", "adminbot_proposals NOT INDEXED"))
        .all(type) as Array<{ payload_json: string }>;
      expect(store.listProposalsByType(type as never).map((row) => row.id)).toEqual(
        scanned.map((row) => (JSON.parse(row.payload_json) as { id: string }).id),
      );
    }
    store.close();
  });

  it("serves the newest-first activity feed from an index, ties broken by rowid", () => {
    const { store, db } = open();
    TIMES.forEach((day, index) => {
      store.appendUpdateEvent({
        id: `e${index}`,
        subject: "profile",
        slot_id: `profile:m${index}:name`,
        member_id: `m${index}`,
        at: `${day}T00:00:00.000Z`,
        source: "web",
      } as never);
    });
    const shown = plan(
      db,
      "SELECT id FROM adminbot_update_events ORDER BY at DESC, rowid DESC LIMIT ?",
      4,
    );
    expect(shown).toContain("adminbot_update_events_at_idx");
    expect(shown).not.toContain("TEMP B-TREE");
    expect(store.listRecentUpdateEvents(4).map((event) => event.id)).toEqual([
      "e3",
      "e5",
      "e2",
      "e0",
    ]);
    expect(store.listUpdateEventsSince("2026-03-02").map((event) => event.id)).toEqual([
      "e3",
      "e5",
      "e2",
      "e0",
    ]);
    store.close();
  });
});

// The stored workshop-matching pass, asserted against both stores.
//
// The point of storing it is that the pass outlives the request that started it: it is thousands
// of model calls and tens of minutes, so the browser cannot wait and the answer has to survive
// somewhere the next page open can read. These check the parts that makes true -- the newest pass
// wins, progress is visible while it runs, and a finished pass keeps its payload across a restart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotWorkshopMatchRun } from "../contracts/paper-cycle.js";
import type { AdminBotServiceStore } from "../kernel/service.js";
import { AdminBotMemoryStore } from "./memory.js";
import { createAdminBotSqliteService } from "./sqlite.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-wsm-"));
  tempDirs.push(dir);
  return path.join(dir, "adminbot.sqlite");
}

function sqliteStore(databasePath = tempDbPath()): AdminBotServiceStore {
  return createAdminBotSqliteService({ databasePath }).store;
}

const stores: Array<[string, () => AdminBotServiceStore]> = [
  ["memory", () => new AdminBotMemoryStore()],
  ["sqlite", () => sqliteStore()],
];

function run(overrides: Partial<AdminBotWorkshopMatchRun> = {}): AdminBotWorkshopMatchRun {
  return {
    id: "wsm-1",
    status: "running",
    started_at: "2026-08-27T10:00:00.000Z",
    calls_done: 0,
    calls_total: 0,
    ...overrides,
  };
}

describe.each(stores)("%s store: workshop match runs", (_name, makeStore) => {
  it("has nothing before the first pass", () => {
    expect(makeStore().latestWorkshopMatchRun()).toBeUndefined();
  });

  it("updates a pass in place as it progresses", () => {
    const store = makeStore();
    store.saveWorkshopMatchRun(run());
    store.saveWorkshopMatchRun(run({ calls_done: 800, calls_total: 2500 }));
    const latest = store.latestWorkshopMatchRun();
    expect(latest?.calls_done).toBe(800);
    expect(latest?.calls_total).toBe(2500);
    expect(latest?.status).toBe("running");
  });

  it("keeps the payload of a finished pass", () => {
    const store = makeStore();
    store.saveWorkshopMatchRun(
      run({
        status: "ready",
        finished_at: "2026-08-27T10:40:00.000Z",
        payload_json: JSON.stringify({ paper_count: 153 }),
      }),
    );
    const latest = store.latestWorkshopMatchRun();
    expect(latest?.status).toBe("ready");
    expect(JSON.parse(latest?.payload_json ?? "{}")).toEqual({ paper_count: 153 });
  });

  it("returns the newest pass, not the first one", () => {
    const store = makeStore();
    store.saveWorkshopMatchRun(run({ id: "old", status: "ready" }));
    store.saveWorkshopMatchRun(
      run({ id: "new", started_at: "2026-08-27T11:00:00.000Z", status: "running" }),
    );
    expect(store.latestWorkshopMatchRun()?.id).toBe("new");
  });

  it("keeps why a pass failed", () => {
    const store = makeStore();
    store.saveWorkshopMatchRun(run({ status: "failed", error: "connect ECONNREFUSED" }));
    expect(store.latestWorkshopMatchRun()?.error).toContain("ECONNREFUSED");
  });

  it("leaves absent fields absent rather than null", () => {
    const store = makeStore();
    store.saveWorkshopMatchRun(run());
    const latest = store.latestWorkshopMatchRun();
    // SQL NULL round-tripping as an own property is the divergence between the two stores that
    // would otherwise go unnoticed until a caller checked `"error" in run`.
    expect(latest && "error" in latest).toBe(false);
    expect(latest && "payload_json" in latest).toBe(false);
  });
});

describe("sqlite store: durability", () => {
  it("keeps a finished pass across a restart", () => {
    const databasePath = tempDbPath();
    sqliteStore(databasePath).saveWorkshopMatchRun(
      run({ status: "ready", payload_json: JSON.stringify({ paper_count: 7 }) }),
    );
    // The whole reason this is stored rather than held in memory: the pass has to survive the
    // process that ran it, not just the request.
    const reopened = sqliteStore(databasePath).latestWorkshopMatchRun();
    expect(reopened?.status).toBe("ready");
    expect(JSON.parse(reopened?.payload_json ?? "{}")).toEqual({ paper_count: 7 });
  });
});

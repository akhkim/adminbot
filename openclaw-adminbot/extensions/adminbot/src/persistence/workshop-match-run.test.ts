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

  it("returns the replacement when both runs started in the same millisecond", () => {
    // Not hypothetical: replacing a wedged pass writes the old row off and inserts the new one in
    // the same tick, so they share a timestamp. Ordering on `started_at` alone then hands back
    // whichever was written first -- the dead run -- and the tab stays wedged on the pass that was
    // just replaced, which is the exact failure the replacement exists to end.
    const store = makeStore();
    const sameMoment = "2026-08-27T11:00:00.000Z";
    store.saveWorkshopMatchRun(
      run({ id: "abandoned", started_at: sameMoment, status: "failed", calls_done: 1671 }),
    );
    store.saveWorkshopMatchRun(run({ id: "replacement", started_at: sameMoment }));
    expect(store.latestWorkshopMatchRun()?.id).toBe("replacement");
  });

  it("keeps how many calls failed", () => {
    const store = makeStore();
    store.saveWorkshopMatchRun(run({ calls_done: 2540, calls_total: 2540, calls_failed: 37 }));
    // A failed call still advances `calls_done`, so without this the page cannot tell a complete
    // sweep from one that gave up on 37 workshops and reported the total anyway.
    expect(store.latestWorkshopMatchRun()?.calls_failed).toBe(37);
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

describe.each(stores)("%s store: a pass in flight", (_name, makeStore) => {
  it("stamps when it last moved", () => {
    const store = makeStore();
    store.saveWorkshopMatchRun(run({ calls_done: 40, calls_total: 2540 }));
    // Without this, a row that says `running` cannot be told from one whose process is gone, and
    // the "one pass at a time" guard refuses every later pass in the dead one's name.
    expect(Date.parse(store.latestWorkshopMatchRun()?.progress_at ?? "")).toBeGreaterThan(0);
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

  // A pass is an un-awaited task inside the service, so it cannot outlive the process that started
  // it. Before this, a restart mid-pass left the row saying `running` forever: the tab sat on
  // "Matching in progress..." counting calls nobody was making, and every later pass was refused.
  it("closes out a pass its process did not survive", () => {
    const databasePath = tempDbPath();
    sqliteStore(databasePath).saveWorkshopMatchRun(run({ calls_done: 1671, calls_total: 2540 }));

    const reopened = sqliteStore(databasePath).latestWorkshopMatchRun();
    expect(reopened?.status).toBe("failed");
    expect(reopened?.error).toContain("restarted");
    expect(reopened?.finished_at).toBeTruthy();
    // The counts stay as they were: they say how far it got before it died.
    expect(reopened?.calls_done).toBe(1671);
  });

  it("leaves a pass that finished properly alone", () => {
    const databasePath = tempDbPath();
    sqliteStore(databasePath).saveWorkshopMatchRun(run({ status: "ready" }));
    expect(sqliteStore(databasePath).latestWorkshopMatchRun()?.status).toBe("ready");
  });
});

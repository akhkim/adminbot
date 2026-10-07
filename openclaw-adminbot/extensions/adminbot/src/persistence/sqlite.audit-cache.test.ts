import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotAuditEvent } from "../contracts/actions.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-audit-"));
  dirs.push(dir);
  const file = path.join(dir, "adminbot.sqlite");
  return { file, store: new AdminBotSqliteStore(file) };
}

function event(id: string, timestamp: string): AdminBotAuditEvent {
  return { id, type: "proposal.created", timestamp, actor: "test" } as AdminBotAuditEvent;
}

const ids = (events: AdminBotAuditEvent[]) => events.map((entry) => entry.id);

// A month of audit is ~10k events and 2.7MB on Aurora, and profile and onboarding reads walk all
// of it -- some three times a request. It is parsed once and extended as events are recorded.
describe("audit reads", () => {
  it("parses once and keeps up with every event recorded through the store", () => {
    const { store } = openStore();
    store.recordAudit(event("b", "2026-10-02T00:00:00.000Z"));
    store.recordAudit(event("a", "2026-10-01T00:00:00.000Z"));

    const first = store.listAuditEvents();
    expect(ids(first)).toEqual(["a", "b"]);
    expect(store.listAuditEvents()[0]).toBe(first[0]);

    store.recordAudit(event("c", "2026-10-03T00:00:00.000Z"));
    store.recordAudit(event("early", "2026-09-30T00:00:00.000Z"));
    expect(ids(store.listAuditEvents())).toEqual(["early", "a", "b", "c"]);

    expect(store.pruneAuditEventsBefore("2026-10-02T00:00:00.000Z")).toBe(2);
    expect(ids(store.listAuditEvents())).toEqual(["b", "c"]);
  });

  it("does not let a caller's array or event edits reach the cache", () => {
    const { store } = openStore();
    const recorded = event("a", "2026-10-01T00:00:00.000Z");
    store.recordAudit(recorded);
    store.listAuditEvents().length = 0;
    recorded.actor = "changed after recording";
    expect(store.listAuditEvents().map((entry) => entry.actor)).toEqual(["test"]);
  });

  it("sees events written by another process", () => {
    const { file, store } = openStore();
    store.recordAudit(event("a", "2026-10-01T00:00:00.000Z"));
    expect(ids(store.listAuditEvents())).toEqual(["a"]);

    const other = new DatabaseSync(file);
    const outside = event("z", "2026-10-05T00:00:00.000Z");
    other
      .prepare(
        "INSERT INTO adminbot_audit_events (id, event_type, timestamp, event_json) VALUES (?, ?, ?, ?)",
      )
      .run(outside.id, outside.type, outside.timestamp, JSON.stringify(outside));
    other.close();

    expect(ids(store.listAuditEvents())).toEqual(["a", "z"]);
  });
});

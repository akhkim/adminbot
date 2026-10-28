import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AdminBotService } from "../kernel/service.js";
import { AdminBotSqliteStore } from "./sqlite.js";
import { SqliteMemberRetirements } from "./sqlite.member-retirements.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-retired-"));
  dirs.push(dir);
  return path.join(dir, "test.sqlite");
}

describe("durable member retirement", () => {
  it("rolls back retirement metadata when deleting the roster row fails", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE adminbot_audit_events(event_type TEXT, event_json TEXT, timestamp TEXT);
        CREATE TABLE adminbot_lab_members(id TEXT PRIMARY KEY);
        INSERT INTO adminbot_lab_members VALUES ('stale-import');
        CREATE TRIGGER refuse_delete BEFORE DELETE ON adminbot_lab_members
          BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
      const retirements = new SqliteMemberRetirements(db);
      expect(() => retirements.retire("stale-import", "canonical", "2026-10-28T00:00:00Z")).toThrow(
        "synthetic failure",
      );
      expect(retirements.target("stale-import")).toBeUndefined();
      expect(db.prepare("SELECT id FROM adminbot_lab_members").get()).toMatchObject({
        id: "stale-import",
      });
    } finally {
      db.close();
    }
  });

  it("survives audit pruning and restart and follows survivor renames", () => {
    const file = database();
    let store = new AdminBotSqliteStore(file);
    const service = new AdminBotService(store);
    service.upsertLabMember({ id: "canonical", name: "Synthetic Person" });
    service.upsertLabMember({ id: "stale-import", name: "Synthetic Person" });
    expect(
      service.mergeLabMembers({
        survivorId: "canonical",
        duplicateId: "stale-import",
        actorId: "admin",
      }).ok,
    ).toBe(true);
    expect(
      service.renameLabMember({ memberId: "canonical", newId: "renamed-person", actorId: "admin" })
        .ok,
    ).toBe(true);
    expect(store.retiredMemberTarget("stale-import")).toBe("renamed-person");
    store.pruneAuditEventsBefore("9999-01-01T00:00:00Z");
    store.close();
    store = new AdminBotSqliteStore(file);
    try {
      const restarted = new AdminBotService(store);
      expect(restarted.upsertLabMember({ id: "stale-import", name: "Stale Person" })).toMatchObject(
        { ok: false, status: 409 },
      );
      expect(store.getLabMember("stale-import")).toBeUndefined();
      expect(store.getLabMember("renamed-person")?.name).toBe("Synthetic Person");
    } finally {
      store.close();
    }
  });

  it("backfills retained legacy merge evidence without deleting an already recreated row", () => {
    const file = database();
    let store = new AdminBotSqliteStore(file);
    const service = new AdminBotService(store);
    service.upsertLabMember({ id: "canonical", name: "Synthetic Person" });
    service.upsertLabMember({ id: "stale-import", name: "Existing Duplicate" });
    store.recordAudit({
      id: "legacy-merge",
      type: "lab_member.merged",
      timestamp: "2026-10-27T00:00:00Z",
      details: { duplicate_id: "stale-import", survivor_id: "canonical" },
    });
    store.close();
    store = new AdminBotSqliteStore(file);
    try {
      expect(store.retiredMemberTarget("stale-import")).toBe("canonical");
      expect(store.getLabMember("stale-import")?.name).toBe("Existing Duplicate");
      const restarted = new AdminBotService(store);
      expect(
        restarted.renameLabMember({
          memberId: "stale-import",
          newId: "another-id",
          actorId: "admin",
        }),
      ).toMatchObject({ ok: false, status: 409 });
      expect(
        restarted.mergeLabMembers({
          survivorId: "stale-import",
          duplicateId: "canonical",
          actorId: "admin",
        }),
      ).toMatchObject({ ok: false, status: 409 });
      expect(store.retiredMemberTarget("stale-import")).toBe("canonical");

      expect(
        new AdminBotService(store).upsertLabMember({ id: "stale-import", name: "Stale Update" }),
      ).toMatchObject({ ok: false, status: 409 });
      expect(store.getLabMember("stale-import")?.name).toBe("Existing Duplicate");
    } finally {
      store.close();
    }
  });
});

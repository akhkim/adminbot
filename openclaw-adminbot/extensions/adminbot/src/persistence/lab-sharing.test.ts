import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { ensureLabSharingSchema, saveHelpRequest, listHelpRequests } from "./lab-sharing.js";

describe("Lab Sharing persistence", () => {
  it("adds its table without altering existing data and survives reopening", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lab-help-"));
    const file = path.join(dir, "ledger.sqlite");
    let db = new DatabaseSync(file);
    try {
      db.exec("CREATE TABLE existing (value TEXT); INSERT INTO existing VALUES ('keep')");
      ensureLabSharingSchema(db);
      ensureLabSharingSchema(db);
      const row = {
        paper_id: "p1",
        owner_id: "m1",
        description: "Synthetic request",
        tags: ["qa"],
        members_needed: 1,
        hours_per_week: 2,
        timeline: "",
        status: "open" as const,
        created_at: "2026-09-06",
        updated_at: "2026-09-06",
      };
      saveHelpRequest(db, row);
      saveHelpRequest(db, { ...row, description: "Updated" });
      db.close();
      db = new DatabaseSync(file);
      ensureLabSharingSchema(db);
      expect(listHelpRequests(db)).toEqual([{ ...row, description: "Updated" }]);
      expect(db.prepare("SELECT value FROM existing").get()?.value).toBe("keep");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

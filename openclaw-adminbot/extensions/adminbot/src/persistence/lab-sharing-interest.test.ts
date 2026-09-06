import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { LabHelpInterest } from "../contracts/lab-sharing-interest.js";
import {
  ensureLabInterestSchema,
  listHelpInterests,
  saveHelpInterest,
} from "./lab-sharing-interest.js";

it("preserves unrelated data and separate respondents across upsert, withdrawal and reopening", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lab-interest-"));
  const file = path.join(dir, "ledger.sqlite");
  let db = new DatabaseSync(file);
  const row: LabHelpInterest = {
    paper_id: "p1",
    member_id: "m1",
    hours_per_week: 2,
    note: "Synthetic offer",
    status: "active",
    created_at: "2026-09-06",
    updated_at: "2026-09-06",
  };
  try {
    db.exec("CREATE TABLE existing (value TEXT); INSERT INTO existing VALUES ('keep')");
    ensureLabInterestSchema(db);
    ensureLabInterestSchema(db);
    saveHelpInterest(db, row);
    saveHelpInterest(db, { ...row, member_id: "m2" });
    saveHelpInterest(db, { ...row, paper_id: "p2" });
    saveHelpInterest(db, { ...row, hours_per_week: 3, status: "withdrawn" });
    db.close();
    db = new DatabaseSync(file);
    ensureLabInterestSchema(db);
    expect(listHelpInterests(db)).toEqual([
      { ...row, hours_per_week: 3, status: "withdrawn" },
      { ...row, member_id: "m2" },
      { ...row, paper_id: "p2" },
    ]);
    expect(db.prepare("SELECT value FROM existing").get()?.value).toBe("keep");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

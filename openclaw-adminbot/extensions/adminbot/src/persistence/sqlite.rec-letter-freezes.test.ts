import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotRecLetterFreezeIncident } from "../contracts/rec-letter-freezes.js";
import { AdminBotSqliteStore } from "./sqlite.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-freezes-"));
  dirs.push(dir);
  return path.join(dir, "adminbot.sqlite");
}

function incident(
  id: string,
  memberId: string,
  occurredOn: string,
  extra: Partial<AdminBotRecLetterFreezeIncident> = {},
): AdminBotRecLetterFreezeIncident {
  return {
    id,
    member_id: memberId,
    kind: "hallucinated_citation_desk_rejection",
    occurred_on: occurredOn,
    created_by: "admin:m-admin",
    created_at: "2026-10-01T12:00:00.000Z",
    ...extra,
  };
}

describe("recommendation-letter freeze incidents on SQLite", () => {
  it("lists newest first, per member or all, and survives a reopen", () => {
    const file = tempFile();
    const store = new AdminBotSqliteStore(file);
    store.saveRecLetterFreezeIncident(incident("f1", "m-alpha", "2025-03-02"));
    store.saveRecLetterFreezeIncident(
      incident("f2", "m-alpha", "2026-01-15", { paper_id: "p-1", note: "synthetic note" }),
    );
    store.saveRecLetterFreezeIncident(incident("f3", "m-beta", "2025-11-30"));
    store.close();

    // Reopening runs every create and migration again; both must be safe on an existing file.
    const reopened = new AdminBotSqliteStore(file);
    expect(reopened.listRecLetterFreezeIncidents().map((row) => row.id)).toEqual([
      "f2",
      "f3",
      "f1",
    ]);
    const alpha = reopened.listRecLetterFreezeIncidents("m-alpha");
    expect(alpha.map((row) => row.id)).toEqual(["f2", "f1"]);
    expect(alpha[0]).toMatchObject({ paper_id: "p-1", note: "synthetic note" });
    expect(reopened.listRecLetterFreezeIncidents("m-nobody")).toEqual([]);
    reopened.close();
  });

  it("upserts by id and deletes once", () => {
    const store = new AdminBotSqliteStore(tempFile());
    store.saveRecLetterFreezeIncident(incident("f1", "m-alpha", "2025-03-02"));
    store.saveRecLetterFreezeIncident(incident("f1", "m-alpha", "2025-04-02"));
    expect(store.listRecLetterFreezeIncidents()).toHaveLength(1);
    expect(store.listRecLetterFreezeIncidents()[0]?.occurred_on).toBe("2025-04-02");

    expect(store.deleteRecLetterFreezeIncident("f1")).toBe(true);
    expect(store.deleteRecLetterFreezeIncident("f1")).toBe(false);
    expect(store.listRecLetterFreezeIncidents()).toEqual([]);
    store.close();
  });
});

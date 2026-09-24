import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AdminBotMemoryStore } from "./memory.js";
import { AdminBotSqliteStore } from "./sqlite.js";

describe.each(["memory", "sqlite"] as const)("list ordering and Unicode search (%s)", (kind) => {
  it("uses the same folded order and search for member and paper pages", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-list-parity-"));
    const store =
      kind === "sqlite"
        ? new AdminBotSqliteStore(path.join(dir, "state.sqlite"))
        : new AdminBotMemoryStore();
    try {
      for (const [id, name] of [
        ["a", "alice"],
        ["b", "Bob"],
        ["e1", "Émile"],
        ["e2", "émile"],
      ]) {
        store.saveLabMember({
          id,
          name,
          privilege_level: "member",
          access: [],
          created_at: "2026-09-01T00:00:00.000Z",
          updated_at: "2026-09-01T00:00:00.000Z",
        });
        store.savePaper({
          id,
          title: name,
          authors: [name],
          current_step: "overleaf_writing",
          created_at: "2026-09-01T00:00:00.000Z",
          updated_at: "2026-09-01T00:00:00.000Z",
        });
      }
      expect(store.listLabMembers({ limit: 2, offset: 1 }).map((member) => member.id)).toEqual([
        "b",
        "e1",
      ]);
      expect(store.listLabMemberSummaries().map((member) => member.id)).toEqual([
        "a",
        "b",
        "e1",
        "e2",
      ]);
      expect(store.countLabMembers("ÉMILE")).toBe(2);
      expect(
        store.listLabMembers({ limit: 5, offset: 0, q: "ÉMILE" }).map((member) => member.id),
      ).toEqual(["e1", "e2"]);
      expect(store.listPapers({ limit: 2, offset: 1 }).map((paper) => paper.id)).toEqual([
        "b",
        "e1",
      ]);
      expect(store.countPapers("ÉMILE")).toBe(2);
      expect(
        store.listPapers({ limit: 5, offset: 0, q: "ÉMILE" }).map((paper) => paper.id),
      ).toEqual(["e1", "e2"]);
    } finally {
      if (store instanceof AdminBotSqliteStore) {
        store.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps accented page order stable while matching accented search case-insensitively", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-list-accent-"));
    const store =
      kind === "sqlite"
        ? new AdminBotSqliteStore(path.join(dir, "state.sqlite"))
        : new AdminBotMemoryStore();
    try {
      for (const [id, name] of [
        ["a", "émile"],
        ["z", "Émile"],
      ]) {
        store.saveLabMember({
          id,
          name,
          privilege_level: "member",
          access: [],
          created_at: "2026-09-01T00:00:00.000Z",
          updated_at: "2026-09-01T00:00:00.000Z",
        });
      }
      expect(store.listLabMembers({ limit: 2, offset: 0 }).map((member) => member.id)).toEqual([
        "z",
        "a",
      ]);
      expect(store.countLabMembers("ÉMILE")).toBe(2);
    } finally {
      if (store instanceof AdminBotSqliteStore) {
        store.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDeadlineDataset } from "./runtime-dataset.js";

describe("runtime deadline dataset", () => {
  it("reads an atomically replaced snapshot without restarting and fails on invalid data", () => {
    const directory = mkdtempSync(join(tmpdir(), "deadline-test-"));
    const file = join(directory, "venues.json");
    const row = { id: "example", name: "Example", deadline_aoe: "2026-09-14 23:59:00" };
    try {
      writeFileSync(file, JSON.stringify({ items: [row] }));
      expect(readDeadlineDataset(file)).toEqual([row]);
      row.deadline_aoe = "2026-09-21 23:59:00";
      writeFileSync(file + ".next", JSON.stringify({ items: [row] }));
      renameSync(file + ".next", file);
      expect(readDeadlineDataset(file)).toEqual([row]);
      for (const invalid of [
        "{",
        JSON.stringify({ items: [] }),
        JSON.stringify({ items: [row, row] }),
        JSON.stringify({ items: [{ ...row, deadline_aoe: "2026-02-31 23:59:00" }] }),
      ]) {
        writeFileSync(file, invalid);
        expect(() => readDeadlineDataset(file)).toThrow();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

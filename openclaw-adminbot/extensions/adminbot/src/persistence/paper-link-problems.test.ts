// The sheet refresh writes paper-link-problems.json; the service only trusts a fresh one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPaperLinkProblems, sqliteServiceOptions } from "./sqlite.js";

const dirs: string[] = [];
function fileWith(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "link-problems-"));
  dirs.push(dir);
  const file = path.join(dir, "paper-link-problems.json");
  fs.writeFileSync(file, content);
  return file;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readPaperLinkProblems", () => {
  const now = new Date("2026-10-24T12:00:00Z");

  it("keeps papers with at least one problem string", () => {
    const file = fileWith(
      JSON.stringify({
        generated_at: "2026-10-24T06:00:00+00:00",
        papers: { p1: ["Overleaf: restricted", 3], p2: [], p3: "nope" },
      }),
    );
    expect([...readPaperLinkProblems(file, now)]).toEqual([["p1", ["Overleaf: restricted"]]]);
  });

  it("ignores a file the refresh has not rewritten in two days", () => {
    const file = fileWith(
      JSON.stringify({ generated_at: "2026-10-21T06:00:00Z", papers: { p1: ["x"] } }),
    );
    expect(readPaperLinkProblems(file, now).size).toBe(0);
  });

  it("reads a missing or corrupt file as no problems", () => {
    expect(readPaperLinkProblems(fileWith("{not json"), now).size).toBe(0);
    expect(readPaperLinkProblems("/nonexistent/paper-link-problems.json", now).size).toBe(0);
  });

  it("looks beside the database, and not at all for an in-memory one", () => {
    expect(
      sqliteServiceOptions({ databasePath: "/srv/state/adminbot.sqlite" }).paperLinkProblems,
    ).toBeTypeOf("function");
    expect(sqliteServiceOptions({ databasePath: ":memory:" }).paperLinkProblems).toBeUndefined();
  });
});

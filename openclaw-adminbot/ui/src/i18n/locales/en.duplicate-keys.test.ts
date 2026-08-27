// A duplicate top-level section in en.ts is silent and total.
//
// Object literals keep the last value for a repeated key, so a second `myWork: { ... }` further
// down the file does not merge with the first -- it replaces it. Everything in the earlier block
// stops existing, `t()` finds nothing, and the UI renders the key path itself: buttons reading
// "myWork.delete.action". Nothing fails; the strings just quietly disappear.
//
// This happened. The delete control shipped showing its own key names because a new `myWork`
// section was added near the top of a 2,000-line file that already had one near the bottom.
// TypeScript does not flag it, and `ui:i18n:check` is red for unrelated reasons, so the only thing
// that would have caught it is reading the whole file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "en.ts"),
  "utf8",
);

describe("en.ts", () => {
  it("declares every top-level section exactly once", () => {
    const seen = new Map<string, number>();
    // Two-space indentation is the top level of the exported object; anything deeper is a nested
    // key, which is allowed to repeat inside different parents.
    for (const match of source.matchAll(/^ {2}([A-Za-z_$][\w$]*):\s*\{/gmu)) {
      const key = match[1] as string;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([key, count]) => `${key} (${count}x)`);
    expect(duplicates).toEqual([]);
    // Guard the guard: if the scan ever stops matching, an empty result would look like a pass.
    expect(seen.size).toBeGreaterThan(20);
  });

  it("keeps the strings the delete control renders", () => {
    // The exact keys my-work.ts asks for. Present here, absent from the bundle, is the shape the
    // duplicate produced.
    const myWork = /^ {2}myWork:\s*\{/mu.exec(source);
    expect(myWork).not.toBeNull();
    const section = source.slice(myWork?.index ?? 0, (myWork?.index ?? 0) + 2000);
    expect(section).toContain("delete: {");
    expect(section).toContain("Delete this paper");
  });
});

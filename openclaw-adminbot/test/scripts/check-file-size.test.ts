// File size check tests cover scope selection, line counting and the grandfather ratchet.
import { describe, expect, it } from "vitest";
import {
  countLines,
  evaluateFileSizes,
  isScannedSourcePath,
  parseFileSizeConfig,
} from "../../scripts/check-file-size.mjs";

function createConfig(grandfathered: Record<string, { max: number; reason: string }> = {}) {
  return { limit: 3, grandfathered };
}

describe("isScannedSourcePath", () => {
  it("accepts source files under src/, an extension's src/ and ui/src/", () => {
    expect(isScannedSourcePath("src/agents/run.ts")).toBe(true);
    expect(isScannedSourcePath("extensions/adminbot/src/api/server.ts")).toBe(true);
    expect(isScannedSourcePath("ui/src/ui/app.ts")).toBe(true);
  });

  it("rejects tests, non-source files and paths outside scope", () => {
    expect(isScannedSourcePath("src/agents/run.test.ts")).toBe(false);
    expect(isScannedSourcePath("src/agents/run.e2e.test.ts")).toBe(false);
    expect(isScannedSourcePath("extensions/adminbot/src/data.json")).toBe(false);
    expect(isScannedSourcePath("scripts/check.mjs")).toBe(false);
  });
});

describe("countLines", () => {
  it("does not count a trailing newline as a line", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(2);
  });
});

describe("evaluateFileSizes", () => {
  it("passes files at or under the limit", () => {
    const result = evaluateFileSizes(new Map([["src/a.ts", 3]]), createConfig());
    expect(result).toEqual({ failures: [], warnings: [] });
  });

  it("fails a new oversize file", () => {
    const { failures } = evaluateFileSizes(new Map([["src/a.ts", 4]]), createConfig());
    expect(failures.map((failure) => failure.file)).toEqual(["src/a.ts"]);
  });

  it("holds a grandfathered file at its max and fails growth", () => {
    const config = createConfig({ "src/a.ts": { max: 10, reason: "legacy" } });
    expect(evaluateFileSizes(new Map([["src/a.ts", 10]]), config).failures).toEqual([]);
    expect(evaluateFileSizes(new Map([["src/a.ts", 11]]), config).failures).toHaveLength(1);
  });

  it("warns to tighten on shrink and to prune when under the limit or deleted", () => {
    const config = createConfig({
      "src/a.ts": { max: 10, reason: "legacy" },
      "src/b.ts": { max: 10, reason: "legacy" },
      "src/c.ts": { max: 10, reason: "legacy" },
    });
    const { failures, warnings } = evaluateFileSizes(
      new Map([
        ["src/a.ts", 8],
        ["src/b.ts", 2],
      ]),
      config,
    );
    expect(failures).toEqual([]);
    expect(warnings.map((warning) => warning.file)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(warnings[0].detail).toContain("tighten");
    expect(warnings[1].detail).toContain("prune");
    expect(warnings[2].detail).toContain("no longer exists");
  });
});

describe("parseFileSizeConfig", () => {
  it("rejects entries without a reason", () => {
    expect(() =>
      parseFileSizeConfig(JSON.stringify({ limit: 3, grandfathered: { "src/a.ts": { max: 4 } } })),
    ).toThrow(/reason/);
  });

  it("accepts the committed config", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(
      new URL("../../config/file-size-grandfather.json", import.meta.url),
      "utf8",
    );
    expect(parseFileSizeConfig(raw).limit).toBe(2200);
  });
});

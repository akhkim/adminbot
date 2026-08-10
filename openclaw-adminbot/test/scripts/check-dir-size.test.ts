// Directory size check tests cover scope selection, counting and the grandfather ratchet.
import { describe, expect, it } from "vitest";
import {
  countDirectFiles,
  evaluateDirSizes,
  isScannedRepoPath,
  parseDirSizeConfig,
} from "../../scripts/check-dir-size.mjs";

function createConfig(grandfathered: Record<string, { max: number; reason: string }> = {}) {
  return { limit: 3, grandfathered };
}

function repeatPaths(dir: string, count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${dir}/file${index}.ts`);
}

describe("isScannedRepoPath", () => {
  it("accepts src/ and an extension's own src/", () => {
    expect(isScannedRepoPath("src/agents/run.ts")).toBe(true);
    expect(isScannedRepoPath("extensions/slack/src/monitor/index.ts")).toBe(true);
  });

  it("rejects paths outside scope and test files", () => {
    expect(isScannedRepoPath("scripts/check.mjs")).toBe(false);
    expect(isScannedRepoPath("extensions/slack/package.json")).toBe(false);
    expect(isScannedRepoPath("src/agents/run.test.ts")).toBe(false);
    expect(isScannedRepoPath("src/agents/run.e2e.test.ts")).toBe(false);
  });
});

describe("countDirectFiles", () => {
  it("counts files by their own directory, not by subtree", () => {
    const counts = countDirectFiles([
      "src/agents/run.ts",
      "src/agents/model.ts",
      "src/agents/tools/bash.ts",
      "src/agents/run.test.ts",
      "scripts/check.mjs",
    ]);

    expect(counts.get("src/agents")).toBe(2);
    expect(counts.get("src/agents/tools")).toBe(1);
    expect(counts.has("scripts")).toBe(false);
  });
});

describe("evaluateDirSizes", () => {
  it("passes a directory at the limit", () => {
    const result = evaluateDirSizes(countDirectFiles(repeatPaths("src/agents", 3)), createConfig());

    expect(result.failures).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([]);
  });

  it("fails an ungrandfathered directory over the limit", () => {
    const result = evaluateDirSizes(countDirectFiles(repeatPaths("src/agents", 4)), createConfig());

    expect(result.failures.map((finding) => finding.dir)).toStrictEqual(["src/agents"]);
  });

  it("passes a grandfathered directory sitting at its recorded max", () => {
    const result = evaluateDirSizes(
      countDirectFiles(repeatPaths("src/agents", 5)),
      createConfig({ "src/agents": { max: 5, reason: "ADR-0004" } }),
    );

    expect(result.failures).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([]);
  });

  it("fails a grandfathered directory that grew past its recorded max", () => {
    const result = evaluateDirSizes(
      countDirectFiles(repeatPaths("src/agents", 6)),
      createConfig({ "src/agents": { max: 5, reason: "ADR-0004" } }),
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.detail).toMatch(/grew to 6 .*grandfathered at 5/);
  });

  it("warns so the max can be tightened after a directory shrinks", () => {
    const result = evaluateDirSizes(
      countDirectFiles(repeatPaths("src/agents", 4)),
      createConfig({ "src/agents": { max: 5, reason: "ADR-0004" } }),
    );

    expect(result.failures).toStrictEqual([]);
    expect(result.warnings[0]?.detail).toMatch(/down to 4 from the grandfathered 5/);
  });

  it("warns that an entry is prunable once the directory reaches the limit", () => {
    const result = evaluateDirSizes(
      countDirectFiles(repeatPaths("src/agents", 2)),
      createConfig({ "src/agents": { max: 5, reason: "ADR-0004" } }),
    );

    expect(result.failures).toStrictEqual([]);
    expect(result.warnings[0]?.detail).toMatch(/prune it/);
  });
});

describe("parseDirSizeConfig", () => {
  it("rejects a missing limit", () => {
    expect(() => parseDirSizeConfig(JSON.stringify({ grandfathered: {} }))).toThrow(
      /positive integer limit/,
    );
  });

  it("rejects a grandfather entry without a reason", () => {
    const raw = JSON.stringify({ limit: 80, grandfathered: { "src/agents": { max: 5 } } });

    expect(() => parseDirSizeConfig(raw)).toThrow(/must declare a reason/);
  });
});

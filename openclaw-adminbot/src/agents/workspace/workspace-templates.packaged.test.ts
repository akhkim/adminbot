import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every template the seeder loads has to be tracked by git, not merely present
 * on disk.
 *
 * Aurora deploys with `git archive`, which ships tracked files only. Two of
 * these templates matched an unanchored `IDENTITY.md` / `USER.md` rule meant for
 * a workspace's personal files, so `git add -A` skipped them in silence: they
 * existed locally, the loader resolved them, the suite passed, and the release
 * still died on "Missing workspace template". Checking the filesystem cannot
 * catch that; asking git can.
 */

// Mirrors the unconditional loads in seedWorkspaceFiles, plus the bootstrap file
// the not-yet-configured branch reaches for.
const REQUIRED_TEMPLATES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
] as const;

const TEMPLATE_DIR = "src/agents/templates";

describe("workspace templates", () => {
  it("ships every template the seeder loads", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const tracked = new Set(
      execFileSync("git", ["ls-files", TEMPLATE_DIR], { cwd: repoRoot, encoding: "utf8" })
        .split("\n")
        .filter(Boolean)
        .map((file) => path.posix.basename(file)),
    );

    expect([...REQUIRED_TEMPLATES].filter((name) => !tracked.has(name))).toEqual([]);
  });
});

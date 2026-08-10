#!/usr/bin/env node
// Lints the staged source files for the pre-commit hook.
//
// Goes through scripts/run-oxlint.mjs with explicit file arguments, which is
// the same entrypoint the shard runner spawns — so the hook and `pnpm lint`
// apply the same policy (type-aware, unused-disable-directives) and the same
// config. The wrapper supplies `config/tsconfig/oxlint.json`, which spans every
// linted root, so one invocation covers a staged set that mixes src/,
// extensions/, ui/ and scripts/.
//
// Deliberately narrow: no tsgo, no vitest. Those OOM this box, and a hook that
// takes minutes is a hook people disable.
//
// Usage: node scripts/pre-commit/lint-staged-files.mjs -- <files...>
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rawArgs = process.argv.slice(2);
const files = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

// Option-injection guard: a path starting with "-" would be read as a flag.
const targets = files.filter((file) => file.length > 0 && !file.startsWith("-"));

if (targets.length === 0) {
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [path.join(repoRoot, "scripts", "run-oxlint.mjs"), "--", ...targets],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      // The hook must stay fast. The heavy-check lock exists to keep full lint
      // sweeps from fighting each other; a handful of files is not that, and
      // waiting out a stale lock would add 30s to every commit.
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
    },
  },
);

if (result.error) {
  console.error(`pre-commit: could not run oxlint: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error("");
  console.error(`pre-commit: oxlint failed on ${targets.length} staged file(s). Commit blocked.`);
  console.error("  Fix the errors above, or try `pnpm lint:fix` for the mechanical ones.");
  console.error("");
  console.error("  Note: this repo has a known-red lint baseline (270 errors across 59 files,");
  console.error("  see docs/refactor-baseline.md). If every error above is pre-existing and");
  console.error("  your change did not add to it, `git commit --no-verify` is the escape.");
  process.exit(result.status ?? 1);
}

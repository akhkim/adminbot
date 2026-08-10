// Runs the changed-file check lanes selected by `scripts/changed-lanes.mjs`.
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  detectChangedLanesForPaths,
  listChangedPathsFromGit,
  listStagedChangedPaths,
  normalizeChangedPath,
} from "./changed-lanes.mjs";
import { shrinkwrapPackageDirsForChangedPaths } from "./generate-npm-shrinkwrap.mjs";
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mjs";
import { printTimingSummary } from "./lib/check-timing-summary.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  acquireLocalHeavyCheckLockSync,
  resolveLocalHeavyCheckEnv,
} from "./lib/local-heavy-check-runtime.mjs";
import { runManagedCommand } from "./lib/managed-child-process.mjs";
import { createSparseTsgoSkipEnv } from "./lib/tsgo-sparse-guard.mjs";

const SHRINKWRAP_POLICY_PATH_RE =
  /^(?:npm-shrinkwrap\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|scripts\/generate-npm-shrinkwrap\.mjs|extensions\/[^/]+\/(?:package\.json|npm-shrinkwrap\.json))$/u;
const CORE_OXLINT_TS_CONFIG = "config/tsconfig/oxlint.core.json";
const TARGETED_CORE_LINT_PATH_LIMIT = 8;
const LINTABLE_CORE_PATH_RE = /^(?:src|ui|packages)\/.+\.[cm]?[jt]sx?$/u;
const CORE_LINT_OPTIMIZATION_NEUTRAL_PATH_RE =
  /^(?:scripts|test\/scripts)\/|^\.github\/workflows\/ci\.yml$/u;
// Lanes whose baseline is already red on this branch (see docs/refactor-baseline.md).
// This runner has no baseline-diffing machinery, so a failure in one of these
// warns and the run continues; only a clean lane can fail the gate. Drop a name
// from this set as soon as its baseline reaches zero.
const KNOWN_RED_LANE_NAMES = new Set([
  "lint",
  "lint core",
  "lint core changed file",
  "lint core changed files",
  "lint extensions",
  "lint scripts",
  "typecheck core",
  "typecheck core tests",
  "typecheck extension tests",
]);

export function isKnownRedLane(name) {
  return KNOWN_RED_LANE_NAMES.has(name);
}

let corepackPnpmShimDir;
let corepackPnpmShimCleanupRegistered = false;

export function createChangedCheckChildEnv(baseEnv = process.env) {
  const resolvedBaseEnv = resolveLocalHeavyCheckEnv(baseEnv);
  return {
    ...resolvedBaseEnv,
    OPENCLAW_OXLINT_SKIP_LOCK: "1",
    OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
    OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
  };
}

function isTruthyEnvFlag(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function shouldRunShrinkwrapGuard(paths) {
  return paths.some((changedPath) => SHRINKWRAP_POLICY_PATH_RE.test(changedPath));
}

export function createShrinkwrapGuardCommand(paths) {
  if (!shouldRunShrinkwrapGuard(paths)) {
    return null;
  }
  const packageDirs = shrinkwrapPackageDirsForChangedPaths(paths);
  if (packageDirs.length === 0) {
    return null;
  }
  return {
    name:
      packageDirs.length === 1
        ? "npm shrinkwrap guard"
        : `npm shrinkwrap guard (${packageDirs.length} packages)`,
    bin: "node",
    args: [
      "scripts/generate-npm-shrinkwrap.mjs",
      "--check",
      ...packageDirs.flatMap((packageDir) => ["--package-dir", packageDir]),
    ],
  };
}

export function createChangedCheckPlan(result, options = {}) {
  const commands = [];
  const baseEnv = createChangedCheckChildEnv(options.env ?? process.env);
  const add = (name, args, env) => {
    if (!commands.some((command) => command.name === name && sameArgs(command.args, args))) {
      commands.push({ name, args, ...(env ? { env } : {}) });
    }
  };
  const addCommand = (name, bin, args, env) => {
    if (
      !commands.some(
        (command) => command.name === name && command.bin === bin && sameArgs(command.args, args),
      )
    ) {
      commands.push({ name, bin, args, ...(env ? { env } : {}) });
    }
  };
  const addTypecheck = (name, args) => add(name, args, createSparseTsgoSkipEnv(baseEnv));
  const addLint = (name, args) => add(name, args, baseEnv);
  const shrinkwrapGuardCommand = createShrinkwrapGuardCommand(result.paths);
  if (shrinkwrapGuardCommand) {
    addCommand(
      shrinkwrapGuardCommand.name,
      shrinkwrapGuardCommand.bin,
      shrinkwrapGuardCommand.args,
      baseEnv,
    );
  }

  if (result.docsOnly) {
    return {
      commands,
      summary: "docs-only",
    };
  }

  const lanes = result.lanes;

  if (lanes.all) {
    addTypecheck("typecheck core", ["tsgo:core"]);
    addTypecheck("typecheck extensions", ["tsgo:extensions"]);
    addLint("lint", ["lint"]);
    add("runtime import cycles", ["check:import-cycles"]);
    return {
      commands,
      summary: "all",
    };
  }

  if (lanes.core) {
    addTypecheck("typecheck core", ["tsgo:core"]);
  }
  if (lanes.coreTests) {
    addTypecheck("typecheck core tests", ["tsgo:core:test"]);
  }
  if (lanes.extensions) {
    addTypecheck("typecheck extensions", ["tsgo:extensions"]);
  }
  if (lanes.extensionTests) {
    addTypecheck("typecheck extension tests", ["tsgo:extensions:test"]);
  }

  // The lint shards are one runner with a --only flag rather than separate
  // package scripts, so each lane names its shard instead of a lint:<lane> script.
  if (lanes.core || lanes.coreTests) {
    const coreLintCommand = createTargetedCoreLintCommand(result.paths, baseEnv);
    if (coreLintCommand) {
      addCommand(
        coreLintCommand.name,
        coreLintCommand.bin,
        coreLintCommand.args,
        coreLintCommand.env,
      );
    } else {
      addCommand("lint core", "node", ["scripts/run-oxlint-shards.mjs", "--only", "core"], baseEnv);
    }
  }
  if (lanes.extensions || lanes.extensionTests) {
    addCommand(
      "lint extensions",
      "node",
      ["scripts/run-oxlint-shards.mjs", "--only", "extensions"],
      baseEnv,
    );
  }
  if (lanes.tooling) {
    addCommand(
      "lint scripts",
      "node",
      ["scripts/run-oxlint-shards.mjs", "--only", "scripts"],
      baseEnv,
    );
  }

  if (lanes.core || lanes.extensions) {
    add("runtime import cycles", ["check:import-cycles"]);
  }

  return {
    commands,
    summary: Object.entries(lanes)
      .filter(([, enabled]) => enabled)
      .map(([lane]) => lane)
      .join(", "),
  };
}

export function createTargetedCoreLintCommand(paths, env = process.env, options = {}) {
  if (
    paths.some(
      (changedPath) =>
        !LINTABLE_CORE_PATH_RE.test(changedPath) &&
        !CORE_LINT_OPTIMIZATION_NEUTRAL_PATH_RE.test(changedPath),
    )
  ) {
    return null;
  }
  const targets = paths
    .filter((changedPath) => LINTABLE_CORE_PATH_RE.test(changedPath))
    .toSorted((left, right) => left.localeCompare(right));
  if (targets.length === 0 || targets.length > TARGETED_CORE_LINT_PATH_LIMIT) {
    return null;
  }
  const fileExists = options.fileExists ?? existsSync;
  if (!targets.every((target) => fileExists(target))) {
    return null;
  }
  return {
    name: targets.length === 1 ? "lint core changed file" : "lint core changed files",
    bin: "node",
    args: ["scripts/run-oxlint.mjs", "--tsconfig", CORE_OXLINT_TS_CONFIG, ...targets],
    env,
  };
}

export async function runChangedCheck(result, options = {}) {
  const baseEnv = resolveLocalHeavyCheckEnv(options.env ?? process.env);
  const childEnv = createChangedCheckChildEnv(baseEnv);
  const plan = createChangedCheckPlan(result, {
    ...options,
    env: childEnv,
  });
  const releaseLock = options.dryRun
    ? () => {}
    : acquireLocalHeavyCheckLockSync({
        cwd: process.cwd(),
        env: baseEnv,
        toolName: "check:changed",
      });

  try {
    printPlan(result, plan, options);

    if (options.dryRun) {
      return 0;
    }

    const timings = [];
    const softFailures = [];
    for (const command of plan.commands) {
      const status = await runPlanCommand(command, timings);
      if (status === 0) {
        continue;
      }
      if (isKnownRedLane(command.name)) {
        softFailures.push(command.name);
        console.error(
          `[check:changed] WARNING: ${command.name} failed (exit ${status}). ` +
            "This lane has a known-red baseline; compare against docs/refactor-baseline.md.",
        );
        continue;
      }
      printSummary(timings, options);
      return status;
    }

    if (softFailures.length > 0) {
      console.error(`\n[check:changed] known-red lanes that failed: ${softFailures.join(", ")}`);
    }
    printSummary(timings, options);
    return 0;
  } finally {
    releaseLock();
  }
}

function sameArgs(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function printPlan(result, plan, options) {
  const prefix = options.dryRun ? "[check:changed:dry-run]" : "[check:changed]";
  console.error(`${prefix} lanes=${plan.summary || "none"}`);
  if (result.extensionImpactFromCore) {
    console.error(`${prefix} extension-impacting surface; extension typecheck included`);
  }
  for (const reason of result.reasons) {
    console.error(`${prefix} ${reason}`);
  }
}

async function runPnpm(command, timings) {
  return await runCommand(createPnpmManagedCommand(command), timings);
}

async function runPlanCommand(command, timings) {
  if (command.bin) {
    return await runCommand(command, timings);
  }
  return await runPnpm(command, timings);
}

export function createPnpmManagedCommand(command, env = process.env) {
  const commandEnv = command.env ?? resolveLocalHeavyCheckEnv(env);
  if (isTruthyEnvFlag(commandEnv.CI) || isTruthyEnvFlag(commandEnv.GITHUB_ACTIONS)) {
    const shimmedEnv = prependCorepackPnpmShim(commandEnv);
    return {
      ...command,
      bin: "corepack",
      args: ["pnpm", ...command.args],
      env: shimmedEnv,
    };
  }
  return { ...command, bin: "pnpm", env: commandEnv };
}

function prependCorepackPnpmShim(env) {
  const shimDir = ensureCorepackPnpmShimDir();
  return {
    ...env,
    PATH: [shimDir, env.PATH ?? env.Path ?? ""].filter(Boolean).join(path.delimiter),
  };
}

function ensureCorepackPnpmShimDir() {
  if (corepackPnpmShimDir) {
    return corepackPnpmShimDir;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-corepack-pnpm-"));
  const pnpmPath = path.join(dir, "pnpm");
  writeFileSync(pnpmPath, '#!/bin/sh\nexec corepack pnpm "$@"\n', "utf8");
  chmodSync(pnpmPath, 0o755);
  writeFileSync(path.join(dir, "pnpm.cmd"), "@echo off\r\ncorepack pnpm %*\r\n", "utf8");
  corepackPnpmShimDir = dir;
  registerCorepackPnpmShimCleanup();
  return dir;
}

function registerCorepackPnpmShimCleanup() {
  if (corepackPnpmShimCleanupRegistered) {
    return;
  }
  corepackPnpmShimCleanupRegistered = true;
  process.once("exit", cleanupCorepackPnpmShimDir);
}

export function cleanupCorepackPnpmShimDir() {
  if (!corepackPnpmShimDir) {
    return;
  }
  const dir = corepackPnpmShimDir;
  corepackPnpmShimDir = undefined;
  rmSync(dir, { recursive: true, force: true });
}

async function runCommand(command, timings) {
  const startedAt = performance.now();
  console.error(`\n[check:changed] ${command.name}`);
  let status = 1;
  try {
    status = await runManagedCommand({
      bin: command.bin,
      args: command.args,
      env: command.env ?? resolveLocalHeavyCheckEnv(),
    });
  } catch (error) {
    console.error(error);
  }

  timings.push({
    name: command.name,
    durationMs: performance.now() - startedAt,
    status,
  });
  return status;
}

function printSummary(timings, options) {
  printTimingSummary("check:changed", timings, { skipWhenAllOk: !options.timed });
}

function parseArgs(argv) {
  const args = {
    base: "origin/main",
    head: "HEAD",
    staged: false,
    dryRun: false,
    timed: false,
    noChanges: false,
    help: false,
    paths: [],
  };
  return parseFlagArgs(
    argv,
    args,
    [
      stringFlag("--base", "base"),
      stringFlag("--head", "head"),
      booleanFlag("--staged", "staged"),
      booleanFlag("--dry-run", "dryRun"),
      booleanFlag("--timed", "timed"),
      booleanFlag("--no-changes", "noChanges"),
      booleanFlag("--help", "help"),
      booleanFlag("-h", "help"),
    ],
    {
      onUnhandledArg(arg, target) {
        if (arg === "--") {
          return "handled";
        }
        target.paths.push(normalizeChangedPath(arg));
        return "handled";
      },
    },
  );
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: node scripts/check-changed.mjs [options] [-- <paths...>]",
      "",
      "Options:",
      "  --base <ref>     Base ref for changed paths (default: origin/main)",
      "  --head <ref>     Head ref for changed paths (default: HEAD)",
      "  --staged         Check staged paths instead of git diff paths",
      "  --dry-run        Print the planned checks without running them",
      "  --timed          Print timing summary",
      "  --no-changes     Treat the changed path set as empty",
      "  -h, --help       Show this help",
      "",
    ].join("\n"),
  );
}

function isDirectRun() {
  return isDirectRunUrl(process.argv[1], import.meta.url);
}

if (isDirectRun()) {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    process.exitCode = 0;
  } else {
    const paths = args.noChanges
      ? []
      : args.paths.length > 0
        ? args.paths
        : args.staged
          ? listStagedChangedPaths()
          : listChangedPathsFromGit({ base: args.base, head: args.head });
    const result = detectChangedLanesForPaths({
      paths,
      base: args.base,
      head: args.head,
      staged: args.staged,
    });
    process.exitCode = await runChangedCheck(result, {
      ...args,
      explicitPaths: args.paths.length > 0,
    });
  }
}

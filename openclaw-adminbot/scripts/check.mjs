// Runs the repository check lanes selected by CLI arguments.
//
// Every lane here must name a package script that still exists. The clean-down
// deleted the guard/architecture/release scripts this runner used to call, so
// the plan is deliberately small: format, lint, typecheck, dead files, import
// cycles, layering, directory size. Full builds and unscoped vitest sweeps are excluded on purpose —
// they OOM the dev box, and `pnpm test <path>` is the supported way to run
// tests.
//
// Some lanes have a documented known-red baseline (see docs/refactor-baseline.md).
// This runner has no baseline-diffing machinery, so those lanes are marked
// `soft`: a failure prints a warning and the run continues, and only a hard
// lane can set a non-zero exit code. Promote a lane back to hard the moment its
// baseline reaches zero.
import { performance } from "node:perf_hooks";
import { printTimingSummary } from "./lib/check-timing-summary.mjs";
import { runManagedCommand } from "./lib/managed-child-process.mjs";

/**
 * Returns command usage text for the aggregate check runner.
 */
export function usage() {
  return [
    "Usage: node scripts/check.mjs [--timed] [--include-architecture] [--include-test-types]",
    "",
    "Runs the local check graph: format, lint, typecheck, dead files, import cycles,",
    "layering and directory size.",
    "",
    "Options:",
    "  --timed                 Print timing summary even when checks pass.",
    "  --include-architecture  Run the architecture lane (import cycles, layering, directory",
    "                          size); already in the default plan, so this flag is kept only",
    "                          for compatibility.",
    "  --include-test-types    Also typecheck test sources (tsgo:core:test, tsgo:extensions:test).",
    "  -h, --help              Show this help.",
    "",
    "Lanes with a known-red baseline (format:check, lint, tsgo:core, and the",
    "test-type lanes) warn instead of failing the run.",
  ].join("\n");
}

/**
 * Parses aggregate check runner arguments.
 */
export function parseCheckArgs(argv) {
  const args = {
    help: false,
    includeArchitecture: false,
    includeTestTypes: false,
    timed: false,
  };
  for (const arg of argv) {
    if (arg === "--timed") {
      args.timed = true;
    } else if (arg === "--include-architecture") {
      args.includeArchitecture = true;
    } else if (arg === "--include-test-types") {
      args.includeTestTypes = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  return args;
}

/**
 * Builds the ordered stage plan for the given parsed arguments.
 *
 * Exported so the plan can be inspected without spawning anything.
 */
export function buildCheckPlan(args) {
  const typecheckCommands = [
    { name: "typecheck core", args: ["tsgo:core"], soft: true },
    { name: "typecheck extensions", args: ["tsgo:extensions"] },
  ];
  if (args.includeTestTypes) {
    typecheckCommands.push(
      { name: "typecheck core tests", args: ["tsgo:core:test"], soft: true },
      { name: "typecheck extension tests", args: ["tsgo:extensions:test"], soft: true },
    );
  }

  return [
    {
      name: "format",
      parallel: false,
      commands: [{ name: "format", args: ["format:check"], soft: true }],
    },
    {
      name: "lint",
      parallel: false,
      commands: [{ name: "lint", args: ["lint"], soft: true }],
    },
    {
      name: "typecheck",
      parallel: false,
      commands: typecheckCommands,
    },
    {
      name: "policy guards",
      parallel: false,
      commands: [
        { name: "dead files", args: ["deadcode:unused-files"] },
        // `check:architecture` was deleted; import cycles, layering and directory
        // size are the architecture lane now, so --include-architecture selects
        // the same commands.
        { name: "runtime import cycles", args: ["check:import-cycles"] },
        // Hard lane: the frozen edge set was generated from this tree, so the
        // gate is green by construction and any failure is a real new edge.
        { name: "layering", args: ["check:layering"] },
        // Hard lane for the same reason: today's offenders are grandfathered
        // at their current counts, so only growth can fail it.
        { name: "directory size", args: ["check:dir-size"] },
      ],
    },
  ];
}

/**
 * Runs selected repository check lanes.
 */
export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseCheckArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(usage());
    process.exitCode = 0;
    return;
  }

  const stages = buildCheckPlan(args);
  const timings = [];
  const softFailures = [];
  let exitCode = 0;

  for (const stage of stages) {
    console.error(`\n[check] ${stage.name}`);
    const results = stage.parallel
      ? await Promise.all(stage.commands.map((command) => runCommand(command)))
      : await runSerial(stage.commands);

    timings.push(...results);
    for (const result of results) {
      if (result.status === 0) {
        continue;
      }
      if (result.soft) {
        softFailures.push(result.name);
        console.error(
          `[check] WARNING: ${result.name} failed (exit ${result.status}). ` +
            "This lane has a known-red baseline; compare against docs/refactor-baseline.md.",
        );
        continue;
      }
      exitCode = result.status;
    }
    if (exitCode !== 0) {
      break;
    }
  }

  if (softFailures.length > 0) {
    console.error(`\n[check] known-red lanes that failed: ${softFailures.join(", ")}`);
  }
  if (args.timed || exitCode !== 0) {
    printSummary(timings);
  }

  process.exitCode = exitCode;
}

async function runSerial(commands) {
  const results = [];
  for (const command of commands) {
    const result = await runCommand(command);
    results.push(result);
    if (result.status !== 0 && !command.soft) {
      break;
    }
  }
  return results;
}

/**
 * Runs one managed check command and returns timing/status details.
 */
export async function runCommand(command, runManagedCommandImpl = runManagedCommand) {
  const startedAt = performance.now();
  let status = 1;
  try {
    status = await runManagedCommandImpl({
      args: command.args,
      bin: "pnpm",
    });
  } catch (error) {
    console.error(error);
  }
  return {
    name: command.name,
    durationMs: performance.now() - startedAt,
    soft: command.soft === true,
    status,
  };
}

function printSummary(timings) {
  printTimingSummary("check", timings);
}

if (import.meta.main) {
  await main();
}

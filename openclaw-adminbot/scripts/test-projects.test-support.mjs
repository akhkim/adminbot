// Test-project planning helpers used by scripts/run-vitest.mjs,
// scripts/test-projects.mjs, and focused tests. Exports are intentionally
// granular so project selection stays testable without spawning Vitest.
//
// The suite is two Vitest lanes: a node lane for src/, extensions/, packages/
// and test/scripts, and a jsdom lane for the Control UI. There is no routing
// matrix left to maintain - a target only has to pick its environment, and the
// lane narrows its include patterns from the CLI argument so a scoped run does
// not load the rest of the suite.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectChangedLanes,
  listChangedPathsFromGit as listChangedPathsFromGitSource,
} from "./changed-lanes.mjs";
import { isCiLikeEnv, resolveLocalFullSuiteProfile } from "./lib/vitest-local-scheduling.mjs";
import {
  DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS,
  resolveVitestCliEntry,
  resolveVitestNodeArgs,
} from "./run-vitest.mjs";

const ROOT_VITEST_CONFIG = "vitest.config.ts";
const NODE_VITEST_CONFIG = "test/vitest/vitest.node.config.ts";
const UI_VITEST_CONFIG = "test/vitest/vitest.ui.config.ts";
const DEFAULT_VITEST_CONFIG = NODE_VITEST_CONFIG;
const VITEST_CONFIG_BY_KIND = {
  node: NODE_VITEST_CONFIG,
  ui: UI_VITEST_CONFIG,
};
const VITEST_CONFIG_TARGET_KIND_BY_PATH = new Map(
  Object.entries(VITEST_CONFIG_BY_KIND).map(([kind, config]) => [config, kind]),
);
const RUNNABLE_VITEST_CONFIG_TARGETS = new Set([
  ROOT_VITEST_CONFIG,
  ...Object.values(VITEST_CONFIG_BY_KIND),
]);
const INCLUDE_FILE_ENV_KEY = "OPENCLAW_VITEST_INCLUDE_FILE";
const FS_MODULE_CACHE_PATH_ENV_KEY = "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH";
const FAILED_SHARD_DIGEST_LIMIT = 12;
const CHANGED_ARGS_PATTERN = /^--changed(?:=(.+))?$/u;

function uniqueOrdered(values) {
  return [...new Set(values)];
}

function isPathAtOrUnder(relative, root) {
  return relative === root || relative.startsWith(`${root}/`);
}

function resolveConfigSortWeight(config, shardTimings) {
  return shardTimings.get(config) ?? 0;
}

function interleaveSlowAndFastSpecs(sortedSpecs) {
  const ordered = [];
  let slowIndex = 0;
  let fastIndex = sortedSpecs.length - 1;
  while (slowIndex <= fastIndex) {
    ordered.push(sortedSpecs[slowIndex]);
    slowIndex += 1;
    if (slowIndex <= fastIndex) {
      ordered.push(sortedSpecs[fastIndex]);
      fastIndex -= 1;
    }
  }
  return ordered;
}

/**
 * Orders full-suite specs so the slowest recorded lane starts first.
 */
export function orderFullSuiteSpecsForParallelRun(specs, shardTimings = new Map()) {
  const sortedSpecs = specs.toSorted((a, b) => {
    const weightDelta =
      resolveConfigSortWeight(b.config, shardTimings) -
      resolveConfigSortWeight(a.config, shardTimings);
    if (weightDelta !== 0) {
      return weightDelta;
    }
    return a.config.localeCompare(b.config);
  });
  return interleaveSlowAndFastSpecs(sortedSpecs);
}

const BROAD_CHANGED_FALLBACK_PATTERNS = [
  /^package\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^test\/setup(?:\.shared|\.extensions|-openclaw-runtime)?\.ts$/u,
  /^vitest(?:\..+)?\.(?:config\.ts|paths\.mjs)$/u,
  /^test\/vitest\/vitest\.(?:config|shared\.config|scoped-config|performance-config)\.ts$/u,
  /^test\/helpers\//u,
];

// Scripts whose owning test does not follow the scripts/<stem> ->
// test/scripts/<stem>.test.ts convention that resolveConventionalToolingTestTargets
// covers.
const TOOLING_SOURCE_TEST_TARGETS = new Map([
  ["scripts/run-node.mjs", ["src/infra/run-node.test.ts"]],
]);

const CHANNEL_CONTRACT_REGISTRY_BACKED_TARGETS = [
  "directory",
  "plugin",
  "surfaces-only",
  "threading",
].flatMap((suite) =>
  "abcdefgh"
    .split("")
    .map(
      (shard) =>
        `src/channels/plugins/contracts/${suite}.registry-backed-shard-${shard}.contract.test.ts`,
    ),
);
const GROUP_VISIBLE_REPLY_TEST_TARGETS = [
  "src/auto-reply/reply/dispatch/dispatch-acp.test.ts",
  "src/auto-reply/reply/dispatch/dispatch-from-config.test.ts",
  "src/auto-reply/reply/queue/followup-runner.test.ts",
  "src/auto-reply/reply/groups.test.ts",
  "extensions/slack/src/monitor.tool-result.test.ts",
];
const GROUP_VISIBLE_REPLY_PROMPT_TEST_TARGETS = [
  "src/agents/prompt/system-prompt.test.ts",
  ...GROUP_VISIBLE_REPLY_TEST_TARGETS,
];
// Source files whose blast radius the import graph cannot see, or sees too
// slowly to be worth walking.
const SOURCE_TEST_TARGETS = new Map([
  ["src/test-utils/openclaw-test-state.ts", ["src/test-utils/openclaw-test-state.test.ts"]],
  [
    "src/channels/plugins/contracts/test-helpers/manifest.ts",
    [
      ...CHANNEL_CONTRACT_REGISTRY_BACKED_TARGETS,
      "src/channels/plugins/contracts/registry.contract.test.ts",
      "src/channels/plugins/contracts/session-binding.registry-backed.contract.test.ts",
    ],
  ],
  [
    "test/helpers/normalize-text.ts",
    ["src/auto-reply/reply/commands/commands-status.test.ts", "src/auto-reply/status.test.ts"],
  ],
  ["ui/config/control-ui-chunking.ts", ["ui/src/ui/control-ui-chunking.test.ts"]],
  [
    "src/plugin-sdk/test-helpers/directory-ids.ts",
    ["extensions/slack/src/directory-contract.test.ts"],
  ],
  [
    "src/plugin-sdk/channel-reply-pipeline.ts",
    ["src/plugins/contracts/plugin-sdk-subpaths.test.ts", ...GROUP_VISIBLE_REPLY_TEST_TARGETS],
  ],
  ["src/plugin-sdk/reply-runtime.ts", ["src/plugins/contracts/plugin-sdk-subpaths.test.ts"]],
  [
    "src/commands/doctor/doctor-memory-search.ts",
    ["src/commands/doctor/doctor-memory-search.test.ts"],
  ],
  [
    "src/commitments/model-selection.runtime.ts",
    ["src/commitments/runtime.test.ts", "src/agents/models/model-selection.test.ts"],
  ],
  [
    "src/agents/models/live-model-turn-probes.ts",
    ["src/agents/models/live-model-turn-probes.test.ts"],
  ],
  [
    "src/plugins/providers/provider-auth-choice.ts",
    [
      "src/commands/auth/auth-choice.apply.plugin-provider.test.ts",
      "src/commands/auth/auth-choice.test.ts",
    ],
  ],
  [
    "src/secrets/provider-env-vars.ts",
    ["src/secrets/provider-env-vars.dynamic.test.ts", "src/secrets/provider-env-vars.test.ts"],
  ],
  ["src/auto-reply/reply/dispatch/dispatch-from-config.ts", GROUP_VISIBLE_REPLY_TEST_TARGETS],
  ["src/auto-reply/reply/source-reply-delivery-mode.ts", GROUP_VISIBLE_REPLY_TEST_TARGETS],
  [
    "src/auto-reply/reply/effective-reply-route.ts",
    [
      "src/auto-reply/reply/effective-reply-route.test.ts",
      "src/auto-reply/reply/dispatch/dispatch-from-config.test.ts",
    ],
  ],
  [
    "src/auto-reply/reply/get-reply/get-reply-run.ts",
    ["src/auto-reply/reply/queue/followup-runner.test.ts"],
  ],
  ["src/auto-reply/reply/groups.ts", GROUP_VISIBLE_REPLY_TEST_TARGETS],
  ["src/auto-reply/get-reply-options.types.ts", GROUP_VISIBLE_REPLY_TEST_TARGETS],
  ["src/agents/prompt/system-prompt.ts", GROUP_VISIBLE_REPLY_PROMPT_TEST_TARGETS],
  ["src/config/types/messages.ts", GROUP_VISIBLE_REPLY_TEST_TARGETS],
  ["src/config/zod/core.ts", GROUP_VISIBLE_REPLY_TEST_TARGETS],
  [
    "src/auto-reply/reply/commands/commands-acp.ts",
    ["src/auto-reply/reply/commands/commands-acp.test.ts"],
  ],
  [
    "src/auto-reply/reply/dispatch/dispatch-acp-command-bypass.ts",
    ["src/auto-reply/reply/dispatch/dispatch-acp-command-bypass.test.ts"],
  ],
]);

const GENERATED_CHANGED_TEST_TARGET_PATTERNS = [
  /^extensions\/[^/]+\/src\/host\/.+\/\.bundle\.hash$/u,
  /^extensions\/[^/]+\/src\/host\/.+\/[^/]+\.bundle\.js$/u,
];
const SOURCE_ROOTS_FOR_IMPORT_GRAPH = [
  "src",
  "extensions",
  "packages",
  "ui/src",
  "ui/config",
  "test",
];
const IMPORTABLE_FILE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const IMPORT_GRAPH_GREP_PATHS = SOURCE_ROOTS_FOR_IMPORT_GRAPH.flatMap((root) =>
  IMPORTABLE_FILE_EXTENSIONS.map((ext) => `:(glob)${root}/**/*${ext}`),
);
const IMPORT_SPECIFIER_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
const BROAD_CHANGED_ENV_KEY = "OPENCLAW_TEST_CHANGED_BROAD";
const VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS";
const VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS";
const VITEST_NO_OUTPUT_RETRY_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_RETRY";
/** Default no-output timeout applied to test-projects Vitest children. */
export const DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS = String(900_000);
/** Default heartbeat interval applied to test-projects Vitest children. */
export const DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_HEARTBEAT_MS = String(
  DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS,
);
const EXPLICIT_SOURCE_FULL_IMPORT_GRAPH_THRESHOLD = 12;

function normalizePathPattern(value) {
  return value.replaceAll("\\", "/");
}

function isExistingPathTarget(arg, cwd) {
  return fs.existsSync(path.resolve(cwd, arg));
}

function isExistingFileTarget(arg, cwd) {
  try {
    return fs.statSync(path.resolve(cwd, arg)).isFile();
  } catch {
    return false;
  }
}

function isGlobTarget(arg) {
  return /[*?[\]{}]/u.test(arg);
}

function isFileLikeTarget(arg) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(arg);
}

function isTestFileTarget(arg) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(arg);
}

function isTestSupportFileTarget(arg) {
  if (/(?:^|\/)(?:test-helpers|test-support)(?:\/|$)/u.test(arg)) {
    return true;
  }
  const basename = path.posix.basename(arg).replace(/\.[cm]?[jt]sx?$/u, "");
  return /(?:^|[._-])test-(?:helpers|support)(?:[._-]|$)/u.test(basename);
}

function isLikelyFileTarget(arg) {
  return /(?:^|\/)[^/]+\.[A-Za-z0-9]+$/u.test(arg);
}

function isPathLikeTargetArg(arg, cwd) {
  if (!arg || arg === "--" || arg.startsWith("-")) {
    return false;
  }
  const relative = toRepoRelativeTarget(arg, cwd);
  return (
    isGlobTarget(arg) ||
    isFileLikeTarget(arg) ||
    isVitestConfigPathLikeTarget(relative) ||
    isExistingPathTarget(arg, cwd)
  );
}

function toRepoRelativeTarget(arg, cwd) {
  if (isGlobTarget(arg)) {
    return normalizePathPattern(arg.replace(/^\.\//u, ""));
  }
  const absolute = path.resolve(cwd, arg);
  return normalizePathPattern(path.relative(cwd, absolute));
}

function toScopedIncludePattern(arg, cwd) {
  const relative = toRepoRelativeTarget(arg, cwd);
  if (isGlobTarget(relative) || isFileLikeTarget(relative)) {
    return relative;
  }
  if (isExistingFileTarget(arg, cwd) || isLikelyFileTarget(relative)) {
    const directory = normalizePathPattern(path.posix.dirname(relative));
    return directory === "." ? "**/*.test.ts" : `${directory}/**/*.test.ts`;
  }
  return `${relative.replace(/\/+$/u, "")}/**/*.test.ts`;
}

const EXPLICIT_TEST_TARGET_ROOTS = ["src", "test", "extensions", "ui", "packages", "apps"];
let cachedExplicitTestTargetFiles = null;
let cachedExplicitTestTargetFilesCwd = null;

function listExplicitTestTargetFilesFromGit(cwd) {
  const result = spawnSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...EXPLICIT_TEST_TARGET_ROOTS,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\0")
    .map((line) => normalizePathPattern(line.trim()))
    .filter((line) => line.length > 0 && isImportableGraphFile(line));
}

function listExplicitTestTargetFilesForCwd(cwd) {
  if (cachedExplicitTestTargetFiles && cachedExplicitTestTargetFilesCwd === cwd) {
    return cachedExplicitTestTargetFiles;
  }

  cachedExplicitTestTargetFiles =
    listExplicitTestTargetFilesFromGit(cwd) ??
    EXPLICIT_TEST_TARGET_ROOTS.flatMap((root) => listImportGraphFiles(cwd, root));
  cachedExplicitTestTargetFilesCwd = cwd;
  return cachedExplicitTestTargetFiles;
}

function includePatternMatchesAnyFile(pattern, files) {
  return files.some((file) => file === pattern || path.matchesGlob(file, pattern));
}

function resolveExplicitSourceTestTargets(targetArg, cwd, options = {}) {
  const relative = toRepoRelativeTarget(targetArg, cwd);
  const kind = classifyTarget(targetArg, cwd);
  if (shouldUseWholeConfigTarget(kind, targetArg, cwd)) {
    return null;
  }
  if (!isExistingFileTarget(targetArg, cwd)) {
    return null;
  }
  if (isTestFileTarget(relative)) {
    return null;
  }
  const preciseTargets = resolvePreciseChangedTestTargets(relative, {
    cwd,
    forceFullImportGraph: options.forceFullImportGraph === true,
  });
  if (preciseTargets && preciseTargets.length > 0) {
    return [...new Set(preciseTargets)].toSorted((left, right) => left.localeCompare(right));
  }
  if (!isTestSupportFileTarget(relative)) {
    return null;
  }
  return [
    ...new Set(
      resolveAffectedTestsFromImportGraph(relative, cwd, {
        forceFull: options.forceFullImportGraph === true,
      }),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function expandExplicitSourceTestTargets(targetArgs, cwd) {
  const sourceTargetCount = targetArgs.filter((targetArg) => {
    const relative = toRepoRelativeTarget(targetArg, cwd);
    return isExistingFileTarget(targetArg, cwd) && !isTestFileTarget(relative);
  }).length;
  const forceFullImportGraph = sourceTargetCount > EXPLICIT_SOURCE_FULL_IMPORT_GRAPH_THRESHOLD;
  return targetArgs.flatMap((targetArg) => {
    const targets = resolveExplicitSourceTestTargets(targetArg, cwd, {
      forceFullImportGraph,
    });
    return targets && targets.length > 0 ? targets : [targetArg];
  });
}

/**
 * Finds explicit test path targets that do not match any known project plan.
 */
export function findUnmatchedExplicitTestTargets(args, cwd = process.cwd()) {
  const { targetArgs } = parseTestProjectsArgs(args, cwd);
  if (targetArgs.length === 0) {
    return [];
  }

  let candidateFiles = null;
  const getCandidateFiles = () => {
    candidateFiles ??= listExplicitTestTargetFilesForCwd(cwd);
    return candidateFiles;
  };
  const unmatched = [];
  for (const targetArg of targetArgs) {
    const relative = toRepoRelativeTarget(targetArg, cwd);
    if (
      resolveVitestConfigTargetKind(relative) ||
      (isVitestConfigFileTarget(relative) && isExistingFileTarget(targetArg, cwd))
    ) {
      continue;
    }
    const kind = classifyTarget(targetArg, cwd);
    if (shouldUseWholeConfigTarget(kind, targetArg, cwd)) {
      continue;
    }
    if (isGlobTarget(relative)) {
      if (!includePatternMatchesAnyFile(relative, getCandidateFiles())) {
        unmatched.push({
          target: targetArg,
          reason: "glob-matched-no-files",
        });
      }
      continue;
    }

    const absolute = path.resolve(cwd, targetArg);
    if (!fs.existsSync(absolute)) {
      unmatched.push({
        target: targetArg,
        reason: "path-does-not-exist",
      });
      continue;
    }

    if (isTestFileTarget(relative)) {
      continue;
    }

    const explicitSupportTargets = resolveExplicitSourceTestTargets(targetArg, cwd);
    if (explicitSupportTargets) {
      if (explicitSupportTargets.length === 0) {
        unmatched.push({
          target: targetArg,
          reason: "target-matched-no-test-files",
        });
      }
      continue;
    }

    const includePattern = toScopedIncludePattern(targetArg, cwd);
    if (!includePatternMatchesAnyFile(includePattern, getCandidateFiles())) {
      unmatched.push({
        target: targetArg,
        reason: "target-matched-no-test-files",
        includePattern,
      });
    }
  }
  return unmatched;
}

function isSkippedImportGraphDirectory(name) {
  return name === ".git" || name === "dist" || name === "node_modules" || name === "vendor";
}

function listImportGraphFiles(cwd, directory, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(cwd, directory), { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const relative = normalizePathPattern(path.posix.join(directory, entry.name));
    if (entry.isDirectory()) {
      if (!isSkippedImportGraphDirectory(entry.name)) {
        listImportGraphFiles(cwd, relative, files);
      }
      continue;
    }
    if (entry.isFile() && IMPORTABLE_FILE_EXTENSIONS.some((ext) => relative.endsWith(ext))) {
      files.push(relative);
    }
  }
  return files;
}

function resolveImportSpecifier(importer, specifier, fileSet) {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const importerDir = path.posix.dirname(importer);
  const base = normalizePathPattern(path.posix.normalize(path.posix.join(importerDir, specifier)));
  const candidates = [];
  const ext = path.posix.extname(base);
  if (ext) {
    candidates.push(base);
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      const withoutExt = base.slice(0, -ext.length);
      candidates.push(
        ...IMPORTABLE_FILE_EXTENSIONS.map((candidateExt) => `${withoutExt}${candidateExt}`),
      );
    }
  } else {
    candidates.push(
      ...IMPORTABLE_FILE_EXTENSIONS.map((candidateExt) => `${base}${candidateExt}`),
      ...IMPORTABLE_FILE_EXTENSIONS.map((candidateExt) => `${base}/index${candidateExt}`),
    );
  }

  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

let cachedImportGraph = null;
let cachedImportGraphCwd = null;
let cachedImportGraphFiles = null;
let cachedImportGraphFilesCwd = null;
const cachedImportGraphGrepMatches = new Map();
const cachedDirectImporters = new Map();

function isImportableGraphFile(relative) {
  return IMPORTABLE_FILE_EXTENSIONS.some((ext) => relative.endsWith(ext));
}

function listImportGraphFilesFromGit(cwd) {
  const result = spawnSync("git", ["ls-files", "--", ...SOURCE_ROOTS_FOR_IMPORT_GRAPH], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => normalizePathPattern(line.trim()))
    .filter((line) => line.length > 0 && isImportableGraphFile(line));
}

function listImportGraphFilesForCwd(cwd) {
  if (cachedImportGraphFiles && cachedImportGraphFilesCwd === cwd) {
    return cachedImportGraphFiles;
  }

  cachedImportGraphFiles =
    listImportGraphFilesFromGit(cwd) ??
    SOURCE_ROOTS_FOR_IMPORT_GRAPH.flatMap((root) => listImportGraphFiles(cwd, root));
  cachedImportGraphFilesCwd = cwd;
  return cachedImportGraphFiles;
}

function stripImportableGraphExtension(relative) {
  for (const ext of IMPORTABLE_FILE_EXTENSIONS) {
    if (relative.endsWith(ext)) {
      return relative.slice(0, -ext.length);
    }
  }
  return relative;
}

function resolveImportGraphSearchTerms(relative) {
  const withoutExtension = stripImportableGraphExtension(relative);
  const basename = path.posix.basename(stripImportableGraphExtension(relative));
  if (basename === "index" || basename.length < 3) {
    return [];
  }
  const terms = [];
  const segments = withoutExtension.split("/");
  if (segments.length > 1) {
    terms.push(segments.slice(-2).join("/"), withoutExtension);
  }
  if (relative.startsWith("test/helpers/")) {
    return [...new Set(terms)];
  }
  terms.push(basename);
  return [...new Set(terms)];
}

function listImportGraphGrepMatches(cwd, term) {
  const cacheKey = `${cwd}\0${term}`;
  if (cachedImportGraphGrepMatches.has(cacheKey)) {
    return cachedImportGraphGrepMatches.get(cacheKey);
  }

  const result = spawnSync(
    "git",
    ["grep", "-l", "--fixed-strings", term, "--", ...IMPORT_GRAPH_GREP_PATHS],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 1) {
    cachedImportGraphGrepMatches.set(cacheKey, []);
    return [];
  }
  if (result.status !== 0) {
    cachedImportGraphGrepMatches.set(cacheKey, null);
    return null;
  }
  const matches = result.stdout
    .split("\n")
    .map((line) => normalizePathPattern(line.trim()))
    .filter((line) => line.length > 0 && isImportableGraphFile(line));
  cachedImportGraphGrepMatches.set(cacheKey, matches);
  return matches;
}

function findDirectImportersWithGitGrep(cwd, importedFile, fileSet) {
  const cacheKey = `${cwd}\0${importedFile}`;
  if (cachedDirectImporters.has(cacheKey)) {
    return cachedDirectImporters.get(cacheKey);
  }

  const terms = resolveImportGraphSearchTerms(importedFile);
  if (terms.length === 0) {
    cachedDirectImporters.set(cacheKey, null);
    return null;
  }

  let skippedBroadTerm = false;
  const importers = [];
  for (const term of terms) {
    const candidates = listImportGraphGrepMatches(cwd, term);
    if (!candidates) {
      cachedDirectImporters.set(cacheKey, null);
      return null;
    }
    if (candidates.length > 800) {
      skippedBroadTerm = true;
      continue;
    }
    for (const file of candidates) {
      if (file === importedFile || !fileSet.has(file) || importers.includes(file)) {
        continue;
      }
      let source;
      try {
        source = fs.readFileSync(path.join(cwd, file), "utf8");
      } catch {
        continue;
      }
      for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
        const imported = resolveImportSpecifier(file, match[1] ?? match[2] ?? "", fileSet);
        if (imported === importedFile) {
          importers.push(file);
          break;
        }
      }
    }
    if (importedFile.startsWith("test/helpers/") && importers.length > 0 && term.includes("/")) {
      break;
    }
  }
  const result =
    skippedBroadTerm && importers.length === 0 && !importedFile.startsWith("test/helpers/")
      ? null
      : importers;
  cachedDirectImporters.set(cacheKey, result);
  return result;
}

function resolveAffectedTestsFromTargetedImportScan(changedPath, cwd) {
  const normalized = normalizePathPattern(changedPath);
  const files = listImportGraphFilesForCwd(cwd);
  const fileSet = new Set(files);
  if (!fileSet.has(normalized)) {
    return [];
  }

  const testFiles = new Set(
    files.filter((file) => isTestFileTarget(file) && !file.endsWith(".live.test.ts")),
  );
  const queue = [normalized];
  const seen = new Set(queue);
  const targets = [];

  for (const current of queue) {
    const importers = findDirectImportersWithGitGrep(cwd, current, fileSet);
    if (importers === null) {
      return null;
    }
    for (const importer of importers) {
      if (seen.has(importer)) {
        continue;
      }
      seen.add(importer);
      if (testFiles.has(importer)) {
        targets.push(importer);
        continue;
      }
      queue.push(importer);
    }
  }

  return [...new Set(targets)].toSorted((left, right) => left.localeCompare(right));
}

function getImportGraph(cwd) {
  if (cachedImportGraph && cachedImportGraphCwd === cwd) {
    return cachedImportGraph;
  }

  const files = listImportGraphFilesForCwd(cwd);
  const fileSet = new Set(files);
  const reverseImports = new Map();
  const testFiles = new Set(
    files.filter((file) => isTestFileTarget(file) && !file.endsWith(".live.test.ts")),
  );

  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(path.join(cwd, file), "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
      const imported = resolveImportSpecifier(file, match[1] ?? match[2] ?? "", fileSet);
      if (!imported) {
        continue;
      }
      const importers = reverseImports.get(imported) ?? [];
      importers.push(file);
      reverseImports.set(imported, importers);
    }
  }

  cachedImportGraph = { reverseImports, testFiles };
  cachedImportGraphCwd = cwd;
  return cachedImportGraph;
}

function resolveAffectedTestsFromImportGraph(changedPath, cwd, options = {}) {
  const normalized = normalizePathPattern(changedPath);
  if (options.forceFull !== true) {
    const targetedTargets = resolveAffectedTestsFromTargetedImportScan(normalized, cwd);
    if (targetedTargets !== null) {
      return targetedTargets;
    }
  }

  const { reverseImports, testFiles } = getImportGraph(cwd);
  const queue = [normalized];
  const seen = new Set(queue);
  const targets = [];

  for (const current of queue) {
    for (const importer of reverseImports.get(current) ?? []) {
      if (seen.has(importer)) {
        continue;
      }
      seen.add(importer);
      if (testFiles.has(importer)) {
        targets.push(importer);
      }
      queue.push(importer);
    }
  }

  return [...new Set(targets)].toSorted((left, right) => left.localeCompare(right));
}

function resolveVitestConfigTargetKind(relative) {
  return VITEST_CONFIG_TARGET_KIND_BY_PATH.get(relative) ?? null;
}

function isVitestConfigPathLikeTarget(relative) {
  return (
    relative === ROOT_VITEST_CONFIG || /^test\/vitest\/vitest\..+\.config\.ts$/u.test(relative)
  );
}

function isVitestConfigFileTarget(relative) {
  return RUNNABLE_VITEST_CONFIG_TARGETS.has(relative);
}

function isVitestConfigTargetForKind(kind, targetArg, cwd) {
  return resolveVitestConfigTargetKind(toRepoRelativeTarget(targetArg, cwd)) === kind;
}

function listChangedPathsFromGit(baseRef, cwd) {
  return listChangedPathsFromGitSource({ base: baseRef, cwd });
}

function extractChangedBaseRef(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const match = arg.match(CHANGED_ARGS_PATTERN);
    if (!match) {
      continue;
    }
    if (match[1]) {
      return match[1];
    }
    const nextArg = args[index + 1];
    return nextArg && nextArg !== "--" && !nextArg.startsWith("-") ? nextArg : "HEAD";
  }
  return null;
}

function stripChangedArgs(args) {
  const strippedArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const match = arg.match(CHANGED_ARGS_PATTERN);
    if (!match) {
      strippedArgs.push(arg);
      continue;
    }
    if (!match[1]) {
      const nextArg = args[index + 1];
      if (nextArg && nextArg !== "--" && !nextArg.startsWith("-")) {
        index += 1;
      }
    }
  }
  return strippedArgs;
}

function shouldKeepBroadChangedRun(changedPaths) {
  return changedPaths.some((changedPath) =>
    BROAD_CHANGED_FALLBACK_PATTERNS.some((pattern) => pattern.test(changedPath)),
  );
}

function resolveToolingChangedTestTargets(changedPaths, cwd = process.cwd()) {
  const targets = [];
  for (const changedPath of changedPaths) {
    const testTargets = resolveToolingTestTargets(changedPath, cwd);
    if (!testTargets) {
      return null;
    }
    targets.push(...testTargets);
  }
  return [...new Set(targets)];
}

const TOOLING_SCRIPT_PATH_PATTERN = /^scripts\/(.+)\.(?:mjs|cjs|js|mts|cts|ts|sh|py|ps1)$/u;
// Fallback scope for a changed script with no owning spec: the script suite,
// not the whole node lane.
const TOOLING_TEST_DIR_TARGET = "test/scripts";

function resolveConventionalToolingTestTargets(changedPath, cwd = process.cwd()) {
  const match = TOOLING_SCRIPT_PATH_PATTERN.exec(changedPath);
  if (!match) {
    return null;
  }
  const stem = match[1];
  const basename = path.posix.basename(stem);
  const dashedStem = stem.replaceAll("/", "-");
  const candidates = [
    `test/scripts/${stem}.test.ts`,
    `test/scripts/${dashedStem}.test.ts`,
    `test/scripts/${basename}.test.ts`,
  ];
  const targets = candidates.filter((candidate) => fs.existsSync(path.join(cwd, candidate)));
  return targets.length > 0 ? targets : null;
}

function isToolingScriptPath(changedPath) {
  return TOOLING_SCRIPT_PATH_PATTERN.test(changedPath);
}

function resolveToolingTestTargets(changedPath, cwd = process.cwd()) {
  const explicitTargets = TOOLING_SOURCE_TEST_TARGETS.get(changedPath);
  const conventionalTargets = resolveConventionalToolingTestTargets(changedPath, cwd);
  if (explicitTargets && conventionalTargets) {
    return uniqueOrdered([...explicitTargets, ...conventionalTargets]);
  }
  return (
    explicitTargets ??
    conventionalTargets ??
    (isToolingScriptPath(changedPath) ? [TOOLING_TEST_DIR_TARGET] : null)
  );
}

function shouldUseBroadChangedTargets(env = process.env) {
  const value = env[BROAD_CHANGED_ENV_KEY]?.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value ?? "");
}

function isRoutableChangedTarget(changedPath) {
  if (GENERATED_CHANGED_TEST_TARGET_PATTERNS.some((pattern) => pattern.test(changedPath))) {
    return false;
  }
  if (changedPath.endsWith(".live.test.ts")) {
    return false;
  }
  return /^(?:src|test|extensions|ui|packages)(?:\/|$)/u.test(changedPath);
}

function resolveSiblingTestTarget(changedPath, cwd) {
  if (!/\.[cm]?tsx?$/u.test(changedPath) || isTestFileTarget(changedPath)) {
    return null;
  }
  const withoutExtension = changedPath.replace(/\.[cm]?tsx?$/u, "");
  const sibling = `${withoutExtension}.test.ts`;
  return fs.existsSync(path.join(cwd, sibling)) ? sibling : null;
}

function shouldCombineSiblingTestWithImportGraph(changedPath) {
  return changedPath.startsWith("test/helpers/");
}

function shouldRouteChangedTargetWithoutImportGraph(changedPath) {
  return (
    changedPath.endsWith(".live.test.ts") ||
    (changedPath.startsWith("ui/src/") && !changedPath.startsWith("ui/src/ui/"))
  );
}

function resolvePreciseChangedTestTargets(changedPath, options) {
  const cwd = options.cwd ?? process.cwd();
  const mappedTargets =
    resolveToolingTestTargets(changedPath) ?? SOURCE_TEST_TARGETS.get(changedPath);
  if (mappedTargets) {
    return mappedTargets;
  }
  if (isRoutableChangedTarget(changedPath) && isTestFileTarget(changedPath)) {
    return [changedPath];
  }
  const siblingTest = resolveSiblingTestTarget(changedPath, cwd);
  if (siblingTest && !shouldCombineSiblingTestWithImportGraph(changedPath)) {
    return [siblingTest];
  }
  if (shouldRouteChangedTargetWithoutImportGraph(changedPath)) {
    return changedPath.startsWith("ui/src/") ? [changedPath] : null;
  }
  if (options.skipImportGraph === true) {
    return null;
  }
  if (/^(?:src|test\/helpers|extensions|packages|ui\/src|ui\/config)\//u.test(changedPath)) {
    const affectedTests = resolveAffectedTestsFromImportGraph(changedPath, cwd, {
      forceFull: options.forceFullImportGraph === true,
    });
    if (affectedTests.length > 0) {
      return siblingTest ? uniqueOrdered([siblingTest, ...affectedTests]) : affectedTests;
    }
  }
  return siblingTest ? [siblingTest] : null;
}

function isDeletedChangedTestTarget(changedPath, cwd) {
  return isTestFileTarget(changedPath) && !fs.existsSync(path.join(cwd, changedPath));
}

/**
 * Maps changed repo paths to the smallest useful Vitest target plan.
 */
export function resolveChangedTestTargetPlan(changedPaths, options = {}) {
  if (changedPaths.length === 0) {
    return { mode: "none", targets: [] };
  }
  const cwd = options.cwd ?? process.cwd();
  const executableChangedPaths = changedPaths.filter(
    (changedPath) => !isDeletedChangedTestTarget(changedPath, cwd),
  );
  const toolingTargets = resolveToolingChangedTestTargets(executableChangedPaths, cwd);
  if (toolingTargets) {
    return { mode: "targets", targets: toolingTargets };
  }
  const changedLanes = detectChangedLanes(executableChangedPaths);
  const env = options.env ?? {};
  const useBroadFallback = options.broad ?? shouldUseBroadChangedTargets(env);
  const skipImportGraph = changedLanes.lanes.all && !useBroadFallback;
  const targets = [];
  const skippedBroadFallbackPaths = [];
  for (const changedPath of executableChangedPaths) {
    const preciseTargets = resolvePreciseChangedTestTargets(changedPath, {
      ...options,
      skipImportGraph,
    });
    if (preciseTargets) {
      targets.push(...preciseTargets);
      continue;
    }
    const needsBroadFallback = shouldKeepBroadChangedRun([changedPath]) || changedLanes.lanes.all;
    if (needsBroadFallback) {
      if (useBroadFallback) {
        return { mode: "broad", targets: [] };
      }
      skippedBroadFallbackPaths.push(changedPath);
      continue;
    }
    if (isRoutableChangedTarget(changedPath)) {
      targets.push(changedPath);
    }
  }
  if (useBroadFallback && changedLanes.extensionImpactFromCore) {
    targets.push("extensions");
  }
  const plan = { mode: "targets", targets: [...new Set(targets)] };
  if (skippedBroadFallbackPaths.length > 0) {
    plan.skippedBroadFallbackPaths = [...new Set(skippedBroadFallbackPaths)];
  }
  return plan;
}

export function resolveChangedTargetArgs(
  args,
  cwd = process.cwd(),
  listChangedPaths = listChangedPathsFromGit,
  options = {},
) {
  const plan = resolveChangedTestTargetPlanForArgs(args, cwd, listChangedPaths, options);
  if (!plan) {
    return null;
  }
  if (plan.mode === "broad") {
    return null;
  }
  return plan.targets;
}

export function resolveChangedTestTargetPlanForArgs(
  args,
  cwd = process.cwd(),
  listChangedPaths = listChangedPathsFromGit,
  options = {},
) {
  const baseRef = extractChangedBaseRef(args);
  if (!baseRef) {
    return null;
  }
  const changedPaths = listChangedPaths(baseRef, cwd);
  return resolveChangedTestTargetPlan(changedPaths, {
    cwd,
    ...options,
  });
}

// A target only has to choose an environment: the Control UI needs jsdom, and
// everything else runs in the node lane.
function classifyTarget(arg, cwd) {
  const relative = toRepoRelativeTarget(arg, cwd);
  const configTargetKind = resolveVitestConfigTargetKind(relative);
  if (configTargetKind) {
    return configTargetKind;
  }
  return isPathAtOrUnder(relative, "ui/src") ? "ui" : "node";
}

function shouldUseWholeConfigTarget(kind, targetArg, cwd) {
  if (isVitestConfigTargetForKind(kind, targetArg, cwd)) {
    return true;
  }
  if (kind !== "ui") {
    return false;
  }
  const relative = toRepoRelativeTarget(targetArg, cwd);
  if (isTestFileTarget(relative)) {
    return false;
  }
  return relative.startsWith("ui/src/") && !relative.startsWith("ui/src/ui/");
}

function createVitestArgs(params) {
  return [
    "exec",
    "node",
    ...resolveVitestNodeArgs(params.env),
    resolveVitestCliEntry(),
    ...(params.watchMode ? [] : ["run"]),
    "--config",
    params.config,
    ...params.forwardedArgs,
  ];
}

export function parseTestProjectsArgs(args, cwd = process.cwd()) {
  const forwardedArgs = [];
  const targetArgs = [];
  let watchMode = false;
  let passthrough = false;

  for (const arg of args) {
    if (arg === "--") {
      if (targetArgs.length > 0) {
        passthrough = true;
      }
      continue;
    }
    if (passthrough) {
      if (arg === "--watch") {
        watchMode = true;
      }
      forwardedArgs.push(arg);
      continue;
    }
    if (arg === "--watch") {
      watchMode = true;
      continue;
    }
    if (isPathLikeTargetArg(arg, cwd)) {
      targetArgs.push(arg);
    }
    forwardedArgs.push(arg);
  }

  return { forwardedArgs, targetArgs, watchMode };
}

export function buildVitestRunPlans(
  args,
  cwd = process.cwd(),
  listChangedPaths = listChangedPathsFromGit,
  options = {},
) {
  const { forwardedArgs, targetArgs, watchMode } = parseTestProjectsArgs(args, cwd);
  const changedTargetArgs =
    targetArgs.length === 0 ? resolveChangedTargetArgs(args, cwd, listChangedPaths, options) : null;
  const requestedTargetArgs = changedTargetArgs ?? targetArgs;
  const activeTargetArgs = expandExplicitSourceTestTargets(requestedTargetArgs, cwd);
  const activeForwardedArgs =
    changedTargetArgs !== null ? stripChangedArgs(forwardedArgs) : forwardedArgs;
  if (changedTargetArgs !== null && activeTargetArgs.length === 0) {
    return [];
  }
  if (activeTargetArgs.length === 0) {
    return [
      {
        config: DEFAULT_VITEST_CONFIG,
        forwardedArgs: activeForwardedArgs,
        includePatterns: null,
        watchMode,
      },
    ];
  }

  const nonTargetArgs = activeForwardedArgs.filter((arg) => !requestedTargetArgs.includes(arg));
  const explicitConfigTargets = activeTargetArgs.map((targetArg) =>
    toRepoRelativeTarget(targetArg, cwd),
  );
  if (explicitConfigTargets.every(isVitestConfigFileTarget)) {
    if (watchMode && explicitConfigTargets.length > 1) {
      throw new Error(
        "watch mode with mixed test suites is not supported; target one suite at a time or use a dedicated suite command",
      );
    }
    return explicitConfigTargets.map((config) => ({
      config,
      forwardedArgs: nonTargetArgs,
      includePatterns: null,
      watchMode,
    }));
  }

  const groupedTargets = new Map();
  for (const targetArg of activeTargetArgs) {
    const kind = classifyTarget(targetArg, cwd);
    const current = groupedTargets.get(kind) ?? [];
    current.push(targetArg);
    groupedTargets.set(kind, current);
  }

  if (watchMode && groupedTargets.size > 1) {
    throw new Error(
      "watch mode with mixed test suites is not supported; target one suite at a time or use a dedicated suite command",
    );
  }

  const plans = [];
  for (const kind of ["node", "ui"]) {
    const grouped = groupedTargets.get(kind);
    if (!grouped || grouped.length === 0) {
      continue;
    }
    const config = VITEST_CONFIG_BY_KIND[kind] ?? DEFAULT_VITEST_CONFIG;
    // Explicit spec files can go on the Vitest command line; the lane narrows
    // its own include patterns from them. Anything broader needs an include
    // file so the lane does not fall back to its full pattern list.
    const useCliTargetArgs = grouped.every((targetArg) =>
      isFileLikeTarget(toRepoRelativeTarget(targetArg, cwd)),
    );
    const useWholeConfigTarget = grouped.some((targetArg) =>
      shouldUseWholeConfigTarget(kind, targetArg, cwd),
    );
    const includePatterns =
      useCliTargetArgs || useWholeConfigTarget
        ? null
        : uniqueOrdered(grouped.map((targetArg) => toScopedIncludePattern(targetArg, cwd)));
    const scopedTargetArgs = useCliTargetArgs ? uniqueOrdered(grouped) : [];
    plans.push({
      config,
      forwardedArgs: [...nonTargetArgs, ...scopedTargetArgs],
      includePatterns,
      watchMode,
    });
  }
  return plans;
}

export function buildFullSuiteVitestRunPlans(args, cwd = process.cwd()) {
  const { forwardedArgs, watchMode } = parseTestProjectsArgs(args, cwd);
  if (watchMode) {
    return [
      {
        config: ROOT_VITEST_CONFIG,
        forwardedArgs,
        includePatterns: null,
        watchMode,
      },
    ];
  }
  return [NODE_VITEST_CONFIG, UI_VITEST_CONFIG].map((config) => ({
    config,
    forwardedArgs,
    includePatterns: null,
    watchMode: false,
  }));
}

export function shouldUseLocalFullSuiteParallelByDefault(env = process.env) {
  if (hasConservativeVitestWorkerBudget(env)) {
    return false;
  }
  return (
    env.OPENCLAW_TEST_PROJECTS_SERIAL !== "1" && env.CI !== "true" && env.GITHUB_ACTIONS !== "true"
  );
}

function parsePositiveInt(value, label) {
  const text = value?.trim();
  if (!text) {
    return null;
  }
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${label} must be a positive integer; got: ${value}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer; got: ${value}`);
  }
  return parsed;
}

function hasConservativeVitestWorkerBudget(env) {
  const workerBudget = parsePositiveInt(
    env.OPENCLAW_VITEST_MAX_WORKERS ?? env.OPENCLAW_TEST_WORKERS,
    env.OPENCLAW_VITEST_MAX_WORKERS === undefined
      ? "OPENCLAW_TEST_WORKERS"
      : "OPENCLAW_VITEST_MAX_WORKERS",
  );
  return workerBudget !== null && workerBudget <= 1;
}

export function resolveParallelFullSuiteConcurrency(specCount, envInput, hostInfo) {
  let env = envInput;
  env ??= process.env;
  const override = parsePositiveInt(
    env.OPENCLAW_TEST_PROJECTS_PARALLEL,
    "OPENCLAW_TEST_PROJECTS_PARALLEL",
  );
  if (override !== null) {
    return Math.min(override, specCount);
  }
  if (env.OPENCLAW_TEST_PROJECTS_SERIAL === "1") {
    return 1;
  }
  if (isCiLikeEnv(env)) {
    return 1;
  }
  if (hasConservativeVitestWorkerBudget(env)) {
    return 1;
  }
  if (!shouldUseLocalFullSuiteParallelByDefault(env)) {
    return 1;
  }
  return Math.min(resolveLocalFullSuiteProfile(env, hostInfo).shardParallelism, specCount);
}

function sanitizeVitestCachePathSegment(value) {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 180) || "default"
  );
}

export function applyParallelVitestCachePaths(specs, params = {}) {
  const baseEnv = params.env ?? process.env;
  if (baseEnv[FS_MODULE_CACHE_PATH_ENV_KEY]?.trim()) {
    return specs;
  }
  const cwd = params.cwd ?? process.cwd();
  return specs.map((spec, index) => {
    if (spec.env?.[FS_MODULE_CACHE_PATH_ENV_KEY]?.trim()) {
      return spec;
    }
    const cacheSegment = sanitizeVitestCachePathSegment(`${index}-${spec.config}`);
    return {
      ...spec,
      env: {
        ...spec.env,
        [FS_MODULE_CACHE_PATH_ENV_KEY]: path.join(
          cwd,
          "node_modules",
          ".experimental-vitest-cache",
          cacheSegment,
        ),
      },
    };
  });
}

export function applyDefaultMultiSpecVitestCachePaths(specs, params = {}) {
  if (specs.length <= 1 || specs.some((spec) => spec.watchMode)) {
    return specs;
  }
  return applyParallelVitestCachePaths(specs, params);
}

export function applyDefaultVitestNoOutputTimeout(specs, params = {}) {
  const baseEnv = params.env ?? process.env;
  if (
    Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY) &&
    Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY)
  ) {
    return specs;
  }
  return specs.map((spec) => {
    if (spec.watchMode) {
      return spec;
    }
    const env = spec.env ?? {};
    const nextEnv = { ...env };
    if (
      !Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY) &&
      !Object.hasOwn(env, VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY)
    ) {
      nextEnv[VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY] = DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS;
    }
    if (
      !Object.hasOwn(baseEnv, VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY) &&
      !Object.hasOwn(env, VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY)
    ) {
      nextEnv[VITEST_NO_OUTPUT_HEARTBEAT_ENV_KEY] =
        DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_HEARTBEAT_MS;
    }
    return {
      ...spec,
      env: nextEnv,
    };
  });
}

export function shouldRetryVitestNoOutputTimeout(env = process.env) {
  const value = env[VITEST_NO_OUTPUT_RETRY_ENV_KEY]?.trim().toLowerCase();
  if (value === undefined && isCiLikeEnv(env)) {
    return false;
  }
  return !["0", "false", "no", "off"].includes(value ?? "");
}

export function createVitestRunSpecs(args, params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const baseEnv = params.baseEnv ?? process.env;
  const plans = buildVitestRunPlans(args, cwd, listChangedPathsFromGit, { env: baseEnv });
  return plans.map((plan, index) => {
    const includeFilePath = plan.includePatterns
      ? path.join(
          params.tempDir ?? os.tmpdir(),
          `openclaw-vitest-include-${randomUUID()}-${index}.json`,
        )
      : null;
    return {
      config: plan.config,
      env: includeFilePath
        ? {
            ...baseEnv,
            [INCLUDE_FILE_ENV_KEY]: includeFilePath,
          }
        : baseEnv,
      includeFilePath,
      includePatterns: plan.includePatterns,
      pnpmArgs: createVitestArgs(plan),
      watchMode: plan.watchMode,
    };
  });
}

export function shouldAcquireLocalHeavyCheckLock(_runSpecs, env = process.env) {
  return env.OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD !== "1";
}

export function writeVitestIncludeFile(filePath, includePatterns) {
  fs.writeFileSync(filePath, `${JSON.stringify(includePatterns, null, 2)}\n`);
}

function shellQuote(value) {
  const text = `${value}`;
  if (text === "") {
    return "''";
  }
  if (/^[A-Za-z0-9_./:=@%+-]+$/u.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function formatFailedShardRerunCommand(failure) {
  const includePatterns = failure.includePatterns ?? [];
  if (includePatterns.length > 0) {
    return ["pnpm", "test", ...includePatterns.map(shellQuote), "--", "--reporter=verbose"].join(
      " ",
    );
  }
  return [
    "node",
    "scripts/run-vitest.mjs",
    "run",
    "--config",
    shellQuote(failure.config),
    "--reporter=verbose",
  ].join(" ");
}

function formatFailedShardStatus(failure) {
  const details = [];
  if (failure.code !== undefined && failure.code !== null) {
    details.push(`exit ${failure.code}`);
  }
  if (failure.signal) {
    details.push(`signal ${failure.signal}`);
  }
  if (failure.noOutputTimedOut) {
    details.push("no-output timeout");
  }
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

export function formatFailedShardDigest(failures, options = {}) {
  if (failures.length === 0) {
    return [];
  }

  const limit = options.limit ?? FAILED_SHARD_DIGEST_LIMIT;
  const orderedFailures = failures.toSorted((left, right) => {
    const leftOrder = typeof left.order === "number" ? left.order : Number.MAX_SAFE_INTEGER;
    const rightOrder = typeof right.order === "number" ? right.order : Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.config.localeCompare(right.config);
  });
  const shown = orderedFailures.slice(0, limit);
  const lines = [`[test] failed shard digest (${failures.length}):`];
  for (const failure of shown) {
    const includes =
      failure.includePatterns?.length > 0
        ? ` includes=${failure.includePatterns.map(shellQuote).join(",")}`
        : "";
    lines.push(`[test] - ${failure.config}${formatFailedShardStatus(failure)}${includes}`);
    lines.push(`[test]   rerun: ${formatFailedShardRerunCommand(failure)}`);
  }
  if (shown.length < failures.length) {
    lines.push(`[test] - ... ${failures.length - shown.length} more failed shard(s) omitted`);
  }
  return lines;
}

export function buildVitestArgs(args, cwd = process.cwd()) {
  const [plan] = buildVitestRunPlans(args, cwd);
  if (!plan) {
    return createVitestArgs({
      config: DEFAULT_VITEST_CONFIG,
      forwardedArgs: [],
      watchMode: false,
    });
  }
  return createVitestArgs(plan);
}

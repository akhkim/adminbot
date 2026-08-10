#!/usr/bin/env node
// Check Dir Size ratchets the ≤80-non-test-files-per-directory target ADR-0001
// set for the restructure.
//
// The count is of files sitting *directly* in a directory, not of its whole
// tree: the target is about whether a directory listing is readable, and a
// directory with 20 files and 12 subdirectories is readable while one with 200
// files is not. Tests are excluded because a colocated `x.test.ts` is not a
// separate thing to navigate past — it is part of `x.ts`.
//
// The list is git-tracked files only, so an untracked scratch file cannot fail
// the gate and a deleted-but-not-committed file cannot pass it.
//
// Directories already over the limit are grandfathered in
// config/dir-size-grandfather.json with the count they were at. That count is
// the ratchet: growing past it fails, and dropping to the limit makes the entry
// prunable. Two entries are permanent by ADR (plugin-sdk, agents); the rest are
// the proof-of-work list for the remaining sub-grouping.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repoRoot, "config", "dir-size-grandfather.json");

const TEST_FILE_PATTERN = /(?:\.test|\.e2e\.test)\.[cm]?[tj]sx?$/;
const SCANNED_DIR_PATTERN = /^(?:src(?:\/|$)|extensions\/[^/]+\/src(?:\/|$))/;

/**
 * True for a repo path whose directory is in scope: under `src/` or under an
 * extension's own `src/`.
 */
export function isScannedRepoPath(repoPath) {
  return SCANNED_DIR_PATTERN.test(repoPath) && !TEST_FILE_PATTERN.test(repoPath);
}

/**
 * Counts tracked non-test files sitting directly in each in-scope directory.
 */
export function countDirectFiles(repoPaths) {
  const counts = new Map();
  for (const repoPath of repoPaths) {
    if (!isScannedRepoPath(repoPath)) {
      continue;
    }
    const slashIndex = repoPath.lastIndexOf("/");
    if (slashIndex === -1) {
      continue;
    }
    const dir = repoPath.slice(0, slashIndex);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return counts;
}

/**
 * Applies the limit and the grandfather ratchet to a directory count map.
 *
 * Pure: the runner does the I/O and the exit code.
 */
export function evaluateDirSizes(counts, config) {
  const failures = [];
  const warnings = [];
  const limit = config.limit;

  for (const [dir, count] of [...counts].toSorted((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    if (count <= limit) {
      continue;
    }
    const entry = config.grandfathered[dir];
    if (!entry) {
      failures.push({
        dir,
        detail: `${count} non-test files directly in this directory (limit ${limit}); sub-group it, or grandfather it in config/dir-size-grandfather.json with a reason`,
      });
      continue;
    }
    if (count > entry.max) {
      failures.push({
        dir,
        detail: `grew to ${count} non-test files; grandfathered at ${entry.max}. The grandfather list is a ratchet — move files out, or split the directory`,
      });
    }
  }

  for (const [dir, entry] of Object.entries(config.grandfathered).toSorted((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    const count = counts.get(dir) ?? 0;
    if (count <= limit) {
      warnings.push({
        dir,
        detail: `now at ${count} non-test files (limit ${limit}); prune it from config/dir-size-grandfather.json`,
      });
      continue;
    }
    if (count < entry.max) {
      warnings.push({
        dir,
        detail: `down to ${count} from the grandfathered ${entry.max}; tighten the max in config/dir-size-grandfather.json to hold the gain`,
      });
    }
  }

  return { failures, warnings };
}

/**
 * Reads and shallowly validates the grandfather config.
 */
export function parseDirSizeConfig(raw) {
  const parsed = JSON.parse(raw);
  if (typeof parsed?.limit !== "number" || !Number.isInteger(parsed.limit) || parsed.limit <= 0) {
    throw new TypeError("config/dir-size-grandfather.json must declare a positive integer limit");
  }
  if (typeof parsed.grandfathered !== "object" || parsed.grandfathered === null) {
    throw new TypeError("config/dir-size-grandfather.json must declare a grandfathered object");
  }
  for (const [dir, entry] of Object.entries(parsed.grandfathered)) {
    if (typeof entry?.max !== "number" || !Number.isInteger(entry.max)) {
      throw new TypeError(`config/dir-size-grandfather.json: ${dir} must declare an integer max`);
    }
    if (typeof entry.reason !== "string" || entry.reason.length === 0) {
      throw new TypeError(`config/dir-size-grandfather.json: ${dir} must declare a reason`);
    }
  }
  return parsed;
}

function listTrackedPaths() {
  const stdout = execFileSync("git", ["ls-files", "-z", "--", "src", "extensions"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

function main() {
  const config = parseDirSizeConfig(readFileSync(configPath, "utf8"));
  const counts = countDirectFiles(listTrackedPaths());
  const { failures, warnings } = evaluateDirSizes(counts, config);
  const overLimit = [...counts.values()].filter((count) => count > config.limit).length;

  console.log(
    `Directory size check: ${counts.size} directories, ${overLimit} over the ${config.limit}-file limit, ` +
      `${Object.keys(config.grandfathered).length} grandfathered, ${failures.length} failure(s), ${warnings.length} warning(s).`,
  );

  for (const warning of warnings) {
    console.error(`[dir-size] WARNING ${warning.dir}: ${warning.detail}`);
  }
  if (failures.length === 0) {
    return 0;
  }
  console.error("\nDirectory size violations:");
  for (const failure of failures) {
    console.error(`  ${failure.dir}\n    ${failure.detail}`);
  }
  return 1;
}

if (import.meta.main) {
  process.exitCode = main();
}

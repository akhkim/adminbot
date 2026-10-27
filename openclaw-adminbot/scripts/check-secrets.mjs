#!/usr/bin/env node
// Check Secrets refuses an AdminBot personal API token (`abt_…`) in the repository.
//
// A token carries a CRC32 checksum of itself (see api-token-format.ts), so this flags only strings
// whose checksum matches: a real token minted by the service, never a test fixture or a doc example
// that merely starts with `abt_`. That keeps the check blocking without an allowlist to maintain.
//
//   node scripts/check-secrets.mjs            every tracked file (CI)
//   node scripts/check-secrets.mjs --staged   lines added in the index (pre-commit)
//
// Findings print the file and line with the token redacted, never the token itself: a CI log is
// public on a public repository.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE = /abt_[A-Za-z0-9_-]{43}_[0-9a-f]{8}/gu;
const MAX_BYTES = 2 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Same CRC32 as crc32Hex in api-token-format.ts; a test keeps the two in step. */
export function crc32Hex(text) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, "utf8")) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

/** The real tokens in a piece of text: shaped like one and carrying a matching checksum. */
export function findApiTokens(text) {
  return [...text.matchAll(CANDIDATE)]
    .map((match) => match[0])
    .filter((token) => crc32Hex(token.slice(0, -9)) === token.slice(-8));
}

function git(args) {
  return execFileSync("git", args, {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

// The whole checkout, not only this package: a token in a workflow file or a sibling directory
// leaks just as well.
const repoRoot = () => git(["rev-parse", "--show-toplevel"]).trim();

function scanTracked() {
  const findings = [];
  const root = repoRoot();
  for (const file of git(["ls-files", "-z", "--full-name", ":/"]).split("\0").filter(Boolean)) {
    let text;
    try {
      const buffer = readFileSync(path.join(root, file));
      if (buffer.length > MAX_BYTES || buffer.includes(0)) {
        continue;
      }
      text = buffer.toString("utf8");
    } catch {
      continue; // Deleted in the working tree, or a submodule.
    }
    if (!text.includes("abt_")) {
      continue;
    }
    text.split("\n").forEach((line, index) => {
      if (findApiTokens(line).length) {
        findings.push(`${file}:${index + 1}`);
      }
    });
  }
  return findings;
}

function scanStaged() {
  const findings = [];
  let file = "";
  let lineNo = 0;
  const diff = git(["diff", "--cached", "--no-color", "--no-ext-diff", "-U0", "--diff-filter=ACMR"]);
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.replace(/^\+\+\+ (?:b\/)?/u, "");
    } else if (line.startsWith("@@")) {
      lineNo = Number(/\+(\d+)/u.exec(line)?.[1] ?? 0);
    } else if (line.startsWith("+")) {
      if (findApiTokens(line).length) {
        findings.push(`${file}:${lineNo}`);
      }
      lineNo += 1;
    }
  }
  return findings;
}

function main() {
  const staged = process.argv.includes("--staged");
  const findings = staged ? scanStaged() : scanTracked();
  if (findings.length === 0) {
    return;
  }
  console.error("AdminBot API token found (abt_[redacted]):");
  for (const finding of findings) {
    console.error(`  ${finding}`);
  }
  console.error(
    "\nRemove it from the file, then revoke it: it may already be in your shell history or a log.\n" +
      "  adminbot auth tokens revoke <id>   or   My Profile → API tokens → Revoke\n" +
      "A token in a pushed commit stays in git history; revoking is what makes it harmless.",
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

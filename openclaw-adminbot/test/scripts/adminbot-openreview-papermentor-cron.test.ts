import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// The scheduled runtime: a HOME of its own, no PYTHONPATH, and no user site-packages, so the only
// way the bridge can import openreview-py is the libs directory the Aurora installer writes.
function cronEnv(dir: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(dir, "home"), ...extra };
  delete env.PYTHONPATH;
  delete env.ADMINBOT_PYTHON;
  delete env.ADMINBOT_PAPERMENTOR_CACHE_DIR;
  delete env.ADMINBOT_OPENREVIEW_RESULTS_JSON;
  env.PYTHONNOUSERSITE = "1";
  return env;
}

// A stand-in for openreview-py: logs in as a synthetic profile that has no submissions.
function installFakeOpenReview(home: string): void {
  const pkg = path.join(home, ".local/share/jinesis-adminbot/python-libs/openreview");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, "__init__.py"), "");
  writeFileSync(
    path.join(pkg, "api.py"),
    [
      "from types import SimpleNamespace",
      "class OpenReviewClient:",
      "    def __init__(self, **kwargs):",
      '        self.profile = SimpleNamespace(id="~Synthetic_Author1")',
      "    def get_all_notes(self, **kwargs):",
      "        return []",
      "",
    ].join("\n"),
  );
}

function runResults(withLibs: boolean) {
  const dir = tempDir("adminbot-openreview-results-");
  const home = path.join(dir, "home");
  mkdirSync(home, { recursive: true });
  if (withLibs) {
    installFakeOpenReview(home);
  }
  const envFile = path.join(dir, "env");
  const snapshot = path.join(dir, "openreview-author-results.json");
  writeFileSync(
    envFile,
    [
      "ADMINBOT_SERVICE_TOKEN=synthetic-test-token",
      "OPENREVIEW_USERNAME=synthetic-user",
      "OPENREVIEW_PASSWORD=synthetic-password",
      `ADMINBOT_OPENREVIEW_RESULTS_JSON=${snapshot}`,
      "",
    ].join("\n"),
  );
  const result = spawnSync("bash", ["scripts/adminbot-openreview-results-cron.sh"], {
    encoding: "utf8",
    env: cronEnv(dir, { ADMINBOT_ENV_FILE: envFile }),
  });
  return { ...result, snapshot };
}

describe("openreview results cron", () => {
  it("imports openreview-py from the installer's libs directory without PYTHONPATH set", () => {
    const run = runResults(true);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("openreview results: 0 submissions, 0 unreadable forums");
    const written = JSON.parse(readFileSync(run.snapshot, "utf8"));
    expect(written).toMatchObject({ ok: true, profile_id: "~Synthetic_Author1", submissions: [] });
    expect(typeof written.fetched_at).toBe("string");
  });

  it("names the libs directory and the installer when openreview-py is missing", () => {
    const run = runResults(false);
    expect(run.status).toBe(1);
    const lines = run.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      "openreview results: missing_dependency: openreview-py is not importable",
    );
    expect(lines[0]).toContain(".local/share/jinesis-adminbot/python-libs");
    expect(lines[0]).toContain("deploy/aurora/install-user-services.sh");
    expect(run.stderr).not.toContain("Traceback");
    // A failed pass leaves the previous snapshot alone rather than writing a broken one.
    expect(existsSync(run.snapshot)).toBe(false);
  });
});

function runSync(sources: string[]) {
  const dir = tempDir("adminbot-paper-openreview-sync-");
  mkdirSync(path.join(dir, "home"), { recursive: true });
  const envFile = path.join(dir, "env");
  const snapshot = path.join(dir, "openreview-author-results.json");
  writeFileSync(
    envFile,
    `ADMINBOT_SERVICE_TOKEN=synthetic-test-token\nADMINBOT_OPENREVIEW_RESULTS_JSON=${snapshot}\n`,
  );
  writeFileSync(
    path.join(dir, "response.json"),
    JSON.stringify({
      dry_run: false,
      sources,
      evidence: 0,
      matched: 0,
      applied: [],
      unchanged: 0,
      kept: [],
      unmatched_submissions: 0,
      warnings: sources.length
        ? []
        : ["author-results snapshot not found; is the openreview results cron installed?"],
    }),
  );
  writeFileSync(
    path.join(dir, "curl"),
    ["#!/bin/bash", 'cat "$TEST_DIR/response.json"', 'printf "\\n200"', ""].join("\n"),
    { mode: 0o700 },
  );
  return spawnSync("bash", ["scripts/adminbot-paper-openreview-sync-cron.sh"], {
    encoding: "utf8",
    env: cronEnv(dir, {
      PATH: `${dir}:${process.env.PATH}`,
      ADMINBOT_ENV_FILE: envFile,
      TEST_DIR: dir,
    }),
  });
}

describe("paper openreview sync cron", () => {
  it("fails naming the snapshot path and the upstream job when there is no snapshot", () => {
    const run = runSync([]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(
      /paper openreview sync: no OpenReview snapshot to read at \S+openreview-author-results\.json; it is written by the adminbot-openreview-results cron job/,
    );
  });

  it("passes when the service read the snapshot", () => {
    const run = runSync(["author_results"]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("paper openreview sync: read author_results; 0 items");
  });
});

function runPaperMentor(cacheDir: string | undefined, args: string[] = []) {
  const dir = tempDir("adminbot-papermentor-cron-");
  mkdirSync(path.join(dir, "home"), { recursive: true });
  const envFile = path.join(dir, "env");
  writeFileSync(
    envFile,
    "ADMINBOT_SERVICE_TOKEN=synthetic-test-token\n" +
      (cacheDir ? `ADMINBOT_PAPERMENTOR_CACHE_DIR=${cacheDir}\n` : ""),
  );
  return spawnSync("bash", ["scripts/adminbot-papermentor-cron.sh", ...args], {
    encoding: "utf8",
    env: cronEnv(dir, { ADMINBOT_ENV_FILE: envFile }),
  });
}

describe("papermentor runs cron", () => {
  it.skipIf(existsSync("/var/lib/overleaf/ai-tutor-cache"))(
    "says the cache is unconfigured in one line when neither the variable nor the default exists",
    () => {
      const run = runPaperMentor(undefined);
      expect(run.status).toBe(1);
      const lines = run.stderr.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(
        "papermentor runs: PaperMentor cache /var/lib/overleaf/ai-tutor-cache is not a directory",
      );
      expect(lines[0]).toContain("ADMINBOT_PAPERMENTOR_CACHE_DIR is not set");
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "says a configured cache it cannot list is unreadable, instead of a bare EACCES",
    () => {
      const cache = tempDir("adminbot-papermentor-cache-");
      chmodSync(cache, 0o000);
      const run = runPaperMentor(cache);
      expect(run.status).toBe(1);
      const lines = run.stderr.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`PaperMentor cache ${cache} is not readable`);
      expect(lines[0]).toContain("from ADMINBOT_PAPERMENTOR_CACHE_DIR");
      expect(run.stderr).not.toContain("EACCES");
    },
  );

  it("walks a readable configured cache", () => {
    const cache = tempDir("adminbot-papermentor-cache-");
    const run = runPaperMentor(cache, ["--dry-run"]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("papermentor runs: 0 to post");
  });
});

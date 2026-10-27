import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const SCRIPT = "scripts/adminbot-weekly-update-cron.sh";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Runs the cron script against a stand-in curl that exits with `curlExit` after printing `output`,
// and records the arguments it was given.
function run(curlExit: number, output = "") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-weekly-update-cron-"));
  dirs.push(dir);
  const envFile = path.join(dir, "env");
  writeFileSync(envFile, "ADMINBOT_SERVICE_TOKEN=synthetic-test-token\n");
  writeFileSync(path.join(dir, "output"), output);
  writeFileSync(
    path.join(dir, "curl"),
    [
      "#!/bin/bash",
      'printf "%s\\n" "$@" > "$TEST_DIR/args"',
      'cat "$TEST_DIR/output"',
      `exit ${curlExit}`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const result = spawnSync("bash", [SCRIPT], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: dir,
      PATH: `${dir}:${process.env.PATH}`,
      ADMINBOT_ENV_FILE: envFile,
      TEST_DIR: dir,
    },
  });
  let args: string[] = [];
  try {
    args = readFileSync(path.join(dir, "args"), "utf8").trim().split("\n");
  } catch {}
  return { ...result, args };
}

describe("weekly update cron", () => {
  // The pass answers only once every author has been messaged, which took twelve minutes by late
  // October 2026; the old two-minute limit failed every Monday run while the nudges still went out.
  it("waits for the slow pass, inside the cron job's own timeout", () => {
    const success = JSON.stringify({
      week_start: "2026-10-26",
      created: [],
      asked: [],
      skipped: [],
    });
    const { args, status } = run(0, `${success}\n200`);
    expect(status).toBe(0);
    const maxTime = Number(args[args.indexOf("--max-time") + 1]);
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "config/adminbot-cron.json"), "utf8"),
    ) as
      | { jobs?: Array<{ name: string; timeoutSeconds?: number }> }
      | Array<{ name: string; timeoutSeconds?: number }>;
    const jobs = Array.isArray(manifest) ? manifest : (manifest.jobs ?? []);
    const job = jobs.find((entry) => entry.name === "adminbot-weekly-updates");
    expect(maxTime).toBeGreaterThanOrEqual(20 * 60);
    expect(job?.timeoutSeconds).toBeGreaterThan(maxTime);
  });

  it("reports a timeout as a slow pass, not as an unreachable service", () => {
    const { status, stderr } = run(28);
    expect(status).toBe(1);
    expect(stderr).toContain("weekly update nudge: no answer within 1740s");
    expect(stderr).toContain("paper_weekly_updates.nudged");
    expect(stderr).not.toContain("could not reach");
  });

  it("still says it could not reach the service when the connection fails", () => {
    const { status, stderr } = run(7);
    expect(status).toBe(1);
    expect(stderr).toContain("could not reach the AdminBot service on 127.0.0.1:8765");
  });

  it("summarizes a finished pass", () => {
    const body = JSON.stringify({
      week_start: "2026-10-26",
      created: ["p1", "p2"],
      asked: ["m-ada", "m-bo"],
      skipped: [{ member_id: "m-cy", reason: "no slack_user_id" }],
    });
    const { status, stdout } = run(0, `${body}\n200`);
    expect(status).toBe(0);
    expect(stdout).toContain("week of 2026-10-26 — 2 message(s) to 2 member(s), 1 skipped");
    expect(stdout).toContain("skipped m-cy: no slack_user_id");
  });
});

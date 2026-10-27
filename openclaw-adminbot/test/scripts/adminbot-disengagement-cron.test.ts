import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const SCRIPT = "scripts/adminbot-disengagement-cron.sh";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Runs the cron script against a stand-in curl that exits with `curlExit` after printing `output`,
// and records the arguments it was given.
function run(curlExit: number, output = "") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-disengagement-cron-"));
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

describe("disengagement cron", () => {
  // The pass answers only after its last Slack message; eight reminders took 61 seconds on
  // 2026-10-27, and the old 60-second limit marked that run failed while every reminder went out.
  it("waits for the slow pass, inside the cron job's own timeout", () => {
    const success = JSON.stringify({ reminded: [], escalated: [], dormant: [], skipped: [] });
    const { args, status } = run(0, `${success}\n200`);
    expect(status).toBe(0);
    const maxTime = Number(args[args.indexOf("--max-time") + 1]);
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "config/adminbot-cron.json"), "utf8"),
    ) as
      | { jobs?: Array<{ name: string; timeoutSeconds?: number }> }
      | Array<{ name: string; timeoutSeconds?: number }>;
    const jobs = Array.isArray(manifest) ? manifest : (manifest.jobs ?? []);
    const job = jobs.find((entry) => entry.name === "adminbot-disengagement");
    expect(maxTime).toBeGreaterThanOrEqual(10 * 60);
    expect(job?.timeoutSeconds).toBeGreaterThan(maxTime);
  });

  it("reports a timeout as a slow pass, not as an unreachable service", () => {
    const { status, stderr } = run(28);
    expect(status).toBe(1);
    expect(stderr).toContain("disengagement sweep: no answer within 840s");
    expect(stderr).toContain("members.disengagement_swept");
    expect(stderr).not.toContain("could not reach");
  });

  it("still says it could not reach the service when the connection fails", () => {
    const { status, stderr } = run(7);
    expect(status).toBe(1);
    expect(stderr).toContain("could not reach the AdminBot service on 127.0.0.1:8765");
  });

  it("summarizes a finished pass", () => {
    const body = JSON.stringify({
      reminded: [{ step: "first_reminder", member_id: "m-ada", days: 5 }],
      escalated: [],
      dormant: ["m-bo"],
      skipped: [{ member_id: "m-cy", reason: "member has no slack_user_id" }],
    });
    const { status, stdout } = run(0, `${body}\n200`);
    expect(status).toBe(0);
    expect(stdout).toContain(
      "disengagement sweep: 1 onboarding reminder(s), 0 escalation(s), 1 dormant-account reminder(s), 1 skipped",
    );
    expect(stdout).toContain("skipped m-cy: member has no slack_user_id");
  });
});

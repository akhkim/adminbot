import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Runs a job that writes `stderr` and exits `code`, and returns the heartbeat it reported.
function heartbeatFor(stderr: string, code: number) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-cron-run-"));
  try {
    const envFile = path.join(dir, "env");
    const sent = path.join(dir, "sent");
    writeFileSync(envFile, "ADMINBOT_SERVICE_TOKEN=synthetic-test-token\n");
    writeFileSync(path.join(dir, "stderr.txt"), stderr);
    writeFileSync(
      path.join(dir, "curl"),
      '#!/bin/bash\nwhile [[ $# -gt 0 ]]; do [[ "$1" == --data ]] && printf "%s" "$2" > "$TEST_SENT"; shift; done\n',
      { mode: 0o700 },
    );
    const result = spawnSync(
      "bash",
      [
        "scripts/lib/adminbot-cron-run.sh",
        "email-automation",
        "7 * * * *",
        "--",
        "bash",
        "-c",
        `cat "${path.join(dir, "stderr.txt")}" >&2; exit ${code}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          ADMINBOT_ENV_FILE: envFile,
          TEST_SENT: sent,
        },
      },
    );
    return { status: result.status, beat: JSON.parse(readFileSync(sent, "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("cron heartbeat", () => {
  it("reports the job's own error, not a Node warning printed after it", () => {
    const run = heartbeatFor(
      [
        "email automation: Gmail refused the refresh token (invalid_grant)",
        "(node:4242) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.",
        "(Use `node --trace-deprecation ...` to show where the warning was created)",
        "",
      ].join("\n"),
      1,
    );
    expect(run.status).toBe(1);
    expect(run.beat).toMatchObject({ job: "email-automation", ok: false, exit_code: 1 });
    expect(run.beat.detail).toBe(
      "email automation: Gmail refused the refresh token (invalid_grant)",
    );
  });

  it("still redacts credentials in the detail", () => {
    expect(heartbeatFor("request failed: Bearer abc.def.ghi\n", 2).beat.detail).toBe(
      "request failed: Bearer [redacted]",
    );
    expect(heartbeatFor("bad config: api_key=abc123 token: xyz\n", 2).beat.detail).toBe(
      "bad config: api_key [redacted] token [redacted]",
    );
    expect(heartbeatFor("openrouter rejected sk-or-v1-0123456789abcdef0123\n", 2).beat.detail).toBe(
      "openrouter rejected [redacted]",
    );
  });

  it("keeps the words of an ordinary token error", () => {
    expect(heartbeatFor("Token has been expired or revoked.\n", 1).beat.detail).toBe(
      "Token has been expired or revoked.",
    );
  });

  it("sends no detail for a successful run", () => {
    const run = heartbeatFor("(node:1) ExperimentalWarning: x\n", 0);
    expect(run.beat).toMatchObject({ ok: true, exit_code: 0, detail: "" });
  });
});

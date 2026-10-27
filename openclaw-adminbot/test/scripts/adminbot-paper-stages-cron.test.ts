import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const STAGES = JSON.stringify({
  advanced: [{ paper_id: "p1", from: "draft", to: "internal_review" }],
  pi_review_requested: ["p2"],
  waiting_on_pi: 1,
});

// Answers each endpoint from a synthetic body, and logs which endpoints were called.
function runPass(verifyBody: string, verifyStatus = "200") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-paper-stages-"));
  try {
    const envFile = path.join(dir, "env");
    const log = path.join(dir, "calls");
    writeFileSync(envFile, "ADMINBOT_SERVICE_TOKEN=synthetic-test-token\n");
    writeFileSync(path.join(dir, "verify.json"), verifyBody);
    writeFileSync(path.join(dir, "stages.json"), STAGES);
    writeFileSync(
      path.join(dir, "curl"),
      [
        "#!/bin/bash",
        'url="${@: -1}"',
        'printf "%s\\n" "$url" >> "$TEST_CALLS"',
        'case "$url" in',
        '  */papers/evidence/verify/run) cat "$TEST_DIR/verify.json"; printf "\\n%s" "$TEST_VERIFY_STATUS" ;;',
        '  */papers/stages/run) cat "$TEST_DIR/stages.json"; printf "\\n200" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const result = spawnSync("bash", ["scripts/adminbot-paper-stages-cron.sh"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        ADMINBOT_ENV_FILE: envFile,
        TEST_CALLS: log,
        TEST_DIR: dir,
        TEST_VERIFY_STATUS: verifyStatus,
      },
    });
    return { ...result, calls: readFileSync(log, "utf8").trim().split("\n") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("paper stages cron", () => {
  it("verifies evidence once, then reaches the stage walk", () => {
    const run = runPass(
      JSON.stringify({
        checked: 3,
        verified: [{}, {}],
        invalidated: [{ paper_id: "p9", slot: "drive_pdf" }],
        unreadable: [],
      }),
    );
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.calls).toEqual([
      "http://127.0.0.1:8765/papers/evidence/verify/run",
      "http://127.0.0.1:8765/papers/stages/run",
    ]);
    expect(run.stdout).toContain("paper evidence: 3 checked, 2 confirmed, 1 contradicted");
    expect(run.stdout).toContain("contradicted p9: drive_pdf");
    expect(run.stdout).toContain("paper stages: 1 advanced, 1 sent for PI review, 1 waiting");
    expect(run.stdout).toContain("p1: draft -> internal_review");
  });

  it("still walks the stages when the verification summary is unreadable", () => {
    const run = runPass("<html>gateway error</html>");
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("paper evidence: unreadable verification summary");
    expect(run.calls.at(-1)).toBe("http://127.0.0.1:8765/papers/stages/run");
    expect(run.stdout).toContain("paper stages: 1 advanced");
  });

  it("still walks the stages when verification is unavailable", () => {
    const run = runPass("", "503");
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("verification pass unavailable (HTTP 503)");
    expect(run.stdout).toContain("paper stages: 1 advanced");
  });
});

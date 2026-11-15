// What a cron wrapper says when its call to the local service fails: a timeout must not read as
// an outage, because the two send whoever is on call in opposite directions.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs the member-map wrapper with a `curl` on PATH that exits with `curlExit`. */
function runMemberMap(curlExit: number, stdout = "") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-cron-curl-"));
  dirs.push(dir);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const answer = path.join(dir, "answer");
  writeFileSync(answer, stdout);
  writeFileSync(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash\ncat ${JSON.stringify(answer)}\nexit ${curlExit}\n`,
  );
  chmodSync(path.join(bin, "curl"), 0o755);
  const envFile = path.join(dir, "adminbot.env");
  writeFileSync(envFile, "ADMINBOT_SERVICE_TOKEN=synthetic-token\nADMINBOT_PORT=8765\n");
  const result = spawnSync("bash", ["scripts/adminbot-member-map-cron.sh"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ADMINBOT_ENV_FILE: envFile },
  });
  return result;
}

describe("cron wrapper curl failures", () => {
  it("reports a timeout as a slow answer, not an unreachable service", () => {
    const result = runMemberMap(28);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not answer within the time limit");
    expect(result.stderr).not.toContain("could not reach");
  });

  it("still says the service is unreachable when the connection is refused", () => {
    const result = runMemberMap(7);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "member map refresh: could not reach the AdminBot service on 127.0.0.1:8765",
    );
  });

  it("names curl's exit status for any other failure", () => {
    const result = runMemberMap(35);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed (curl exit 35)");
  });

  it("succeeds on a normal answer", () => {
    const result = runMemberMap(0, '{"checked":139,"updated":2}\n200');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("139 member(s) checked, 2 location(s) changed");
  });
});

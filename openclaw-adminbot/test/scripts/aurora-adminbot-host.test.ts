import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const hostScript = path.join(root, "scripts/aurora-adminbot-host.sh");
const installer = path.join(root, "deploy/aurora/install-user-services.sh");

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A throwaway clone with a real `origin` that has moved on without it.
 *
 * The staleness guard is a comparison between two git refs, and the bug it grew was that those
 * refs were read at different moments. Nothing short of actual repositories -- a clone whose
 * `origin/main` is stale on disk until the script fetches -- can tell the fixed ordering from the
 * broken one, so the test builds them rather than asserting on the script's text.
 */
function repositoryBehindOrigin(): { clone: string; behindCommit: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-host-"));
  temporaryDirectories.push(base);
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).trim();

  const origin = path.join(base, "origin.git");
  fs.mkdirSync(origin);
  git(origin, "init", "--bare", "--initial-branch=main", ".");

  const seed = path.join(base, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "--initial-branch=main", ".");
  fs.writeFileSync(path.join(seed, "file"), "one\n");
  git(seed, "add", "file");
  git(seed, "commit", "-m", "one");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  const behindCommit = git(seed, "rev-parse", "HEAD");

  // The deploying clone. It is current at this point and goes stale on the next push.
  const clone = path.join(base, "clone");
  git(base, "clone", "-q", origin, clone);
  fs.mkdirSync(path.join(clone, "scripts"), { recursive: true });
  fs.copyFileSync(hostScript, path.join(clone, "scripts/aurora-adminbot-host.sh"));
  fs.chmodSync(path.join(clone, "scripts/aurora-adminbot-host.sh"), 0o755);

  fs.writeFileSync(path.join(seed, "file"), "two\n");
  git(seed, "commit", "-qam", "two");
  git(seed, "push", "-q", "origin", "main");

  return { clone, behindCommit };
}

/**
 * Run the deploy command with ssh and scp stubbed out, so the run stops at the first remote call
 * instead of reaching for a machine no test can have. Everything under examination happens before
 * that point.
 */
function runDeploy(clone: string, ref: string): { status: number | null; stderr: string } {
  const fakeBin = path.join(clone, "fake-bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const tool of ["ssh", "scp"]) {
    const stub = path.join(fakeBin, tool);
    fs.writeFileSync(stub, "#!/usr/bin/env bash\nexit 42\n");
    fs.chmodSync(stub, 0o755);
  }
  const result = spawnSync(
    "bash",
    [
      path.join(clone, "scripts/aurora-adminbot-host.sh"),
      "--user",
      "someone",
      "--ref",
      ref,
      "deploy",
    ],
    {
      cwd: clone,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` },
    },
  );
  return { status: result.status, stderr: result.stderr ?? "" };
}

describe("Aurora AdminBot hosting", () => {
  it("keeps both shell entrypoints syntactically valid", () => {
    expect(() => execFileSync("bash", ["-n", hostScript, installer])).not.toThrow();
  });

  it("deploys committed revisions and keeps services stopped until explicit start", () => {
    const script = fs.readFileSync(hostScript, "utf8");
    expect(script).toContain('git -C "$REPO_ROOT" archive');
    expect(script).toContain("--no-start");
    expect(script).toContain('-L "${GATEWAY_PORT}:127.0.0.1:${GATEWAY_PORT}"');
    expect(script).toContain('-L "${ADMINBOT_PORT}:127.0.0.1:${ADMINBOT_PORT}"');
  });

  // The guard reads two refs and compares them. Both of these tests exist because it used to read
  // them at different moments, either side of its own fetch.
  describe("the staleness guard", () => {
    it("deploys --ref origin/main from a clone whose origin/main was stale", () => {
      const { clone } = repositoryBehindOrigin();
      const { stderr } = runDeploy(clone, "origin/main");
      // The reported failure, exactly: origin/main refused as behind origin/main, by a count of
      // zero, with the advice to pass the flag that had just been passed.
      expect(stderr).not.toMatch(/behind origin\/main/u);
      expect(stderr).not.toMatch(/0 commit\(s\) behind/u);
      // It got past the guard and stopped at the stubbed ssh, which is as far as a test can go.
      expect(stderr).toMatch(/^deploying /mu);
    });

    it("still refuses a ref that is genuinely behind, and says by how much", () => {
      const { clone, behindCommit } = repositoryBehindOrigin();
      const { status, stderr } = runDeploy(clone, behindCommit);
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/is 1 commit\(s\) behind origin\/main/u);
      // A refusal that cannot name a missing commit is not one anybody can act on.
      expect(stderr).not.toMatch(/is 0 commit\(s\)/u);
      // The advice has to be something other than what the operator already did.
      expect(stderr).toContain("--allow-behind");
    });
  });

  it("can merge Slack secrets without replacing unrelated Aurora secrets", () => {
    const script = fs.readFileSync(hostScript, "utf8");
    expect(script).toContain("sync-slack-env");
    expect(script).toContain("SLACK_BOT_TOKEN is missing or empty");
    expect(script).toContain("SLACK_APP_TOKEN is missing or empty");
    expect(script).toContain("grep -vE '^SLACK_(BOT|APP|USER)_TOKEN='");
    expect(script).toContain("systemctl --user restart jinesis-openclaw-gateway.service");
  });

  it("syncs OpenClaw cron through Gateway RPC and disables the duplicate systemd timer", () => {
    const host = fs.readFileSync(hostScript, "utf8");
    const script = fs.readFileSync(installer, "utf8");
    expect(host).toContain("sync-cron-jobs");
    expect(host).toContain("export-openclaw-cron-jobs.mjs");
    expect(host).toContain("import-openclaw-cron-jobs.mjs");
    expect(host).toContain("cron list --all --json");
    expect(host).toContain("disable --now jinesis-adminbot-email.timer");
    expect(script).toContain("gateway run --bind loopback");
    expect(script).toContain("jinesis-vllm.service");
    expect(script).toContain("disable --now jinesis-adminbot-email.timer");
    expect(script).not.toContain("OnCalendar=hourly");
    expect(script).toContain("grep -q 'REPLACE_ME'");
    expect(script).toContain("gmail labels list");
    expect(script).toContain("ADMINBOT_LOCAL_BASE_URL");
    expect(script).toContain('"${ADMINBOT_LOCAL_BASE_URL%/}/models"');
    expect(script).toContain("Slack is enabled but SLACK_BOT_TOKEN is missing");
    expect(script).toContain("Slack socket mode is enabled but SLACK_APP_TOKEN is missing");
  });
});

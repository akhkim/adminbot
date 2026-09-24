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

  it("builds connect and auth-gog SSH commands with and without sshpass", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-ssh-"));
    temporaryDirectories.push(directory);
    const fakeBin = path.join(directory, "bin");
    fs.mkdirSync(fakeBin);
    for (const [name, source] of [
      ["ssh", "#!/usr/bin/env bash\nprintf 'arg=%s\\n' \"$@\"\n"],
      ["scp", "#!/usr/bin/env bash\nexit 0\n"],
      ["sshpass", '#!/usr/bin/env bash\n[[ "$1" == -e ]] || exit 2\nshift\nexec "$@"\n'],
    ]) {
      const executable = path.join(fakeBin, name);
      fs.writeFileSync(executable, source);
      fs.chmodSync(executable, 0o755);
    }
    for (const password of ["", "fictional-password"]) {
      const run = (command: string) =>
        spawnSync("bash", [hostScript, "--user", "tester", "--host", "example.invalid", command], {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: directory,
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
            AURORA_SSH_PASSWORD: password,
          },
        });
      const tunnel = run("connect");
      expect(tunnel.status, tunnel.stderr).toBe(0);
      expect(tunnel.stdout).toContain("arg=ConnectTimeout=10");
      expect(tunnel.stdout).toContain("arg=18789:127.0.0.1:18789");
      expect(tunnel.stdout).toContain("arg=8765:127.0.0.1:8765");
      expect(tunnel.stdout).toContain("arg=tester@example.invalid");

      const auth = run("auth-gog");
      expect(auth.status, auth.stderr).toBe(0);
      expect(auth.stdout).toContain("arg=-t");
      expect(auth.stdout).toContain("arg=ConnectTimeout=10");
      expect(auth.stdout).toContain("arg=tester@example.invalid");
    }
  });

  it("lets only one deploy hold a root lock and only its owner release it", () => {
    const script = fs.readFileSync(hostScript, "utf8");
    const acquire = script.match(/<<'REMOTE_DEPLOY_LOCK'\n([\s\S]*?)\nREMOTE_DEPLOY_LOCK/u)?.[1];
    const release = script.match(
      /<<'REMOTE_DEPLOY_UNLOCK'\n([\s\S]*?)\nREMOTE_DEPLOY_UNLOCK/u,
    )?.[1];
    expect(acquire).toBeDefined();
    expect(release).toBeDefined();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-lock-"));
    temporaryDirectories.push(directory);
    const base = path.join(directory, "deployment", "root");
    const run = (body: string | undefined, token: string) =>
      spawnSync("bash", ["-s", "--", base, token], {
        input: body,
        encoding: "utf8",
        env: { ...process.env, HOME: directory },
      });

    expect(run(acquire, "first-run").status).toBe(0);
    const competing = run(acquire, "second-run");
    expect(competing.status).not.toBe(0);
    expect(competing.stderr).toContain("another deployment holds this root lock");
    expect(run(release, "second-run").status).not.toBe(0);
    expect(fs.existsSync(path.join(base, ".adminbot-deploy.lock"))).toBe(true);
    expect(run(release, "first-run").status).toBe(0);
    expect(fs.existsSync(path.join(base, ".adminbot-deploy.lock"))).toBe(false);
  });

  it("requires an operator quiescence attestation before seeding", () => {
    const result = spawnSync(
      "bash",
      [hostScript, "--user", "tester", "--seed-state", "/synthetic/source", "deploy"],
      { encoding: "utf8", env: { ...process.env, AURORA_SSH_PASSWORD: "" } },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--seed-state requires --confirm-source-quiesced");
  });

  it("refuses missing, incomplete, or network-mounted state before stopping services", () => {
    const script = fs.readFileSync(hostScript, "utf8");
    const remote = script.match(/<<'REMOTE_CLEAN'\n([\s\S]*?)\nREMOTE_CLEAN/u)?.[1];
    expect(remote).toBeDefined();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-state-"));
    temporaryDirectories.push(directory);
    const base = path.join(directory, "deployment", "root");
    const state = path.join(base, "state");
    const fakeBin = path.join(directory, "bin");
    fs.mkdirSync(fakeBin);
    const serviceCalled = path.join(directory, "systemctl-called");
    const systemctl = path.join(fakeBin, "systemctl");
    fs.writeFileSync(systemctl, '#!/usr/bin/env bash\ntouch "$SYSTEMCTL_CALLED"\nexit 99\n');
    fs.chmodSync(systemctl, 0o755);
    const stat = path.join(fakeBin, "stat");
    fs.writeFileSync(
      stat,
      '#!/usr/bin/env bash\nif [[ "$1" == -f ]]; then echo nfs; else /usr/bin/stat "$@"; fi\n',
    );
    fs.chmodSync(stat, 0o755);
    const run = (seed: string, initialize: string) =>
      spawnSync(
        "bash",
        ["-s", "--", base, path.join(base, "current"), "3", state, `seed=${seed}`, initialize],
        {
          input: remote,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: directory,
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
            SYSTEMCTL_CALLED: serviceCalled,
          },
        },
      );

    const missing = run("", "0");
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("missing state requires --seed-state or --init-empty-state");
    expect(fs.existsSync(serviceCalled)).toBe(false);

    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, ".adminbot-seed-pending"), "pending");
    const incomplete = run("", "0");
    expect(incomplete.status).not.toBe(0);
    expect(incomplete.stderr).toContain("incomplete seed needs operator review");
    expect(fs.existsSync(serviceCalled)).toBe(false);

    fs.rmSync(state, { recursive: true });
    const network = run("", "1");
    expect(network.status).not.toBe(0);
    expect(network.stderr).toContain("unsupported nfs filesystem");
    expect(fs.existsSync(serviceCalled)).toBe(false);

    fs.mkdirSync(state);
    const mountedState = run("", "1");
    expect(mountedState.status).not.toBe(0);
    expect(mountedState.stderr).toContain("unsupported nfs filesystem");
    expect(fs.existsSync(serviceCalled)).toBe(false);

    fs.writeFileSync(path.join(state, "adminbot.sqlite"), "synthetic fixture");
    const collision = run("/synthetic/source", "0");
    expect(collision.status).not.toBe(0);
    expect(collision.stderr).toContain("target state already exists");
    expect(fs.existsSync(serviceCalled)).toBe(false);

    const existingNetworkState = run("", "0");
    expect(existingNetworkState.status).not.toBe(0);
    expect(existingNetworkState.stderr).toContain("unsupported nfs filesystem");
    expect(fs.existsSync(serviceCalled)).toBe(false);
  });

  it("does not switch the release before a verified SQLite snapshot", () => {
    const script = fs.readFileSync(hostScript, "utf8");
    const snapshot = script.indexOf('node "$release/scripts/snapshot-sqlite.mjs"');
    const switchRelease = script.indexOf('mv -Tf -- "$next_current" "$current"');
    const recheck = script.indexOf("target state appeared during the build");
    expect(snapshot).toBeGreaterThan(0);
    expect(switchRelease).toBeGreaterThan(snapshot);
    expect(recheck).toBeGreaterThan(0);
    expect(recheck).toBeLessThan(snapshot);
    expect(script).toContain('mv -Tn -- "$stage" "$state_dir"');
    expect(script.indexOf("<<'REMOTE_SPACE'")).toBeLessThan(script.indexOf("<<'REMOTE_CLEAN'"));
    expect(script.indexOf("<<'REMOTE_DEPLOY_LOCK'")).toBeLessThan(
      script.indexOf("<<'REMOTE_CLEAN'"),
    );
    expect(script.indexOf("trap cleanup_deploy EXIT")).toBeLessThan(
      script.indexOf("<<'REMOTE_DEPLOY_LOCK'"),
    );
    expect(script).toContain('remote_lock_token="$new_lock_token"');
    expect(script.indexOf('rm -- "$pending_marker"')).toBeGreaterThan(switchRelease);
    expect(script).toContain("--verify");
    expect(script).not.toContain('cp -a -- "$entry" "$state_dir/"');
    expect(script).toContain("trap restore_units_on_failure EXIT");
    expect(script).toContain("jinesis-adminbot-openreview.service");
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

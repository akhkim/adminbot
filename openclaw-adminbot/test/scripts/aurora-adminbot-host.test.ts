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
    expect(script.match(/--writer-lock-token/g)).toHaveLength(3);
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

  it("serializes writer operations across roots and releases only the owner's lock", () => {
    const script = fs.readFileSync(hostScript, "utf8");
    const acquire = script.match(/<<'REMOTE_DEPLOY_LOCK'\n([\s\S]*?)\nREMOTE_DEPLOY_LOCK/u)?.[1];
    const release = script.match(
      /<<'REMOTE_DEPLOY_UNLOCK'\n([\s\S]*?)\nREMOTE_DEPLOY_UNLOCK/u,
    )?.[1];
    expect(acquire).toBeDefined();
    expect(release).toBeDefined();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-lock-"));
    temporaryDirectories.push(directory);
    const lock = path.join(directory, ".config/jinesis-adminbot/.writer.lock");
    const run = (body: string | undefined, rootName: string, token: string) =>
      spawnSync("bash", ["-s", "--", path.join(directory, rootName), token], {
        input: body,
        encoding: "utf8",
        env: { ...process.env, HOME: directory },
      });

    expect(run(acquire, "first-root", "first-run").status).toBe(0);
    const competing = run(acquire, "second-root", "second-run");
    expect(competing.status).not.toBe(0);
    expect(competing.stderr).toContain("another AdminBot writer operation holds the account lock");
    expect(run(release, "second-root", "second-run").status).not.toBe(0);
    expect(fs.existsSync(lock)).toBe(true);
    expect(run(release, "first-root", "first-run").status).toBe(0);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("blocks start, restart, and database sync while another writer owns the lock", () => {
    const script = fs.readFileSync(hostScript, "utf8");
    const acquire = script.match(/<<'REMOTE_DEPLOY_LOCK'\n([\s\S]*?)\nREMOTE_DEPLOY_LOCK/u)?.[1];
    const release = script.match(
      /<<'REMOTE_DEPLOY_UNLOCK'\n([\s\S]*?)\nREMOTE_DEPLOY_UNLOCK/u,
    )?.[1];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-writer-lock-"));
    temporaryDirectories.push(directory);
    const fakeBin = path.join(directory, "bin");
    fs.mkdirSync(fakeBin);
    const ssh = path.join(fakeBin, "ssh");
    fs.writeFileSync(
      ssh,
      '#!/usr/bin/env bash\n[[ "$1" == -o ]] || exit 2\nshift 2\nshift\nexec "$@"\n',
    );
    fs.chmodSync(ssh, 0o755);
    const env = {
      ...process.env,
      HOME: directory,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      AURORA_SSH_PASSWORD: "",
    };
    const runLock = (body: string | undefined) =>
      spawnSync("bash", ["-s", "--", "/synthetic/root", "owner"], {
        input: body,
        encoding: "utf8",
        env,
      });
    expect(runLock(acquire).status).toBe(0);
    for (const args of [
      ["start"],
      ["restart"],
      ["--confirm-db-replacement", "--confirm-source-quiesced", "sync-adminbot-data"],
    ]) {
      const result = spawnSync("bash", [hostScript, "--user", "tester", ...args], {
        encoding: "utf8",
        env,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("another AdminBot writer operation holds the account lock");
    }
    expect(runLock(release).status).toBe(0);
  });

  it("refuses to rewrite units for another root while a managed writer is active", () => {
    const host = fs.readFileSync(hostScript, "utf8");
    const installerSource = fs.readFileSync(installer, "utf8");
    const firstUnitWrite = installerSource.indexOf('cat >"$UNIT_DIR/jinesis-ollama.service"');
    expect(installerSource.lastIndexOf("assert_writers_stopped", firstUnitWrite)).toBeGreaterThan(
      installerSource.indexOf('chmod 600 "$ENV_FILE"'),
    );
    const writerGuard = host.match(
      /<<'REMOTE_WRITERS_STOPPED'\n([\s\S]*?)\nREMOTE_WRITERS_STOPPED/u,
    )?.[1];
    expect(writerGuard).toBeDefined();
    for (const command of ["install-services", "start"]) {
      const start = host.indexOf(`\n  ${command})`);
      const branch = host.slice(start, host.indexOf("    ;;", start));
      expect(branch.indexOf("assert_remote_writers_stopped")).toBeGreaterThan(0);
      expect(branch.indexOf("assert_remote_writers_stopped")).toBeLessThan(
        branch.indexOf("$(remote_install_script)"),
      );
    }

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-active-units-"));
    temporaryDirectories.push(directory);
    const requestedRoot = path.join(directory, "new-release");
    const fakeBin = path.join(directory, "bin");
    fs.mkdirSync(requestedRoot);
    fs.mkdirSync(fakeBin);
    const systemctl = path.join(fakeBin, "systemctl");
    const readlink = path.join(fakeBin, "readlink");
    fs.writeFileSync(
      systemctl,
      '#!/usr/bin/env bash\nif [[ "$2" == show-environment ]]; then exit 0; fi\nif [[ "$2" == show ]]; then if [[ "$3" == jinesis-adminbot.service ]]; then echo active; else echo inactive; fi; exit 0; fi\nexit 2\n',
    );
    fs.writeFileSync(
      readlink,
      '#!/usr/bin/env bash\n[[ "$1" == -f ]] || exit 2\ncd "$2" && pwd -P\n',
    );
    fs.chmodSync(systemctl, 0o755);
    fs.chmodSync(readlink, 0o755);
    const env = {
      ...process.env,
      HOME: directory,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    const guardResult = spawnSync("bash", ["-s"], { input: writerGuard, encoding: "utf8", env });
    expect(guardResult.status).not.toBe(0);
    expect(guardResult.stderr).toContain("jinesis-adminbot.service is active");

    const installResult = spawnSync(
      "bash",
      [installer, "--root", requestedRoot, "--state", path.join(requestedRoot, "state")],
      { encoding: "utf8", env },
    );
    expect(installResult.status).not.toBe(0);
    expect(installResult.stderr).toContain("jinesis-adminbot.service is active");
    expect(
      fs.existsSync(path.join(directory, ".config/systemd/user/jinesis-adminbot.service")),
    ).toBe(false);
    expect(fs.existsSync(path.join(directory, ".config/jinesis-adminbot/.writer.lock"))).toBe(
      false,
    );

    const lock = path.join(directory, ".config/jinesis-adminbot/.writer.lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), "parent-run\n");
    const nested = spawnSync(
      "bash",
      [installer, "--root", requestedRoot, "--writer-lock-token", "parent-run"],
      { encoding: "utf8", env },
    );
    expect(nested.stderr).toContain("jinesis-adminbot.service is active");
    expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe("parent-run\n");
    const forged = spawnSync(
      "bash",
      [installer, "--root", requestedRoot, "--writer-lock-token", "other-run"],
      { encoding: "utf8", env },
    );
    expect(forged.stderr).toContain("installer does not own the AdminBot writer lock");
    expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe("parent-run\n");
  });

  it("keeps direct installation locked after checking units so a concurrent start cannot pass", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-install-race-"));
    temporaryDirectories.push(directory);
    const release = path.join(directory, "release");
    const bin = path.join(directory, "bin");
    const unitDir = path.join(directory, ".config/systemd/user");
    const fifo = path.join(unitDir, "jinesis-ollama.service");
    fs.mkdirSync(path.join(release, "node_modules/.bin"), { recursive: true });
    fs.mkdirSync(path.join(release, "dist"));
    fs.mkdirSync(path.join(release, "deploy/aurora"), { recursive: true });
    fs.mkdirSync(bin);
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(release, "dist/entry.js"), "");
    fs.writeFileSync(path.join(release, "deploy/aurora/adminbot.env.example"), "TEST=1\n");
    for (const file of [
      path.join(release, "node_modules/.bin/tsx"),
      path.join(release, "deploy/aurora/install-member-sheet-poller.sh"),
    ]) {
      fs.writeFileSync(file, "#!/usr/bin/env bash\nexit 0\n");
      fs.chmodSync(file, 0o755);
    }
    execFileSync("mkfifo", [fifo]);
    const stubs: Record<string, string> = {
      systemctl:
        '#!/usr/bin/env bash\nif [[ "$2" == show-environment ]]; then exit 0; fi\nif [[ "$2" == show ]]; then\n  if [[ "$3" == jinesis-adminbot.service ]]; then\n    count=$(cat "$SHOW_COUNT" 2>/dev/null || echo 0)\n    count=$((count + 1))\n    echo "$count" >"$SHOW_COUNT"\n    if ((count == 2)); then touch "$AFTER_CHECK"; fi\n  fi\n  echo inactive\n  exit 0\nfi\nexit 0\n',
      readlink: '#!/usr/bin/env bash\n[[ "$1" == -f ]] || exit 2\ncd "$2" && pwd -P\n',
      ssh: '#!/usr/bin/env bash\n[[ "$1" == -o ]] || exit 2\nshift 2\nshift\nexec "$@"\n',
      python3: "#!/usr/bin/env bash\nexit 0\n",
      loginctl: "#!/usr/bin/env bash\necho Linger=yes\n",
    };
    for (const [name, source] of Object.entries(stubs)) {
      const file = path.join(bin, name);
      fs.writeFileSync(file, source);
      fs.chmodSync(file, 0o755);
    }
    const harness = path.join(directory, "race.sh");
    fs.writeFileSync(
      harness,
      '#!/usr/bin/env bash\nset -u\nbash "$INSTALLER" --root "$RELEASE" --state "$RELEASE/state" --no-start >"$WORK/installer.out" 2>&1 &\ninstaller_pid=$!\nfor ((i=0; i<200; i++)); do\n  [[ -f "$AFTER_CHECK" ]] && break\n  sleep 0.02\ndone\n[[ -f "$AFTER_CHECK" ]] || { kill "$installer_pid" 2>/dev/null || true; exit 70; }\nbash "$HOST_SCRIPT" --user tester --host example.invalid start >"$WORK/start.out" 2>&1\necho "$?" >"$WORK/start.code"\ncat <"$FIFO" >/dev/null &\nwait "$installer_pid"\n',
    );
    const result = spawnSync("bash", [harness], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        HOME: directory,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        WORK: directory,
        RELEASE: release,
        FIFO: fifo,
        INSTALLER: installer,
        HOST_SCRIPT: hostScript,
        SHOW_COUNT: path.join(directory, "show-count"),
        AFTER_CHECK: path.join(directory, "after-check"),
        AURORA_SSH_PASSWORD: "",
      },
    });
    expect(result.status, fs.readFileSync(path.join(directory, "installer.out"), "utf8")).toBe(0);
    expect(Number(fs.readFileSync(path.join(directory, "start.code"), "utf8"))).not.toBe(0);
    expect(fs.readFileSync(path.join(directory, "start.out"), "utf8")).toContain(
      "another AdminBot writer operation holds the account lock",
    );
    expect(fs.existsSync(path.join(directory, ".config/jinesis-adminbot/.writer.lock"))).toBe(
      false,
    );
  }, 20_000);

  it("requires an authoritative, quiescent source before attempting database sync", () => {
    const result = spawnSync(
      "bash",
      [hostScript, "--user", "tester", "sync-adminbot-data", "/synthetic/source.sqlite"],
      { encoding: "utf8", env: { ...process.env, AURORA_SSH_PASSWORD: "" } },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "sync-adminbot-data requires --confirm-db-replacement and --confirm-source-quiesced",
    );
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
    const archive = script.indexOf('archive="$(mktemp');
    expect(script.indexOf("trap cleanup_mutation EXIT", archive)).toBeLessThan(
      script.indexOf("    acquire_writer_lock", archive),
    );
    expect(script).toContain('remote_lock_token="$new_lock_token"');
    expect(script.indexOf('rm -- "$pending_marker"')).toBeGreaterThan(switchRelease);
    expect(script).toContain("--verify");
    expect(script).not.toContain('cp -a -- "$entry" "$state_dir/"');
    expect(script).toContain("trap restore_units_on_failure EXIT");
    expect(script).toContain("jinesis-adminbot-openreview.service");
  });

  it("refuses a database replacement on network storage before stopping writers", () => {
    const script = fs.readFileSync(hostScript, "utf8");
    const prepare = script.match(
      /<<'REMOTE_ADMINBOT_PREPARE'\n([\s\S]*?)\nREMOTE_ADMINBOT_PREPARE/u,
    )?.[1];
    expect(prepare).toBeDefined();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-db-sync-"));
    temporaryDirectories.push(directory);
    const state = path.join(directory, "state");
    const fakeBin = path.join(directory, "bin");
    const called = path.join(directory, "systemctl-called");
    fs.mkdirSync(state);
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(state, "adminbot.sqlite"), "synthetic fixture");
    fs.writeFileSync(path.join(fakeBin, "stat"), "#!/usr/bin/env bash\necho nfs\n");
    fs.writeFileSync(
      path.join(fakeBin, "systemctl"),
      '#!/usr/bin/env bash\ntouch "$SYSTEMCTL_CALLED"\nexit 0\n',
    );
    fs.chmodSync(path.join(fakeBin, "stat"), 0o755);
    fs.chmodSync(path.join(fakeBin, "systemctl"), 0o755);
    const result = spawnSync("bash", ["-s", "--", state], {
      input: prepare,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        SYSTEMCTL_CALLED: called,
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported nfs filesystem");
    expect(fs.existsSync(called)).toBe(false);
  });

  it("refuses writer startup for a symlinked or separately network-mounted database", () => {
    const script = fs.readFileSync(hostScript, "utf8");
    const ready = script.match(/<<'REMOTE_STATE_READY'\n([\s\S]*?)\nREMOTE_STATE_READY/u)?.[1];
    expect(ready).toBeDefined();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-state-ready-"));
    temporaryDirectories.push(directory);
    const state = path.join(directory, "state");
    const bin = path.join(directory, "bin");
    fs.mkdirSync(state);
    fs.mkdirSync(bin);
    const database = path.join(state, "adminbot.sqlite");
    fs.writeFileSync(database, "synthetic fixture");
    const stat = path.join(bin, "stat");
    fs.writeFileSync(
      stat,
      '#!/usr/bin/env bash\nif [[ "$1" == -f ]]; then if [[ "$5" == *.sqlite ]]; then echo nfs; else echo ext4; fi; else /usr/bin/stat "$@"; fi\n',
    );
    fs.chmodSync(stat, 0o755);
    const run = () =>
      spawnSync("bash", ["-s", "--", state], {
        input: ready,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      });
    const networkFile = run();
    expect(networkFile.status).not.toBe(0);
    expect(networkFile.stderr).toContain("unsupported nfs filesystem");

    fs.rmSync(database);
    const source = path.join(directory, "source.sqlite");
    fs.writeFileSync(source, "synthetic fixture");
    fs.symlinkSync(source, database);
    const symlinkFile = run();
    expect(symlinkFile.status).not.toBe(0);
    expect(symlinkFile.stderr).toContain("AdminBot state is missing");
  });

  it("refuses to restart units from a different deployment root", () => {
    const script = fs.readFileSync(hostScript, "utf8");
    const verify = script.match(
      /<<'REMOTE_UNITS_MATCH_ROOT'\n([\s\S]*?)\nREMOTE_UNITS_MATCH_ROOT/u,
    )?.[1];
    expect(verify).toBeDefined();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-unit-root-"));
    temporaryDirectories.push(directory);
    const release = path.join(directory, "release");
    const current = path.join(directory, "current");
    const bin = path.join(directory, "bin");
    fs.mkdirSync(release);
    fs.mkdirSync(bin);
    fs.symlinkSync(release, current);
    const systemctl = path.join(bin, "systemctl");
    const readlink = path.join(bin, "readlink");
    fs.writeFileSync(systemctl, '#!/usr/bin/env bash\necho "$UNIT_ROOT"\n');
    fs.writeFileSync(
      readlink,
      '#!/usr/bin/env bash\n[[ "$1" == -f && "$2" == -- ]] || exit 2\ncd "$3" && pwd -P\n',
    );
    fs.chmodSync(systemctl, 0o755);
    fs.chmodSync(readlink, 0o755);
    const run = (unitRoot: string) =>
      spawnSync("bash", ["-s", "--", current], {
        input: verify,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          UNIT_ROOT: unitRoot,
        },
      });
    const matchingRoot = run(fs.realpathSync(release));
    expect(matchingRoot.status, matchingRoot.stderr).toBe(0);
    const wrongRoot = run(path.join(directory, "other-release"));
    expect(wrongRoot.status).not.toBe(0);
    expect(wrongRoot.stderr).toContain("points to a different release");
    expect(script).toContain("assert_remote_units_match_root");
  });

  it("backs up and replaces only verified SQLite snapshots while all managed writers are stopped", () => {
    const script = fs.readFileSync(hostScript, "utf8");
    const prepare = script.match(
      /<<'REMOTE_ADMINBOT_PREPARE'\n([\s\S]*?)\nREMOTE_ADMINBOT_PREPARE/u,
    )?.[1];
    const replace = script.match(
      /<<'REMOTE_ADMINBOT_DATA'\n([\s\S]*?)\nREMOTE_ADMINBOT_DATA/u,
    )?.[1];
    expect(prepare).toBeDefined();
    expect(replace).toBeDefined();
    expect(prepare).toContain("systemctl --user stop");
    for (const unit of [
      "jinesis-adminbot-sheet-poller.timer",
      "jinesis-adminbot-email.timer",
      "jinesis-adminbot-openreview.timer",
      "jinesis-openclaw-gateway.service",
      "jinesis-adminbot.service",
    ]) {
      expect(prepare).toContain(unit);
      expect(replace).toContain(unit);
    }
    expect(script).toContain(
      'node "$snapshot_helper" "$local_database" "$database_snapshot" --verify',
    );
    expect(replace).toContain('node "$helper" "$database" "$backup" --verify');
    expect(replace).toContain('node "$helper" "$upload" "$database_new" --verify');
    expect(replace).toContain('mv -f -- "$database_new" "$database"');
    expect(replace).toContain(".adminbot-sync-pending");
    expect(replace).toContain('retired_sidecars="${database}.retired-sidecars-${token}"');
    expect(replace).not.toContain('mv -- "${database}${suffix}" "${backup}${suffix}"');
    expect(replace).not.toContain('mv -- "${retired_sidecars}.${suffix}" "${database}-${suffix}"');
    expect(script).not.toContain('cp -p "$REMOTE_STATE/adminbot.sqlite"');
    expect(script).not.toContain('rm -f "$REMOTE_STATE/adminbot.sqlite-wal"');
    expect(script).toContain("assert_remote_state_ready");
  });

  it("replaces a synthetic database with a verified snapshot and retains the old data", () => {
    const script = fs.readFileSync(hostScript, "utf8");
    const replace = script.match(
      /<<'REMOTE_ADMINBOT_DATA'\n([\s\S]*?)\nREMOTE_ADMINBOT_DATA/u,
    )?.[1];
    expect(replace).toBeDefined();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-db-replace-"));
    temporaryDirectories.push(directory);
    const bin = path.join(directory, "bin");
    fs.mkdirSync(bin);
    const systemctl = path.join(bin, "systemctl");
    const stat = path.join(bin, "stat");
    const mv = path.join(bin, "mv");
    fs.writeFileSync(
      systemctl,
      '#!/usr/bin/env bash\n[[ "$1" == --user && "$2" == show ]] || exit 2\necho "${SYSTEMCTL_STATE:-inactive}"\n',
    );
    fs.writeFileSync(
      stat,
      '#!/usr/bin/env bash\nif [[ "$1" == -f ]]; then echo ext4; else /usr/bin/stat "$@"; fi\n',
    );
    fs.writeFileSync(
      mv,
      '#!/usr/bin/env bash\nif [[ "$FAIL_MAIN_RENAME" == 1 && "$1" == -f && "$3" == *.new-* ]]; then exit 71; fi\nexec /bin/mv "$@"\n',
    );
    fs.chmodSync(systemctl, 0o755);
    fs.chmodSync(stat, 0o755);
    fs.chmodSync(mv, 0o755);
    const database = path.join(directory, "adminbot.sqlite");
    const upload = path.join(directory, "upload.sqlite");
    const create = (file: string, value: string) =>
      execFileSync(process.execPath, [
        "-e",
        "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('CREATE TABLE record (value TEXT)'); db.prepare('INSERT INTO record VALUES (?)').run(process.argv[2]); db.close();",
        file,
        value,
      ]);
    const read = (file: string) =>
      execFileSync(
        process.execPath,
        [
          "-e",
          "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare('SELECT value FROM record').get().value); db.close();",
          file,
        ],
        { encoding: "utf8" },
      ).trim();
    create(database, "previous");
    create(upload, "replacement");
    const run = (state: string, token: string, failMainRename = false) =>
      spawnSync(
        "bash",
        ["-s", "--", upload, database, path.join(root, "scripts/snapshot-sqlite.mjs"), token],
        {
          input: replace,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            SYSTEMCTL_STATE: state,
            FAIL_MAIN_RENAME: failMainRename ? "1" : "0",
          },
        },
      );

    const active = run("active", "active");
    expect(active.status).not.toBe(0);
    expect(active.stderr).toContain("restarted during snapshot");
    expect(read(database)).toBe("previous");
    expect(fs.existsSync(path.join(directory, ".adminbot-sync-pending"))).toBe(false);
    create(upload, "replacement");

    const interrupted = run("inactive", "interrupted", true);
    expect(interrupted.status).not.toBe(0);
    expect(read(database)).toBe("previous");
    expect(read(`${database}.backup-interrupted`)).toBe("previous");
    expect(fs.existsSync(path.join(directory, ".adminbot-sync-pending"))).toBe(true);
    fs.rmSync(path.join(directory, ".adminbot-sync-pending"));
    create(upload, "replacement");

    const completed = run("inactive", "fixture");
    expect(completed.status, completed.stderr).toBe(0);
    expect(read(database)).toBe("replacement");
    expect(read(`${database}.backup-fixture`)).toBe("previous");
    expect(fs.existsSync(path.join(directory, ".adminbot-sync-pending"))).toBe(false);
    expect(fs.existsSync(upload)).toBe(false);
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

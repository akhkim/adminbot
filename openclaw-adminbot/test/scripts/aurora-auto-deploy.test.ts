// Aurora's push-to-deploy: the runner guard admits only the deploy workflow on main, and the
// deploy itself refuses anything that is not a step forward from what is live.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const deployScript = path.join(process.cwd(), "deploy/aurora/auto-deploy.sh");
const guardScript = path.join(process.cwd(), "deploy/aurora/runner-job-guard.sh");
const installerScript = path.join(process.cwd(), "deploy/aurora/install-actions-runner.sh");
const workflow = fs.readFileSync(
  path.join(process.cwd(), "../.github/workflows/deploy-aurora.yaml"),
  "utf8",
);

const RELEASE_UNITS = [
  "jinesis-adminbot.service",
  "jinesis-openclaw-gateway.service",
  "jinesis-adminbot-email.service",
  "jinesis-adminbot-sheet-poller.service",
];

const temps: string[] = [];
afterEach(() => {
  for (const temp of temps.splice(0)) {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function write(file: string, content: string, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(repo: string, message: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    write(path.join(repo, name), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

// A repository with a live commit, a child of it (the normal deploy target), and a sibling of that
// child; a deployment root whose live release is the first; and a HOME whose
// ~/.local/bin (which the script puts first on PATH) holds fakes for systemctl, corepack and curl.
function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-auto-deploy-"));
  temps.push(temp);
  const repo = path.join(temp, "repo");
  const home = path.join(temp, "home");
  const root = path.join(temp, "w", "adminbot");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Test");
  const installers = {
    "openclaw-adminbot/deploy/aurora/install-user-services.sh": "units v1\n",
    "openclaw-adminbot/deploy/aurora/install-member-sheet-poller.sh": "poller v1\n",
  };
  const live = commit(repo, "live", { ...installers, "openclaw-adminbot/app.txt": "live\n" });
  const next = commit(repo, "next", { "openclaw-adminbot/app.txt": "next\n" });
  git(repo, "checkout", "-q", "-b", "side", live);
  const diverged = commit(repo, "diverged", { "openclaw-adminbot/app.txt": "side\n" });
  git(repo, "checkout", "-q", "main");

  const liveRelease = path.join(root, "releases", `${live.slice(0, 12)}-20260101T000000Z`);
  for (const [name, content] of Object.entries(installers)) {
    write(path.join(liveRelease, name.replace("openclaw-adminbot/", "")), content);
  }
  write(path.join(liveRelease, "node_modules/.bin/tsx"), "#!/bin/sh\n", 0o755);
  write(path.join(root, "state/adminbot.sqlite"), "synthetic\n");
  fs.symlinkSync(liveRelease, path.join(root, "current"));

  for (const unit of RELEASE_UNITS) {
    write(
      path.join(home, ".config/systemd/user", unit),
      `[Service]\nWorkingDirectory=${liveRelease}\nExecStart=/bin/node ${liveRelease}/start.mjs\n`,
    );
  }
  const bin = path.join(home, ".local/bin");
  write(
    path.join(bin, "systemctl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$HOME/systemctl.log"
if [[ "$2" == show ]]; then
  sed -n 's/^WorkingDirectory=//p' "$HOME/.config/systemd/user/$3"
fi
exit 0
`,
    0o755,
  );
  write(
    path.join(bin, "corepack"),
    `#!/usr/bin/env bash
[[ -z "\${FAKE_BUILD_FAILS:-}" ]] || exit 1
if [[ "$2" == install ]]; then mkdir -p node_modules/.bin && printf '#!/bin/sh\\n' >node_modules/.bin/tsx && chmod +x node_modules/.bin/tsx; fi
if [[ "$2" == build ]]; then mkdir -p dist && : >dist/entry.js; fi
`,
    0o755,
  );
  // A release whose name starts with FAKE_UNHEALTHY_PREFIX answers 500 everywhere.
  write(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
url="\${@: -1}"
live="$(basename "$(readlink -f "$FAKE_ROOT/current")")"
if [[ -n "\${FAKE_UNHEALTHY_PREFIX:-}" && "$live" == "$FAKE_UNHEALTHY_PREFIX"* ]]; then printf 500; exit 0; fi
case "$url" in */lab/members) printf 401 ;; *) printf 200 ;; esac
`,
    0o755,
  );
  return { temp, repo, home, root, live, next, diverged, liveRelease };
}

type Fixture = ReturnType<typeof fixture>;

function deploy(f: Fixture, ref: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [deployScript, "--source", f.repo, "--ref", ref], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: f.home,
      AURORA_DEPLOY_ROOT: f.root,
      AURORA_DEPLOY_HEALTH_TIMEOUT: "1",
      AURORA_DEPLOY_HEALTH_INTERVAL: "0",
      FAKE_ROOT: f.root,
      ...env,
    },
  });
}

const current = (f: Fixture) => fs.readlinkSync(path.join(f.root, "current"));
const unit = (f: Fixture, name: string) =>
  fs.readFileSync(path.join(f.home, ".config/systemd/user", name), "utf8");
const lockHeld = (f: Fixture) =>
  fs.existsSync(path.join(f.home, ".config/jinesis-adminbot/.writer.lock"));

describe("Aurora auto-deploy", () => {
  it("is valid, executable Bash", () => {
    for (const script of [deployScript, guardScript, installerScript]) {
      expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
      expect(fs.statSync(script).mode & 0o111).not.toBe(0);
    }
  });

  it("builds beside the live release, swaps every unit to it, and keeps the old one", () => {
    const f = fixture();
    const result = deploy(f, f.next);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const release = current(f);
    expect(path.basename(release)).toMatch(new RegExp(`^${f.next.slice(0, 12)}-`));
    expect(fs.readFileSync(path.join(release, "app.txt"), "utf8")).toBe("next\n");
    expect(fs.readlinkSync(path.join(release, "state"))).toBe(path.join(f.root, "state"));
    for (const name of RELEASE_UNITS) {
      expect(unit(f, name)).toContain(`WorkingDirectory=${release}\n`);
      expect(unit(f, name)).not.toContain(f.liveRelease);
    }
    expect(fs.existsSync(f.liveRelease)).toBe(true);
    expect(lockHeld(f)).toBe(false);
    const log = fs.readFileSync(path.join(f.home, "systemctl.log"), "utf8");
    expect(log).toContain("--user stop jinesis-openclaw-gateway.service jinesis-adminbot.service");
    expect(log).toContain("--user start jinesis-adminbot.service jinesis-openclaw-gateway.service");
  });

  it("rolls back to the previous release when the new one is unhealthy", () => {
    const f = fixture();
    const before = unit(f, "jinesis-adminbot.service");
    const result = deploy(f, f.next, { FAKE_UNHEALTHY_PREFIX: f.next.slice(0, 12) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("rolled back to");
    expect(fs.realpathSync(current(f))).toBe(fs.realpathSync(f.liveRelease));
    expect(unit(f, "jinesis-adminbot.service")).toBe(before);
    expect(lockHeld(f)).toBe(false);
  });

  it("leaves the services alone when the build fails", () => {
    const f = fixture();
    const result = deploy(f, f.next, { FAKE_BUILD_FAILS: "1" });
    expect(result.status).not.toBe(0);
    expect(current(f)).toBe(f.liveRelease);
    expect(fs.existsSync(path.join(f.home, "systemctl.log"))).toBe(true);
    expect(fs.readFileSync(path.join(f.home, "systemctl.log"), "utf8")).not.toMatch(/stop|start/);
    expect(fs.readdirSync(path.join(f.root, "releases"))).toEqual([path.basename(f.liveRelease)]);
    expect(lockHeld(f)).toBe(false);
  });

  it("does nothing when the target is already live, or already contained in it", () => {
    const f = fixture();
    const same = deploy(f, f.live);
    expect(same.status).toBe(0);
    expect(same.stdout).toContain("already live");

    expect(deploy(f, f.next).status).toBe(0);
    const late = deploy(f, f.live);
    expect(late.status).toBe(0);
    expect(late.stdout).toContain("skipping");
    expect(path.basename(current(f))).toMatch(new RegExp(`^${f.next.slice(0, 12)}-`));
  });

  it("refuses a target that does not contain the live commit", () => {
    // `next` goes live (as a deploy branch would), then main's sibling of it arrives.
    const f = fixture();
    expect(deploy(f, f.next).status).toBe(0);
    const deployed = current(f);
    const result = deploy(f, f.diverged);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not contain the live commit");
    expect(current(f)).toBe(deployed);
  });

  it("refuses when the live commit is unknown to the checkout", () => {
    const f = fixture();
    const unknown = path.join(f.root, "releases", "0123456789ab-20260101T000000Z");
    fs.renameSync(f.liveRelease, unknown);
    fs.rmSync(path.join(f.root, "current"));
    fs.symlinkSync(unknown, path.join(f.root, "current"));
    for (const name of RELEASE_UNITS) {
      const file = path.join(f.home, ".config/systemd/user", name);
      fs.writeFileSync(file, unit(f, name).replaceAll(f.liveRelease, unknown));
    }
    const result = deploy(f, f.next);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not in this checkout's history");
  });

  it("refuses a release that changes how the units are generated", () => {
    const f = fixture();
    const changed = commit(f.repo, "units", {
      "openclaw-adminbot/deploy/aurora/install-user-services.sh": "units v2\n",
    });
    const result = deploy(f, changed);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("install-user-services.sh changed");
    expect(current(f)).toBe(f.liveRelease);
  });

  it("refuses when a unit runs from somewhere other than the live release", () => {
    const f = fixture();
    const file = path.join(f.home, ".config/systemd/user/jinesis-openclaw-gateway.service");
    fs.writeFileSync(file, "[Service]\nWorkingDirectory=/elsewhere\n");
    const result = deploy(f, f.next);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not the live release");
  });

  it("refuses network-filesystem state unless the host opted in", () => {
    const f = fixture();
    write(
      path.join(f.home, ".local/bin/stat"),
      `#!/usr/bin/env bash\nif [[ "$1" == -f ]]; then echo nfs; else exec /usr/bin/stat "$@"; fi\n`,
      0o755,
    );
    const refused = deploy(f, f.next);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("SQLite state is on nfs");
    expect(deploy(f, f.next, { AURORA_ACCEPT_NETWORK_STATE: "1" }).status).toBe(0);
  });

  it("refuses while another writer operation holds the account lock", () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.home, ".config/jinesis-adminbot/.writer.lock"), { recursive: true });
    const result = deploy(f, f.next);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("holds the account lock");
    expect(lockHeld(f)).toBe(true);
  });

  it("has no default deployment root", () => {
    const f = fixture();
    const result = deploy(f, f.next, { AURORA_DEPLOY_ROOT: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("AURORA_DEPLOY_ROOT");
  });
});

describe("Aurora runner job guard", () => {
  const allowedRef = "lab/adminbot/.github/workflows/deploy-aurora.yaml@refs/heads/main";

  function guard(env: Record<string, string>, installed = true) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-guard-"));
    temps.push(temp);
    const hook = path.join(temp, "job-started.sh");
    let source = fs.readFileSync(guardScript, "utf8");
    if (installed) {
      source = source
        .replace("__ALLOWED_REPOSITORY__", "lab/adminbot")
        .replace("__ALLOWED_WORKFLOW_REF__", allowedRef);
    }
    write(hook, source, 0o500);
    return spawnSync("bash", [hook], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", ...env } });
  }

  const allowed = {
    GITHUB_REPOSITORY: "lab/adminbot",
    GITHUB_WORKFLOW_REF: allowedRef,
    GITHUB_EVENT_NAME: "workflow_run",
    GITHUB_REF: "refs/heads/main",
  };

  it("admits the deploy workflow on main, from CI or by hand", () => {
    expect(guard(allowed).status).toBe(0);
    expect(guard({ ...allowed, GITHUB_EVENT_NAME: "workflow_dispatch" }).status).toBe(0);
  });

  it.each([
    [
      "a fork pull request",
      {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/pull/7/merge",
        GITHUB_WORKFLOW_REF: "lab/adminbot/.github/workflows/ci.yaml@refs/pull/7/merge",
      },
    ],
    [
      "another workflow on main",
      { GITHUB_WORKFLOW_REF: "lab/adminbot/.github/workflows/ci.yaml@refs/heads/main" },
    ],
    [
      "the deploy workflow from a branch",
      {
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/feature",
        GITHUB_WORKFLOW_REF: "lab/adminbot/.github/workflows/deploy-aurora.yaml@refs/heads/feature",
      },
    ],
    ["a push event", { GITHUB_EVENT_NAME: "push" }],
    ["another repository", { GITHUB_REPOSITORY: "someone/adminbot" }],
    ["a job with no GitHub context", { GITHUB_WORKFLOW_REF: "" }],
  ])("refuses %s", (_label, overrides) => {
    const result = guard({ ...allowed, ...overrides });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing job on the Aurora deploy runner");
  });

  it("refuses everything when installed without its allowed values", () => {
    const result = guard(allowed, false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("without its allowed values");
  });
});

describe("Aurora deploy workflow", () => {
  it("deploys only successful CI runs of pushes to this repository's main", () => {
    expect(workflow).toContain("workflows: [CI]");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(workflow).toContain("runs-on: [aurora-deploy]");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\./);
    expect(workflow).not.toMatch(/pull_request/);
  });

  it("asks only for labels the installed runner has", () => {
    const installer = fs.readFileSync(installerScript, "utf8");
    const label = installer.match(/^RUNNER_LABEL="([^"]+)"$/m)?.[1];
    expect(installer).toContain("--no-default-labels");
    expect(workflow).toContain(`runs-on: [${label}]`);
  });
});

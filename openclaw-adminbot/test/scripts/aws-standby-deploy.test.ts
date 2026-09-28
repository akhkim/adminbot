// AWS standby deploy scripts: syntax, the standby invariants, and the env renderer's behavior.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dir = path.join(process.cwd(), "deploy/aws");
const scripts = [
  "bootstrap-host.sh",
  "build-release.sh",
  "install-release.sh",
  "render-env.sh",
  "status.sh",
];
const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");

describe("AWS standby scripts", () => {
  it.each(scripts)("%s is valid, executable Bash with side-effect-free help", (name) => {
    const script = path.join(dir, name);
    expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
    expect(fs.statSync(script).mode & 0o111).not.toBe(0);
    expect(execFileSync("bash", [script, "--help"], { encoding: "utf8" })).toContain("Usage:");
  });

  it("keeps the AdminBot account out of the docker group", () => {
    const source = read("bootstrap-host.sh");
    expect(source).toContain("grep -qx docker");
    expect(source).not.toMatch(/usermod[^\n]*docker|gpasswd -a/);
  });

  it("builds from a committed ref and ships the adminbot entrypoint", () => {
    const source = read("build-release.sh");
    // From the top level: run in the subdirectory, git archive silently produces an empty tree.
    expect(source).toContain('git -C "$toplevel" archive --format=tar "${commit}:${prefix}"');
    expect(source).toContain("has no package.json or pnpm-lock.yaml");
    expect(source).toContain("--frozen-lockfile");
    expect(source).toContain("dist/extensions/adminbot/api.js");
    expect(source).toContain("sha256sum");
  });

  it("installs as a standby: checks writers first and starts nothing that writes", () => {
    const source = read("install-release.sh");
    const writerCheck = source.indexOf("this host is not a standby");
    expect(writerCheck).toBeGreaterThan(0);
    for (const later of ["sha256sum --check", "tar -xzf", 'mv -T -- "$ROOT_DIR/current.next"']) {
      expect(source.indexOf(later)).toBeGreaterThan(writerCheck);
    }
    expect(source).toContain(
      'install-user-services.sh" --root "$ROOT_DIR/current" --state "$ROOT_DIR/state" --no-start',
    );
    expect(source).not.toContain("--start\n");
    const started = [...source.matchAll(/systemctl --user (?:enable|restart|start)[^\n]*/g)].map(
      (match) => match[0],
    );
    expect(started.length).toBeGreaterThan(0);
    for (const command of started) {
      expect(command.replace(/jinesis-model-tunnel-(?:vllm|ollama)\.service/g, "")).not.toContain(
        ".service",
      );
    }
  });

  it("refuses a tarball whose name does not carry a commit, before touching systemd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aws-install-"));
    fs.mkdirSync(path.join(root, "releases"));
    fs.mkdirSync(path.join(root, "state"));
    const result = spawnSync(
      "bash",
      [path.join(dir, "install-release.sh"), "--root", root, "--tarball", "/tmp/release.tar.gz"],
      { encoding: "utf8" },
    );
    fs.rmSync(root, { recursive: true, force: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected adminbot-<12-hex commit>.tar.gz");
  });
});

describe("render-env.sh", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const temp of temps.splice(0)) {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  // A fake `aws` that answers get-parameters-by-path with the given parameters, so the renderer
  // runs end to end with no AWS account and no instance metadata.
  function setup(parameters: Array<{ name: string; value: string }>) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aws-render-"));
    temps.push(temp);
    const home = path.join(temp, "home");
    const bin = path.join(temp, "bin");
    const template = path.join(temp, "root/current/deploy/aurora");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(template, { recursive: true });
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(template, "adminbot.env.example"),
      "OPENCLAW_GATEWAY_TOKEN=REPLACE_ME\nGOG_BIN=__HOME__/.local/bin/gog\nVLLM_API_KEY=vllm-local\n",
    );
    fs.writeFileSync(
      path.join(bin, "aws"),
      `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(parameters)}\nEOF\n`,
      {
        mode: 0o755,
      },
    );
    const run = () =>
      spawnSync(
        "bash",
        [
          path.join(dir, "render-env.sh"),
          "--root",
          path.join(temp, "root"),
          "--region",
          "us-east-1",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
        },
      );
    const envFile = path.join(home, ".config/jinesis-adminbot/adminbot.env");
    return { run, envFile };
  }

  it("seeds from the template, replaces and appends keys, and prints names but not values", () => {
    const { run, envFile } = setup([
      { name: "/adminbot/OPENCLAW_GATEWAY_TOKEN", value: "synthetic-token-123" },
      { name: "/adminbot/VLLM_API_KEY", value: "synthetic-vllm-key" },
      { name: "/adminbot/ADMINBOT_TUNNEL_TARGET", value: "100.101.102.103" },
      { name: "/adminbot/ADMINBOT_SLACK_INVITE_URL", value: "https://example.test/join?a=1&b=2" },
    ]);
    const result = run();
    expect(result.status).toBe(0);
    expect(fs.readFileSync(envFile, "utf8")).toBe(
      [
        "OPENCLAW_GATEWAY_TOKEN=synthetic-token-123",
        `GOG_BIN=${path.dirname(path.dirname(path.dirname(envFile)))}/.local/bin/gog`,
        "VLLM_API_KEY=synthetic-vllm-key",
        "ADMINBOT_TUNNEL_TARGET=100.101.102.103",
        'ADMINBOT_SLACK_INVITE_URL="https://example.test/join?a=1&b=2"',
        "",
      ].join("\n"),
    );
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    expect(result.stdout).toContain("ADMINBOT_TUNNEL_TARGET");
    expect(result.stdout + result.stderr).not.toContain("synthetic-token-123");
  });

  it("refuses a value neither quoting form can carry, and leaves the file untouched", () => {
    const { run, envFile } = setup([{ name: "/adminbot/OPENCLAW_GATEWAY_TOKEN", value: 'a"b' }]);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENCLAW_GATEWAY_TOKEN contains characters");
    expect(result.stderr).not.toContain('a"b');
    expect(fs.readFileSync(envFile, "utf8")).toContain("OPENCLAW_GATEWAY_TOKEN=REPLACE_ME");
  });

  it("refuses a nested parameter that is not an env var name", () => {
    const { run } = setup([{ name: "/adminbot/nested/KEY", value: "x" }]);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is not an env var name");
  });

  it("warns while the vLLM key is still the default", () => {
    const { run } = setup([{ name: "/adminbot/OPENCLAW_GATEWAY_TOKEN", value: "t" }]);
    expect(run().stderr).toContain("VLLM_API_KEY is still the vllm-local default");
  });
});

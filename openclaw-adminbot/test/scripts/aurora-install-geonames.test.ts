// The deploy step that lets "Use my precise location" name a city: installs the GeoNames table
// through the refresh script, appends only a missing env key, and warns -- never fails -- when the
// download does.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.join(process.cwd(), "deploy/aurora/install-geonames.sh");

const temps: string[] = [];
afterEach(() => {
  for (const temp of temps.splice(0)) {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// A release whose refresh script is a stand-in: it writes a synthetic table into the directory it
// is given, or fails when FAKE_DOWNLOAD_FAILS is set, and records each call.
function fixture(envFile = "ADMINBOT_SERVICE_TOKEN=synthetic\n") {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-install-geonames-"));
  temps.push(temp);
  const root = path.join(temp, "w", "adminbot");
  const release = path.join(root, "releases", "abc");
  const env = path.join(temp, "adminbot.env");
  fs.mkdirSync(path.join(release, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(release, "scripts/adminbot-geonames-refresh.sh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$1" >>"${temp}/refresh.log"
[[ -z "\${FAKE_DOWNLOAD_FAILS:-}" ]] || { echo "geonames refresh: not available" >&2; exit 1; }
mkdir -p "$1" && printf 'synthetic-cities' >"$1/cities1000.txt"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(env, envFile);
  return { temp, root, release, env };
}

type Fixture = ReturnType<typeof fixture>;

function run(f: Fixture, extra: Record<string, string> = {}) {
  return spawnSync(
    "bash",
    [script, "--root", f.root, "--release", f.release, "--env-file", f.env],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: f.temp, ...extra },
    },
  );
}

const refreshCalls = (f: Fixture) =>
  fs.existsSync(path.join(f.temp, "refresh.log"))
    ? fs.readFileSync(path.join(f.temp, "refresh.log"), "utf8").trim().split("\n")
    : [];

describe("deploy/aurora/install-geonames.sh", () => {
  it("is valid, executable Bash", () => {
    expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
    expect(fs.statSync(script).mode & 0o111).not.toBe(0);
  });

  it("installs the table beside the releases and points the service at it", () => {
    const f = fixture();
    expect(run(f).status).toBe(0);
    const dir = path.join(f.root, "geonames");
    expect(fs.readFileSync(path.join(dir, "cities1000.txt"), "utf8")).toBe("synthetic-cities");
    const env = fs.readFileSync(f.env, "utf8");
    expect(env).toContain(`ADMINBOT_GEONAMES_DIR=${dir}\n`);
    expect(env.startsWith("ADMINBOT_SERVICE_TOKEN=synthetic\n")).toBe(true);
  });

  it("never rewrites the operator's own directory, and refreshes that one", () => {
    const custom = path.join(os.tmpdir(), "synthetic-geonames-elsewhere");
    const f = fixture(`ADMINBOT_GEONAMES_DIR=${custom}\n`);
    temps.push(custom);
    expect(run(f).status).toBe(0);
    expect(fs.readFileSync(f.env, "utf8")).toBe(`ADMINBOT_GEONAMES_DIR=${custom}\n`);
    expect(refreshCalls(f)).toEqual([custom]);
  });

  it("keeps a recent table instead of downloading it again", () => {
    const f = fixture();
    const dir = path.join(f.root, "geonames");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cities1000.txt"), "already-here");
    expect(run(f).status).toBe(0);
    expect(refreshCalls(f)).toEqual([]);
    expect(fs.readFileSync(f.env, "utf8")).toContain(`ADMINBOT_GEONAMES_DIR=${dir}\n`);
  });

  it("warns and leaves the env alone when the download fails, without failing the deploy", () => {
    const f = fixture();
    const result = run(f, { FAKE_DOWNLOAD_FAILS: "1", GITHUB_ACTIONS: "true" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning title=Device location::");
    expect(fs.readFileSync(f.env, "utf8")).not.toContain("ADMINBOT_GEONAMES_DIR");
  });

  it("warns when it cannot find the env file", () => {
    const f = fixture();
    const result = spawnSync(
      "bash",
      [script, "--root", f.root, "--release", f.release, "--env-file", path.join(f.temp, "nope")],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: f.temp } },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not find the AdminBot env file");
  });
});

// The deploy step that turns sign-in geolocation on: installs the database through the refresh
// script, appends only missing env keys, and warns -- never fails -- when the download does.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.join(process.cwd(), "deploy/aurora/install-geoip.sh");

const temps: string[] = [];
afterEach(() => {
  for (const temp of temps.splice(0)) {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// A release whose refresh script is a stand-in: it writes a synthetic file to the path it is given,
// or fails when FAKE_DOWNLOAD_FAILS is set, and records each call.
function fixture(envFile = "ADMINBOT_SERVICE_TOKEN=synthetic\n") {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-install-geoip-"));
  temps.push(temp);
  const root = path.join(temp, "w", "adminbot");
  const release = path.join(root, "releases", "abc");
  const env = path.join(temp, "adminbot.env");
  fs.mkdirSync(path.join(release, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(release, "scripts/adminbot-geoip-refresh.sh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$1" >>"${temp}/refresh.log"
[[ -z "\${FAKE_DOWNLOAD_FAILS:-}" ]] || { echo "geoip refresh: no database" >&2; exit 1; }
mkdir -p "$(dirname "$1")" && printf 'synthetic-mmdb' >"$1"
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

describe("deploy/aurora/install-geoip.sh", () => {
  it("is valid, executable Bash", () => {
    expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
    expect(fs.statSync(script).mode & 0o111).not.toBe(0);
  });

  it("installs the database beside the releases and points the service at it", () => {
    const f = fixture();
    const result = run(f);
    expect(result.status).toBe(0);
    const mmdb = path.join(f.root, "geoip/dbip-city-lite.mmdb");
    expect(fs.readFileSync(mmdb, "utf8")).toBe("synthetic-mmdb");
    const env = fs.readFileSync(f.env, "utf8");
    expect(env).toContain(`ADMINBOT_GEOIP_MMDB_PATH=${mmdb}\n`);
    expect(env).toContain("ADMINBOT_TRUST_PROXY=1\n");
    // The operator's own lines are untouched.
    expect(env.startsWith("ADMINBOT_SERVICE_TOKEN=synthetic\n")).toBe(true);
  });

  it("never rewrites a key the operator already set", () => {
    const custom = "/srv/geo/GeoLite2-City.mmdb";
    const f = fixture(`ADMINBOT_TRUST_PROXY=0\nADMINBOT_GEOIP_MMDB_PATH=${custom}\n`);
    expect(run(f).status).toBe(0);
    const env = fs.readFileSync(f.env, "utf8");
    expect(env).toBe(`ADMINBOT_TRUST_PROXY=0\nADMINBOT_GEOIP_MMDB_PATH=${custom}\n`);
    // The refresh still goes to the operator's path, not the default one.
    expect(refreshCalls(f)).toEqual([custom]);
  });

  it("keeps a recent database instead of downloading it again", () => {
    const f = fixture();
    const mmdb = path.join(f.root, "geoip/dbip-city-lite.mmdb");
    fs.mkdirSync(path.dirname(mmdb), { recursive: true });
    fs.writeFileSync(mmdb, "already-here");
    const result = run(f);
    expect(result.status).toBe(0);
    expect(refreshCalls(f)).toEqual([]);
    expect(fs.readFileSync(f.env, "utf8")).toContain(`ADMINBOT_GEOIP_MMDB_PATH=${mmdb}\n`);
  });

  it("warns loudly and leaves geolocation off when the download fails, without failing the deploy", () => {
    const f = fixture();
    const result = run(f, { FAKE_DOWNLOAD_FAILS: "1", GITHUB_ACTIONS: "true" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning title=IP geolocation::");
    expect(result.stderr).toContain("stays OFF");
    // No path to a file that does not exist.
    expect(fs.readFileSync(f.env, "utf8")).not.toContain("ADMINBOT_GEOIP_MMDB_PATH");
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

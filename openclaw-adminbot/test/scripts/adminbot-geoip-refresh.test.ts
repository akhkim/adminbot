// The GeoIP refresh, against a synthetic database served from a file:// directory.
//
// Nothing here reaches DB-IP: ADMINBOT_GEOIP_BASE_URL points curl at a temporary directory holding
// a tiny database built in memory, so the test covers the month fallback, the gzip and open checks,
// and the swap into place without a download.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { Reader } from "mmdb-lib";
import { afterEach, describe, expect, it } from "vitest";
import { buildCityMmdb } from "../../extensions/adminbot/src/connectors/mmdb-fixture.test-helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, "scripts/adminbot-geoip-refresh.sh");

const CITY_DB = buildCityMmdb({
  "203.0.113.0/24": { city: "Toronto", region: "Ontario", country: "CA", continent: "NA" },
});

const temporaries: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geoip-refresh-"));
  temporaries.push(dir);
  return dir;
}

/** A directory standing in for download.db-ip.com/free, holding the given monthly files. */
function mirror(files: Record<string, Buffer>): string {
  const dir = tempDir();
  for (const [name, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), bytes);
  }
  return dir;
}

function run(args: string[], env: Record<string, string>) {
  // An empty env file, so a run without a destination argument never loads a real one.
  const envFile = path.join(tempDir(), "adminbot.env");
  fs.writeFileSync(envFile, "");
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ADMINBOT_ENV_FILE: envFile, ADMINBOT_GEOIP_MMDB_PATH: "", ...env },
  });
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/adminbot-geoip-refresh.sh", () => {
  it("is valid bash", () => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
  });

  it("installs the current month's database, readable by the service's reader", () => {
    const source = mirror({ "dbip-city-lite-2026-10.mmdb.gz": gzipSync(CITY_DB) });
    const destination = path.join(tempDir(), "geoip", "dbip-city-lite.mmdb");
    const result = run([destination], {
      ADMINBOT_GEOIP_BASE_URL: `file://${source}`,
      ADMINBOT_GEOIP_MONTH: "2026-10",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("installed dbip-city-lite-2026-10");
    const reader = new Reader(fs.readFileSync(destination));
    expect(reader.get("203.0.113.5")).toMatchObject({ city: { names: { en: "Toronto" } } });
    // No temporaries are left beside it.
    expect(fs.readdirSync(path.dirname(destination))).toEqual(["dbip-city-lite.mmdb"]);
  });

  it("falls back to the previous month, across a year boundary, before this month's is out", () => {
    const source = mirror({ "dbip-city-lite-2025-12.mmdb.gz": gzipSync(CITY_DB) });
    const destination = path.join(tempDir(), "city.mmdb");
    const result = run([destination], {
      ADMINBOT_GEOIP_BASE_URL: `file://${source}`,
      ADMINBOT_GEOIP_MONTH: "2026-01",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("installed dbip-city-lite-2025-12");
  });

  it.each([
    ["a truncated download", gzipSync(CITY_DB).subarray(0, 40)],
    ["a file that is not a database", gzipSync(Buffer.from("<html>rate limited</html>"))],
  ])("keeps the current file when handed %s", (_label, bytes) => {
    const source = mirror({ "dbip-city-lite-2026-10.mmdb.gz": bytes });
    const dir = tempDir();
    const destination = path.join(dir, "city.mmdb");
    fs.writeFileSync(destination, CITY_DB);
    const result = run([destination], {
      ADMINBOT_GEOIP_BASE_URL: `file://${source}`,
      ADMINBOT_GEOIP_MONTH: "2026-10",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("kept the current file");
    expect(fs.readFileSync(destination).equals(CITY_DB)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["city.mmdb"]);
  });

  it("fails without touching anything when neither month is published", () => {
    const destination = path.join(tempDir(), "city.mmdb");
    const result = run([destination], {
      ADMINBOT_GEOIP_BASE_URL: `file://${mirror({})}`,
      ADMINBOT_GEOIP_MONTH: "2026-10",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no database for 2026-10 or the month before");
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("skips quietly under cron when no destination is configured", () => {
    const result = run([], { ADMINBOT_GEOIP_BASE_URL: "file:///nonexistent" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipped");
  });
});

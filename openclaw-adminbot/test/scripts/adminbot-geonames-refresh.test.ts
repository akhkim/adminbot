// The GeoNames refresh, against a synthetic extract served from a file:// directory. Nothing here
// reaches geonames.org.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, "scripts/adminbot-geonames-refresh.sh");

const temporaries: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geonames-refresh-"));
  temporaries.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporaries.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function row(name: string, lat: number, lon: number, country: string, admin1: string): string {
  const cols = Array.from({ length: 19 }, () => "");
  Object.assign(cols, {
    1: name,
    4: String(lat),
    5: String(lon),
    7: "PPL",
    8: country,
    10: admin1,
  });
  cols[14] = "5000";
  return cols.join("\t");
}

const CITIES = [row("Synthville", 10, 10, "ZZ", "01"), row("Testford", 11, 11, "ZZ", "01")].join(
  "\n",
);
const ADMIN1 = "ZZ.01\tSynthregion\tSynthregion\t1\n";

/** A directory standing in for download.geonames.org/export/dump. */
function mirror(cities: string | null, admin1: string | null = ADMIN1): string {
  const dir = tempDir();
  if (cities !== null) {
    fs.writeFileSync(path.join(dir, "cities1000.txt"), cities);
    const zipped = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], 'w'); z.write(sys.argv[2], 'cities1000.txt'); z.close()",
        path.join(dir, "cities1000.zip"),
        path.join(dir, "cities1000.txt"),
      ],
      { encoding: "utf8" },
    );
    expect(zipped.status).toBe(0);
    fs.rmSync(path.join(dir, "cities1000.txt"));
  }
  if (admin1 !== null) {
    fs.writeFileSync(path.join(dir, "admin1CodesASCII.txt"), admin1);
  }
  return dir;
}

function run(args: string[], env: Record<string, string>) {
  const envFile = path.join(tempDir(), "adminbot.env");
  fs.writeFileSync(envFile, "");
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ADMINBOT_ENV_FILE: envFile,
      ADMINBOT_GEONAMES_DIR: "",
      ADMINBOT_GEONAMES_MIN_ROWS: "2",
      ...env,
    },
  });
}

describe("scripts/adminbot-geonames-refresh.sh", () => {
  it("is valid bash", () => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
  });

  it("installs the extract and the region names", () => {
    const dest = path.join(tempDir(), "geonames");
    const result = run([dest], { ADMINBOT_GEONAMES_BASE_URL: `file://${mirror(CITIES)}` });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(dest, "cities1000.txt"), "utf8")).toBe(CITIES);
    expect(fs.readFileSync(path.join(dest, "admin1CodesASCII.txt"), "utf8")).toBe(ADMIN1);
    // No temporaries left behind.
    expect(fs.readdirSync(dest).toSorted()).toEqual(["admin1CodesASCII.txt", "cities1000.txt"]);
  });

  it("keeps the current table when a download is short, malformed or missing", () => {
    const dest = path.join(tempDir(), "geonames");
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, "cities1000.txt"), "good-table");
    for (const source of [
      mirror(row("Synthville", 10, 10, "ZZ", "01")),
      mirror("<html>not found</html>\n<html>\n"),
      mirror(CITIES, "<html>not found</html>\n"),
      mirror(null),
      mirror(CITIES, null),
    ]) {
      const result = run([dest], { ADMINBOT_GEONAMES_BASE_URL: `file://${source}` });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("kept the current files");
      expect(fs.readFileSync(path.join(dest, "cities1000.txt"), "utf8")).toBe("good-table");
    }
  });

  it("skips quietly when no destination is configured", () => {
    const result = run([], { ADMINBOT_GEONAMES_BASE_URL: "file:///nonexistent" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipped");
  });
});

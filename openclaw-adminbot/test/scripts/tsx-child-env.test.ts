import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tsxChildEnv } from "../../scripts/tsx-child-env.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const tsxBin = path.join(repoRoot, "node_modules/.bin/tsx");
// systemd's default PATH on Aurora, which has no node on it.
const SYSTEMD_PATH = "/usr/local/bin:/usr/bin:/bin";
const nodeOnSystemdPath = SYSTEMD_PATH.split(":").some((dir) => existsSync(path.join(dir, "node")));

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runTsx(env: NodeJS.ProcessEnv) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tsx-child-env-"));
  dirs.push(dir);
  const script = path.join(dir, "hello.ts");
  writeFileSync(script, 'const greeting: string = "ok";\nconsole.log(greeting);\n');
  return spawnSync(tsxBin, [script], { encoding: "utf8", env, cwd: repoRoot });
}

describe("tsx child env", () => {
  it("puts the launcher's node directory first, once, keeping the rest of PATH and env", () => {
    const env = tsxChildEnv(
      { PATH: "/usr/bin:/opt/node/bin:/bin", HOME: "/home/x" },
      "/opt/node/bin/node",
    );
    expect(env.PATH).toBe("/opt/node/bin:/usr/bin:/bin");
    expect(env.HOME).toBe("/home/x");
  });

  it("works with no PATH at all", () => {
    expect(tsxChildEnv({}, "/opt/node/bin/node").PATH).toBe("/opt/node/bin");
  });

  it.skipIf(nodeOnSystemdPath)(
    "lets the tsx shim start under systemd's PATH, where it otherwise cannot find node",
    () => {
      const bare = runTsx({ HOME: os.tmpdir(), PATH: SYSTEMD_PATH });
      expect(bare.status).not.toBe(0);
      expect(bare.stderr).toContain("node");

      const run = runTsx(tsxChildEnv({ HOME: os.tmpdir(), PATH: SYSTEMD_PATH }));
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe("ok");
    },
  );
});

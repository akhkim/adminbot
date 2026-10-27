import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  crc32Hex as serviceCrc,
  mintApiTokenSecret,
} from "../../extensions/adminbot/src/workflows/identity/api-token-format.js";
import { crc32Hex, findApiTokens } from "../../scripts/check-secrets.mjs";

const SCRIPT = path.resolve(import.meta.dirname, "../../scripts/check-secrets.mjs");

describe("check-secrets", () => {
  it("uses the service's checksum", () => {
    for (const text of ["", "abt_", "abt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "é"]) {
      expect(crc32Hex(text)).toBe(serviceCrc(text));
    }
  });

  it("flags a minted token and ignores fixtures with a wrong checksum", () => {
    const token = mintApiTokenSecret();
    expect(findApiTokens(`ADMINBOT_TOKEN=${token}`)).toEqual([token]);
    expect(findApiTokens(`abt_${"A".repeat(43)}_0badc0de`)).toEqual([]);
    expect(findApiTokens("abt_[redacted] abt_short")).toEqual([]);
  });

  it("blocks a staged token without printing it", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "check-secrets-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo });
      git("init", "-q");
      const token = mintApiTokenSecret();
      writeFileSync(path.join(repo, "safe.txt"), `abt_${"A".repeat(43)}_0badc0de\n`);
      git("add", "safe.txt");
      // The script resolves the repository from its own location, so run a copy inside the repo.
      execFileSync("mkdir", ["-p", "scripts"], { cwd: repo });
      execFileSync("cp", [SCRIPT, "scripts/check-secrets.mjs"], { cwd: repo });
      execFileSync("node", ["scripts/check-secrets.mjs", "--staged"], { cwd: repo });

      writeFileSync(path.join(repo, ".env"), `one\nADMINBOT_TOKEN=${token}\n`);
      git("add", ".env");
      let output = "";
      let failed = false;
      try {
        execFileSync("node", ["scripts/check-secrets.mjs", "--staged"], {
          cwd: repo,
          stdio: "pipe",
        });
      } catch (error) {
        failed = true;
        const { stdout, stderr } = error as { stdout: Buffer; stderr: Buffer };
        output = `${stdout}${stderr}`;
      }
      expect(failed).toBe(true);
      expect(output).toContain(".env:2");
      expect(output).not.toContain(token);
      // The full scan (CI) finds it too, by tracked file rather than by diff.
      expect(() =>
        execFileSync("node", ["scripts/check-secrets.mjs"], { cwd: repo, stdio: "pipe" }),
      ).toThrow();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

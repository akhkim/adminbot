import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.join(process.cwd(), "deploy/aurora/install-node-user.sh");

describe("Aurora user Node installer", () => {
  it("is valid Bash and has side-effect-free help", () => {
    expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
    const help = execFileSync("bash", [script, "--help"], { encoding: "utf8" });
    expect(help).toContain("without sudo");
  });

  it("pins Node 22 and verifies the official checksum before extraction", () => {
    const source = fs.readFileSync(script, "utf8");
    expect(source).toContain('VERSION="v22.23.1"');
    expect(source).toContain("https://nodejs.org/download/release/${VERSION}");
    expect(source).toContain("sha256sum --check");
    expect(source.indexOf("sha256sum --check")).toBeLessThan(source.indexOf("tar -xJf"));
  });

  it("installs into the user account and enforces Node 22.19+", () => {
    const source = fs.readFileSync(script, "utf8");
    expect(source).toContain('BIN_DIR="$HOME/.local/bin"');
    expect(source).toContain("major !== 22 || minor < 19");
    expect(source).not.toMatch(/^\s*sudo\s/m);
  });
});

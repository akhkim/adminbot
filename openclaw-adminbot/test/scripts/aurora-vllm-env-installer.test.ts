import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const installer = `${root}/deploy/aurora/install-vllm-env.sh`;
const setup = `${root}/deploy/aurora/setup-qwen35-vllm.sh`;

describe("Aurora vLLM environment installer", () => {
  it("is valid shell and exposes help without changing the system", () => {
    execFileSync("bash", ["-n", installer]);
    expect(execFileSync("bash", [installer, "--help"], { encoding: "utf8" })).toContain(
      "without requiring system python3-venv",
    );
  });

  it("uses a user-level uv installation and never asks for sudo", () => {
    const source = readFileSync(installer, "utf8");
    expect(source).toContain('UV_UNMANAGED_INSTALL="$install_dir"');
    expect(source).toContain('venv --clear --python /usr/bin/python3 "$VENV"');
    expect(source).toContain('pip install --python "$VENV/bin/python"');
    expect(source).not.toMatch(/\bsudo\b/);
  });

  it("is used by the Qwen setup instead of python -m venv", () => {
    const source = readFileSync(setup, "utf8");
    expect(source).toContain("deploy/aurora/install-vllm-env.sh");
    expect(source).not.toContain("python3 -m venv");
  });
});

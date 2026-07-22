import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.join(process.cwd(), "deploy/aurora/bootstrap-runtime.sh");

describe("Aurora runtime bootstrap", () => {
  it("is valid Bash and exposes bounded help without making changes", () => {
    expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
    const help = execFileSync("bash", [script, "--help"], { encoding: "utf8" });
    expect(help).toContain("--pull-timeout");
    expect(help).toContain("--skip-tailscale");
    expect(help).toContain("--skip-adminbot-start");
  });

  it("keeps Ollama and AdminBot private and serves only the Gateway", () => {
    const source = fs.readFileSync(script, "utf8");
    expect(source).toContain("Environment=OLLAMA_HOST=127.0.0.1:11434");
    expect(source).toContain("CUDA_VISIBLE_DEVICES");
    expect(source).toContain('tailscale serve --bg "http://127.0.0.1:${GATEWAY_PORT}"');
    expect(source).not.toContain("tailscale funnel");
    expect(source).toContain("http://127.0.0.1:8765/settings");
  });

  it("bounds waits and model downloads", () => {
    const source = fs.readFileSync(script, "utf8");
    expect(source).toContain("for _ in $(seq 1 30)");
    expect(source).toContain('timeout "$PULL_TIMEOUT" ollama pull');
    expect(source).toContain("--max-time 5");
  });
});

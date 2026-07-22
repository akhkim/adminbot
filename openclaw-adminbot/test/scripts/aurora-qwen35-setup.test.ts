import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const setupScript = path.join(root, "deploy/aurora/setup-qwen35-vllm.sh");
const configScript = path.join(root, "deploy/aurora/configure-openclaw-qwen35.mjs");

describe("Aurora Qwen3.5 vLLM setup", () => {
  it("has valid Bash and side-effect-free help", () => {
    expect(() => execFileSync("bash", ["-n", setupScript])).not.toThrow();
    const help = execFileSync("bash", [setupScript, "--help"], { encoding: "utf8" });
    expect(help).toContain("--skip-download");
    expect(help).toContain("--gpu");
  });

  it("pins the requested model to one loopback-only Blackwell GPU", () => {
    const source = fs.readFileSync(setupScript, "utf8");
    expect(source).toContain('MODEL_ID="RedHatAI/Qwen3-Next-80B-A3B-Instruct-NVFP4"');
    expect(source).toContain("Environment=CUDA_VISIBLE_DEVICES=$GPU");
    expect(source).toContain("--host 127.0.0.1");
    expect(source).not.toContain("--quantization modelopt_fp4");
    expect(source).toContain("--generation-config vllm");
    expect(source).toContain("--kv-cache-dtype fp8");
    expect(source).toContain("--tensor-parallel-size 1");
    expect(source).not.toContain("0.0.0.0");
  });

  it("checks constrained non-thinking privacy inference", () => {
    const source = fs.readFileSync(setupScript, "utf8");
    expect(source).toContain('"temperature":0');
    expect(source).not.toContain('"enable_thinking":true');
    expect(source).toContain('"type":"json_schema"');
  });

  it("registers the local model and pins AdminBot without removing other agents", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "qwen35-config-"));
    const config = path.join(temp, "openclaw.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        agents: {
          defaults: { models: { "existing/model": {} } },
          list: [
            { id: "adminbot", model: { primary: "old/model" } },
            { id: "other", model: { primary: "existing/model" } },
          ],
        },
      }),
    );
    execFileSync(process.execPath, [configScript, config]);
    const result = JSON.parse(fs.readFileSync(config, "utf8"));
    expect(result.models.providers.vllm.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(result.models.providers.vllm.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "VLLM_API_KEY",
    });
    expect(result.models.providers.vllm.models[0].name).toBe(
      "RedHatAI/Qwen3-Next-80B-A3B-Instruct-NVFP4",
    );
    expect(result.models.providers.vllm.models[0].contextWindow).toBe(65536);
    expect(result.agents.defaults.models["existing/model"]).toEqual({});
    expect(
      result.agents.defaults.models["vllm/RedHatAI/Qwen3-Next-80B-A3B-Instruct-NVFP4"],
    ).toBeDefined();
    expect(result.agents.list[0].model).toEqual({
      primary: "vllm/RedHatAI/Qwen3-Next-80B-A3B-Instruct-NVFP4",
      fallbacks: [],
    });
    expect(result.agents.list[1].model.primary).toBe("existing/model");
  });
});

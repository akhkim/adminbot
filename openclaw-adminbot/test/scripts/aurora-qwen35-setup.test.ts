import { execFileSync, spawnSync } from "node:child_process";
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

  it("keeps the vLLM key off argv and its caches off the home volume", () => {
    const source = fs.readFileSync(setupScript, "utf8");
    const unit = source.slice(source.indexOf('cat >"$UNIT_DIR/jinesis-vllm.service"'));
    expect(unit).toContain("EnvironmentFile=$VLLM_ENV_FILE");
    expect(unit).not.toMatch(/^ExecStart=.*--api-key/m);
    expect(unit).not.toMatch(/^Environment=VLLM_API_KEY/m);
    expect(unit).toContain("Environment=VLLM_CACHE_ROOT=$CACHE_BASE/.cache/vllm");
    expect(unit).toContain("Environment=FLASHINFER_WORKSPACE_BASE=$CACHE_BASE");
    expect(unit).toContain("Environment=VLLM_NO_USAGE_STATS=1");
    expect(source).not.toContain('Bearer $VLLM_API_KEY"');
    expect(source.match(/-H @"\$AUTH_HEADER_FILE"/g)).toHaveLength(3);
  });

  // Runs the script's own key resolution, from `env_value()` through the length check, against
  // throwaway env files.
  describe("vLLM key resolution", () => {
    function resolveKey(
      files: { vllm?: string; adminbot?: string },
      explicit?: string,
    ): { status: number | null; key: string; stderr: string } {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "qwen35-key-"));
      const vllmEnv = path.join(temp, "vllm.env");
      const adminbotEnv = path.join(temp, "adminbot.env");
      if (files.vllm !== undefined) {
        fs.writeFileSync(vllmEnv, files.vllm);
      }
      if (files.adminbot !== undefined) {
        fs.writeFileSync(adminbotEnv, files.adminbot);
      }
      const program = [
        'die() { printf "error: %s\\n" "$*" >&2; exit 1; }',
        `VLLM_ENV_FILE=${JSON.stringify(vllmEnv)}; ENV_FILE=${JSON.stringify(adminbotEnv)}`,
        `source <(sed -n '/^env_value() {/,/must be at least 32 characters/p' "$1")`,
        'printf "%s" "$VLLM_API_KEY"',
      ].join("\n");
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.VLLM_API_KEY;
      if (explicit !== undefined) {
        env.VLLM_API_KEY = explicit;
      }
      const result = spawnSync("bash", ["-c", program, "_", setupScript], {
        encoding: "utf8",
        env,
      });
      fs.rmSync(temp, { recursive: true, force: true });
      return {
        status: result.status,
        key: result.stdout.split("\n").at(-1) ?? "",
        stderr: result.stderr,
      };
    }
    const real = "a".repeat(64);
    const other = "b".repeat(64);

    it("keeps the key already in vllm.env over the one in adminbot.env", () => {
      expect(
        resolveKey({ vllm: `# c\nVLLM_API_KEY=${real}\n`, adminbot: `VLLM_API_KEY=${other}\n` }),
      ).toMatchObject({ status: 0, key: real });
    });

    it("falls back to a real key in adminbot.env", () => {
      expect(resolveKey({ adminbot: `X=1\nVLLM_API_KEY=${other}\n` })).toMatchObject({
        status: 0,
        key: other,
      });
    });

    it("generates a fresh key instead of keeping the vllm-local default", () => {
      const result = resolveKey({ adminbot: "VLLM_API_KEY=vllm-local\n" });
      expect(result.status).toBe(0);
      expect(result.key).toMatch(/^[0-9a-f]{64}$/);
    });

    it("prefers an explicit key", () => {
      expect(resolveKey({ vllm: `VLLM_API_KEY=${real}\n` }, other)).toMatchObject({
        status: 0,
        key: other,
      });
    });

    it("refuses vllm-local and short keys even when given explicitly", () => {
      expect(resolveKey({}, "vllm-local")).toMatchObject({ status: 1 });
      expect(resolveKey({}, "vllm-local").stderr).toContain("well-known vllm-local default");
      expect(resolveKey({}, "short-key").stderr).toContain("at least 32 characters");
    });
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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const setupScript = path.join(root, "deploy/aurora/setup-meeting-vision-vllm.sh");

describe("Aurora meeting vision model setup", () => {
  const source = fs.readFileSync(setupScript, "utf8");
  const unit = source.slice(source.indexOf('cat >"$UNIT_DIR/$UNIT_NAME"'));

  it("has valid Bash and side-effect-free help", () => {
    expect(() => execFileSync("bash", ["-n", setupScript])).not.toThrow();
    const help = execFileSync("bash", [setupScript, "--help"], { encoding: "utf8" });
    expect(help).toContain("--gpu");
    expect(help).toContain("--skip-start");
  });

  it("pins the vision model to Aurora GPU 6, loopback only", () => {
    expect(source).toContain('GPU="GPU-6a6425d3-2df8-f7eb-980a-a2c1d4c5296b"');
    expect(unit).toContain("Environment=CUDA_VISIBLE_DEVICES=$GPU_UUID");
    expect(unit).toContain("--host 127.0.0.1");
    expect(source).not.toContain("0.0.0.0");
    expect(source).toContain('die "port 8000 belongs to jinesis-vllm"');
  });

  it("accepts single images only and never fetches a model at runtime", () => {
    expect(unit).toContain(`--limit-mm-per-prompt '{"image":1,"video":0}'`);
    expect(unit).toContain("Environment=HF_HUB_OFFLINE=1");
  });

  it("keeps the vLLM key off argv", () => {
    expect(unit).toContain("EnvironmentFile=$VLLM_ENV_FILE");
    expect(unit).not.toMatch(/^ExecStart=.*--api-key/m);
    expect(source).not.toContain('Bearer $VLLM_API_KEY"');
    expect(source).toContain('-H @"$AUTH_HEADER_FILE"');
  });

  it("does not start on a GPU another job is holding", () => {
    const busyCheck = source.indexOf("GPU_USED_MIB > BUSY_GPU_MIB");
    const start = source.indexOf('systemctl --user restart "$UNIT_NAME"');
    expect(busyCheck).toBeGreaterThan(0);
    expect(busyCheck).toBeLessThan(start);
  });

  it("points the meeting pass at the server and a pinned ffmpeg", () => {
    expect(source).toContain('FFMPEG_VERSION="0.6.0"');
    expect(source).toContain('"imageio-ffmpeg==$FFMPEG_VERSION"');
    expect(source).toContain(
      'set_env_key ADMINBOT_MEETING_VISION_BASE_URL "http://127.0.0.1:$PORT/v1"',
    );
    expect(source).toContain('set_env_key ADMINBOT_MEETING_VISION_MODEL "$MODEL_ID"');
    expect(source).toContain('set_env_key ADMINBOT_FFMPEG_BIN "$FFMPEG_BIN"');
  });
});

// Aurora's Cloudflare tunnel setup: the model hostnames are only published behind Access.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.join(process.cwd(), "deploy/aurora/cloudflare-tunnel.sh");
const source = fs.readFileSync(script, "utf8");

// Runs the script's own access_guards() against a fake curl that prints `curlOutput` (the
// `%{http_code} %{redirect_url}` line) and exits with `curlExit`.
function probe(curlOutput: string, curlExit = 0) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-probe-"));
  fs.writeFileSync(
    path.join(temp, "curl"),
    `#!/bin/sh\nprintf '%s' '${curlOutput}'\nexit ${curlExit}\n`,
    {
      mode: 0o755,
    },
  );
  const result = spawnSync(
    "bash",
    [
      "-c",
      `source <(sed -n '/^access_guards() {/,/^}/p' "$1"); access_guards model.example.test`,
      "_",
      script,
    ],
    { encoding: "utf8", env: { ...process.env, PATH: `${temp}:${process.env.PATH}` } },
  );
  fs.rmSync(temp, { recursive: true, force: true });
  return result;
}

describe("Aurora Cloudflare tunnel setup", () => {
  it("is valid, executable Bash with side-effect-free help", () => {
    expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
    expect(fs.statSync(script).mode & 0o111).not.toBe(0);
    expect(execFileSync("bash", [script, "--help"], { encoding: "utf8" })).toContain(
      "MODEL_VLLM_HOST",
    );
  });

  it.each([
    ["403 ", "a Service Auth denial"],
    ["401 ", "an unauthenticated denial"],
    [
      "302 https://lab.cloudflareaccess.com/cdn-cgi/access/login/model.example.test",
      "a login redirect",
    ],
  ])("accepts %s as Access guarding the hostname (%s)", (answer) => {
    expect(probe(answer).status).toBe(0);
  });

  it.each([
    ["404 ", "the origin catch-all"],
    ["200 ", "an open origin"],
    ["502 ", "a broken origin"],
    ["302 https://evil.example.test/", "a redirect somewhere other than Access"],
  ])("refuses %s (%s)", (answer) => {
    const result = probe(answer);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("from the origin side, not Access");
  });

  it("refuses a hostname that does not resolve", () => {
    const result = probe("000 ", 6);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not resolve or answer");
  });

  it("probes every model hostname before writing the config, and never routes their DNS", () => {
    const modelSection = source.slice(
      source.indexOf(
        "# ---------------------------------------------------------- model hostnames --",
      ),
      source.indexOf(
        "# ------------------------------------------------------------------- config --",
      ),
    );
    expect(modelSection).toContain('access_guards "$host"');
    expect(modelSection).not.toContain("route dns");
    expect(source.indexOf('access_guards "$host"')).toBeLessThan(
      source.indexOf('> "$CF_DIR/config.yml"'),
    );
    expect(source).toContain('echo "    service: tcp://127.0.0.1:${route#* }"');
  });
});

import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import { request } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertPortFree, devConfig } from "../../scripts/run-adminbot-dev.mjs";

const launcher = fileURLToPath(new URL("../../../dev.sh", import.meta.url));

async function reservePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test port");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("development launcher", () => {
  it("connects the UI to the chosen loopback backend and limits its allowed origins", () => {
    const config = devConfig({
      ADMINBOT_PORT: "18801",
      ADMINBOT_DEV_UI_PORT: "15173",
      ADMINBOT_DEV_PASSWORD: "Synthetic-test-password",
      ADMINBOT_ALLOWED_ORIGINS: "https://remote.example.test",
    });
    expect(new URL(config.uiUrl).searchParams.get("adminBotUrl")).toBe("http://127.0.0.1:18801");
    expect(config.env.ADMINBOT_ALLOWED_ORIGINS).toBe(
      "http://127.0.0.1:15173,http://localhost:15173",
    );
    expect(config.env.ADMINBOT_DEV_DATABASE).toBe("state/adminbot-dev.sqlite");
    expect(config.usesDefaultPassword).toBe(false);
    expect(config.env.ADMINBOT_DEV_ACCOUNT_PICKER).toBe("1");
    expect(() => devConfig({ NODE_ENV: "production" })).toThrow(/production/u);
    expect(() => devConfig({ ADMINBOT_PORT: "5173" })).toThrow(/different ports/u);
    expect(() => devConfig({ ADMINBOT_DEV_UI_PORT: "0" })).toThrow(/port/u);
  });

  it.each(["secret", "origin", "remote"])(
    "rejects missing or unsafe gateway setup: %s",
    (scenario) => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-preflight-"));
      try {
        const configPath = path.join(temp, "openclaw.json");
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            gateway: {
              mode: "local",
              auth: {
                mode: "token",
                ...(scenario === "secret" ? {} : { token: "synthetic-test-secret" }),
              },
              controlUi: { allowedOrigins: scenario === "origin" ? [] : ["http://127.0.0.1:5173"] },
            },
          }),
        );
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", "scripts/adminbot-dev-gateway.ts"],
          {
            cwd: fileURLToPath(new URL("../../", import.meta.url)),
            encoding: "utf8",
            timeout: 15000,
            env: {
              ...process.env,
              OPENCLAW_STATE_DIR: temp,
              OPENCLAW_CONFIG_PATH: configPath,
              OPENCLAW_GATEWAY_TOKEN: "",
              OPENCLAW_GATEWAY_PASSWORD: "",
              ADMINBOT_CONTROL_UI_URL: "http://127.0.0.1:5173",
              ADMINBOT_GATEWAY_WS_URL:
                scenario === "remote" ? "wss://remote.example.test" : "ws://127.0.0.1:18789",
            },
          },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          scenario === "secret"
            ? "No gateway token/password"
            : scenario === "origin"
              ? "Allow http://127.0.0.1:5173"
              : "requires a local",
        );
        expect(fs.existsSync(path.join(temp, "devices"))).toBe(false);
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("refuses occupied ports without stopping the existing listener", async () => {
    const occupied = await reservePort();
    try {
      await expect(assertPortFree(occupied.port)).rejects.toThrow(/existing service/u);
      await expect(assertPortFree(occupied.port)).rejects.toThrow(/existing service/u);
    } finally {
      await occupied.close();
    }
  });

  it("starts from another directory, serves both apps, and releases both ports on Ctrl+C", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-launcher-"));
    const backend = await reservePort();
    const frontend = await reservePort();
    const gateway = await reservePort();
    const configPath = path.join(temp, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          mode: "local",
          port: gateway.port,
          auth: { mode: "token", token: "synthetic-gateway-test-secret" },
          controlUi: { allowedOrigins: [`http://127.0.0.1:${frontend.port}`] },
        },
      }),
    );
    await backend.close();
    await frontend.close();
    const child = spawn(launcher, [], {
      cwd: temp,
      env: {
        ...process.env,
        ADMINBOT_DEV_DATABASE: path.join(temp, "launcher-dev.sqlite"),
        ADMINBOT_DEV_PASSWORD: "Synthetic-launcher-password!",
        ADMINBOT_DEV_EMAIL: "alice@example.test",
        ADMINBOT_PORT: String(backend.port),
        ADMINBOT_DEV_UI_PORT: String(frontend.port),
        OPENCLAW_STATE_DIR: path.join(temp, "openclaw"),
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_TOKEN: "synthetic-gateway-test-secret",
        ADMINBOT_GATEWAY_WS_URL: `ws://127.0.0.1:${gateway.port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (data: Buffer) => {
      output += data.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    try {
      const deadline = Date.now() + 60_000;
      while (!output.includes("Ready!") && Date.now() < deadline && child.exitCode === null) {
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      }
      expect(output, output).toContain("Ready!");
      expect(output).toContain("Created 5 logins");
      const base = `http://127.0.0.1:${backend.port}`;
      expect((await fetch(`${base}/lab/members`)).status).toBe(401);
      const login = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${frontend.port}`,
        },
        body: JSON.stringify({
          email: "alice@example.test",
          password: "Synthetic-launcher-password!",
        }),
      });
      expect(login.status).toBe(200);
      const session = await login.json();
      const bytes = generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "der" })
        .subarray(-32);
      const device = {
        deviceId: createHash("sha256").update(bytes).digest("hex"),
        publicKey: bytes.toString("base64url"),
        scopes: ["operator.admin"],
      };
      const issue = (token?: string) =>
        fetch(`${base}/auth/device-token`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(device),
        });
      expect((await issue()).status).toBe(401);
      expect((await issue("invalid-session")).status).toBe(401);
      const issued = await issue(session.session_token);
      expect(issued.status).toBe(200);
      expect((await issued.json()).token).toBeTruthy();
      const memberLogin = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "bob@example.test",
          password: "Synthetic-launcher-password!",
        }),
      });
      const memberToken = await issue((await memberLogin.json()).session_token);
      expect(memberToken.status).toBe(200);
      expect((await memberToken.json()).scopes).not.toContain("operator.admin");
      const uiOrigin = `http://127.0.0.1:${frontend.port}`;
      const html = await (await fetch(uiOrigin)).text();
      const pickerPath = html.match(/src="(\/__adminbot_dev__\/[^"]+\.js)"/u)?.[1];
      expect(pickerPath).toBeTruthy();
      const picker = await fetch(`${uiOrigin}${pickerPath}`);
      expect(picker.headers.get("cache-control")).toBe("no-store");
      const source = await picker.text();
      expect(source).toContain("bob@example.test");
      expect(source).toContain("Synthetic-launcher-password!");
      expect(source).toContain(base);
      for (const headers of [
        { origin: "https://remote.example.test" },
        { origin: "http://localhost:12345" },
        { "sec-fetch-site": "cross-site" },
        { host: `evil.example.test:${frontend.port}` },
      ]) {
        // Raw HTTP preserves Host/Sec-Fetch-Site, which fetch can rewrite.
        const denied = await new Promise<{ status: number | undefined; body: string }>(
          (resolve, reject) => {
            const req = request(`${uiOrigin}${pickerPath}`, { headers }, (res) => {
              let body = "";
              res.on("data", (chunk) => {
                body += String(chunk);
              });
              res.on("end", () => resolve({ status: res.statusCode, body }));
            });
            req.on("error", reject);
            req.end();
          },
        );
        expect(denied.status, JSON.stringify(headers)).toBe(403);
        expect(denied.body).not.toContain("Synthetic-launcher-password!");
      }
      const wrongPassword = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: uiOrigin },
        body: JSON.stringify({ email: "bob@example.test", password: "b" }),
      });
      expect(wrongPassword.status).toBe(401);
      child.kill("SIGINT");
      const exitCode = await exited;
      expect(exitCode, output).toBe(0);
      await assertPortFree(backend.port);
      await assertPortFree(frontend.port);
    } finally {
      child.kill("SIGTERM");
      await exited;
      await gateway.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 90_000);
});

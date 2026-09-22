#!/usr/bin/env node
import { spawn } from "node:child_process";
// Owns the local process group lifecycle; the existing scripts own seeding and service startup.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function port(value, fallback, name) {
  const raw = value?.trim() || String(fallback);
  const parsed = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be a port between 1 and 65535`);
  }
  return parsed;
}

export function devConfig(env = process.env) {
  if (env.NODE_ENV === "production") {
    throw new Error("The local development launcher cannot run with NODE_ENV=production");
  }
  const backendPort = port(env.ADMINBOT_PORT, 8801, "ADMINBOT_PORT");
  const uiPort = port(env.ADMINBOT_DEV_UI_PORT, 5173, "ADMINBOT_DEV_UI_PORT");
  if (backendPort === uiPort) {
    throw new Error("The backend and frontend need different ports");
  }
  const password = env.ADMINBOT_DEV_PASSWORD || "LocalDevOnly-123!";
  if (password.length < 10) {
    throw new Error("ADMINBOT_DEV_PASSWORD must be at least 10 characters");
  }
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const uiOrigin = `http://127.0.0.1:${uiPort}`;
  const uiUrl = new URL(uiOrigin);
  uiUrl.searchParams.set("adminBotUrl", backendUrl);
  return {
    backendPort,
    uiPort,
    backendUrl,
    uiUrl: uiUrl.href,
    env: {
      ...env,
      ADMINBOT_PORT: String(backendPort),
      ADMINBOT_DEV_EMAIL: env.ADMINBOT_DEV_EMAIL?.trim() || "alice@example.test",
      ADMINBOT_DEV_PASSWORD: password,
      ADMINBOT_DEV_ACCOUNT_PICKER: "1",
      ADMINBOT_DEV_DATABASE: env.ADMINBOT_DEV_DATABASE?.trim() || "state/adminbot-dev.sqlite",
      ADMINBOT_GATEWAY_WS_URL: env.ADMINBOT_GATEWAY_WS_URL?.trim() || "ws://127.0.0.1:18789",
      ADMINBOT_CONTROL_UI_URL: uiOrigin,
      // Exact loopback origins only; this launcher must not inherit a remote UI's CORS settings.
      ADMINBOT_ALLOWED_ORIGINS: `${uiOrigin},http://localhost:${uiPort}`,
    },
    usesDefaultPassword: !env.ADMINBOT_DEV_PASSWORD,
  };
}

export async function assertPortFree(portNumber) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error) =>
      reject(
        new Error(
          `Cannot use 127.0.0.1:${portNumber}: ${error.code}. Stop the existing service or choose another port.`,
        ),
      ),
    );
    probe.listen(portNumber, "127.0.0.1", () => probe.close(resolve));
  });
}

function dependenciesInstalled() {
  try {
    const require = createRequire(path.join(repoRoot, "package.json"));
    const uiRequire = createRequire(path.join(repoRoot, "ui/package.json"));
    require.resolve("tsx");
    uiRequire.resolve("vite");
    uiRequire.resolve("dompurify");
    return true;
  } catch {
    return false;
  }
}

export async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: ./dev.sh\nSeeds fictional accounts, watches the backend, and starts the frontend.\nOverrides: ADMINBOT_DEV_PASSWORD, ADMINBOT_DEV_EMAIL, ADMINBOT_DEV_DATABASE,\nADMINBOT_DEV_FIXTURE, ADMINBOT_PORT (8801), ADMINBOT_DEV_UI_PORT (5173).\nCtrl+C stops both services. Fixture JSON changes need another launch or a manual seed.",
    );
    return;
  }
  if (process.argv.length > 2) {
    throw new Error("Unknown argument; use --help for configuration");
  }
  const gptZeroEnv = path.join(repoRoot, ".env.gptzero");
  if (existsSync(gptZeroEnv)) {
    process.loadEnvFile(gptZeroEnv);
  }
  const config = devConfig();
  await assertPortFree(config.backendPort);
  await assertPortFree(config.uiPort);
  const children = new Set();
  let stopping = false;
  let forceKill;
  const signalChild = (child, signal) => {
    if (!child.pid) {
      return;
    }
    try {
      // Include the Node watcher and pnpm/Vite descendants, not only their wrapper processes.
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") {
        console.error(`Could not stop development process: ${error.message}`);
      }
    }
  };
  const stop = (exitCode) => {
    if (stopping) {
      return;
    }
    stopping = true;
    process.exitCode = exitCode;
    for (const child of children) {
      signalChild(child, "SIGTERM");
    }
    forceKill = setTimeout(() => {
      for (const child of children) {
        signalChild(child, "SIGKILL");
      }
    }, 3000);
    forceKill.unref();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = () => stop(0);
  for (const signal of signals) {
    process.on(signal, onSignal);
  }
  const run = (command, args, label, listeningPort) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: repoRoot,
        env: config.env,
        stdio: "inherit",
        detached: true,
      });
      children.add(child);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        // A wrapper can exit before its descendants. Clean the whole group even on failure.
        signalChild(child, "SIGTERM");
        const finish = async () => {
          try {
            // Check the resource users need released. Process-group existence probes can fail
            // with EPERM during teardown on macOS even after our wrapper has exited.
            if (listeningPort) {
              const deadline = Date.now() + 5000;
              while (true) {
                try {
                  await assertPortFree(listeningPort);
                  break;
                } catch {
                  if (Date.now() >= deadline) {
                    throw new Error(
                      `${label} did not release port ${listeningPort} after shutdown`,
                    );
                  }
                  await new Promise((done) => {
                    setTimeout(done, 25);
                  });
                }
              }
            }
            if (stopping || (code === 0 && !listeningPort)) {
              resolve();
            } else {
              reject(new Error(`${label} stopped (${signal || `exit ${code}`})`));
            }
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          } finally {
            children.delete(child);
          }
        };
        void finish();
      });
    });
  const runNode = (args, label, listeningPort) => run(process.execPath, args, label, listeningPort);
  const waitForReady = async (url, label) => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (stopping) {
        return;
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) {
          return;
        }
      } catch {
        // The child may still be compiling imports; a refused connection is expected at first.
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }
    if (!stopping) {
      throw new Error(
        `${label} did not become ready within 45 seconds; see its startup output above`,
      );
    }
  };
  try {
    if (!dependenciesInstalled()) {
      console.log("Installing project dependencies with pnpm 11.2.2…");
      await run("npx", ["--yes", "pnpm@11.2.2", "install"], "Dependency installation");
    }
    if (stopping) {
      return;
    }
    await runNode(["--import", "tsx", "scripts/adminbot-dev-gateway.ts"], "Gateway check");
    await runNode(["--import", "tsx", "scripts/seed-adminbot-dev.ts"], "Fixture seeding");
    if (stopping) {
      return;
    }
    console.log(`Admin login: ${config.env.ADMINBOT_DEV_EMAIL}`);
    console.log(
      config.usesDefaultPassword
        ? "Local test password: LocalDevOnly-123! (existing accounts keep their original password)"
        : "Password: your ADMINBOT_DEV_PASSWORD value (existing passwords are preserved)",
    );
    console.log(
      "Backend restarts on code changes; frontend reloads automatically. Ctrl+C stops both.\n",
    );
    // Reuse the UI wrapper. npx supplies pnpm on machines that have neither pnpm nor Corepack.
    const runner = resolvePnpmRunner({ cwd: repoRoot, env: config.env });
    const ui =
      runner.command === "pnpm"
        ? run(
            "npx",
            [
              "--yes",
              "pnpm@11.2.2",
              "ui:dev",
              "--host",
              "127.0.0.1",
              "--port",
              String(config.uiPort),
            ],
            "Frontend",
            config.uiPort,
          )
        : runNode(
            ["scripts/ui.js", "dev", "--host", "127.0.0.1", "--port", String(config.uiPort)],
            "Frontend",
            config.uiPort,
          );
    await Promise.all([
      ui,
      runNode(
        ["--watch", "--import", "tsx", "scripts/start-adminbot-dev.ts"],
        "Backend",
        config.backendPort,
      ),
      Promise.all([
        waitForReady(`${config.backendUrl}/adminbot`, "Backend"),
        waitForReady(config.uiUrl, "Frontend"),
      ]).then(() => {
        if (!stopping) {
          console.log(
            `\nReady!\nFrontend: ${config.uiUrl}\nConsole: ${config.backendUrl}/adminbot\n`,
          );
        }
      }),
    ]);
  } catch (error) {
    stop(1);
    throw error;
  } finally {
    if (children.size === 0) {
      clearTimeout(forceKill);
      for (const signal of signals) {
        process.off(signal, onSignal);
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

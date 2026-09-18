// Development-server tooling only. Never import this from the browser application.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export function adminBotDevAccountPicker(env = process.env): Plugin {
  // An unguessable, per-process URL keeps other local browser origins from loading credentials.
  const modulePath = `/__adminbot_dev__/${randomBytes(24).toString("hex")}/account-picker.js`;
  return {
    name: "adminbot-dev-account-picker",
    apply(config, { command }) {
      return (
        command === "serve" &&
        config.mode !== "production" &&
        env.NODE_ENV !== "production" &&
        env.ADMINBOT_DEV_ACCOUNT_PICKER === "1"
      );
    },
    configureServer(server) {
      const { host, port } = server.config.server;
      const backendPort = Number(env.ADMINBOT_PORT);
      if (
        host !== "127.0.0.1" ||
        !port ||
        server.config.server.https ||
        !Number.isInteger(backendPort) ||
        backendPort < 1 ||
        backendPort > 65535 ||
        backendPort === port ||
        !env.ADMINBOT_DEV_DATABASE?.endsWith("-dev.sqlite") ||
        !env.ADMINBOT_DEV_PASSWORD ||
        env.ADMINBOT_DEV_PASSWORD.length < 10
      ) {
        throw new Error("The account picker requires the loopback-only dev.sh configuration");
      }
      const raw: unknown = JSON.parse(
        fs.readFileSync(
          path.resolve(repoRoot, env.ADMINBOT_DEV_FIXTURE || "dev/fixtures/members.json"),
          "utf8",
        ),
      );
      if (!Array.isArray(raw)) {
        throw new Error("Expected an array of synthetic accounts");
      }
      const accounts = raw.map((member: Record<string, unknown>) => {
        if (
          typeof member?.id !== "string" ||
          !member.id.startsWith("dev-") ||
          typeof member.name !== "string" ||
          typeof member.email !== "string" ||
          !/^[^@\s]+@example\.(test|com|org|net)$/u.test(member.email)
        ) {
          throw new Error("The account picker only accepts synthetic fixture accounts");
        }
        return {
          name: member.name,
          email: member.email,
          role: member.privilege_level || "external_collaborator",
        };
      });
      const uiOrigin = `http://127.0.0.1:${port}`;
      const config = JSON.stringify({
        accounts,
        password: env.ADMINBOT_DEV_PASSWORD,
        backendUrl: `http://127.0.0.1:${backendPort}`,
      });
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== modulePath) {
          next();
          return;
        }
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        const remote = req.socket.remoteAddress;
        if (
          req.method !== "GET" ||
          (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1") ||
          req.headers.host !== `127.0.0.1:${port}` ||
          (req.headers.origin && req.headers.origin !== uiOrigin) ||
          (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")
        ) {
          res.statusCode = 403;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "text/javascript");
        const source = fs.readFileSync(path.join(repoRoot, "dev/account-picker.mjs"), "utf8");
        res.end(`${source}\ninstallAccountPicker(${config});\n`);
      });
    },
    transformIndexHtml() {
      return [{ tag: "script", attrs: { type: "module", src: modulePath }, injectTo: "body" }];
    },
  };
}

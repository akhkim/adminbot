/** Read-only preflight: fixture login must use the same local gateway state as its issuer. */
import net from "node:net";
import { loadConfig } from "../src/config/config.js";
import { resolveSharedGatewayAuthIssuer } from "../src/plugin-sdk/device-bootstrap.js";

const config = loadConfig();
const url = new URL(process.env.ADMINBOT_GATEWAY_WS_URL || "ws://127.0.0.1:18789");
const uiOrigin = process.env.ADMINBOT_CONTROL_UI_URL || "http://127.0.0.1:5173";
if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
  throw new Error(
    "Development fixture login requires a local ws:// gateway sharing your OpenClaw state.",
  );
}
if (Number(url.port || 80) !== (config.gateway?.port ?? 18789)) {
  throw new Error(
    "ADMINBOT_GATEWAY_WS_URL must match the port in your personal OpenClaw configuration.",
  );
}
if (!resolveSharedGatewayAuthIssuer()) {
  throw new Error(
    "No gateway token/password is configured. Run pnpm openclaw onboard, or use the same OpenClaw configuration and secret as your running gateway.",
  );
}
if (!config.gateway?.controlUi?.allowedOrigins?.includes(uiOrigin)) {
  throw new Error(
    `Allow ${uiOrigin} in gateway.controlUi.allowedOrigins, then restart your gateway with pnpm openclaw gateway restart. Existing origins should be preserved.`,
  );
}
await new Promise<void>((resolve, reject) => {
  const socket = net.connect({
    host: url.hostname.replace(/^\[|\]$/gu, ""),
    port: Number(url.port || 80),
  });
  const fail = () => {
    socket.destroy();
    reject(
      new Error(
        `Cannot reach OpenClaw at ${url.origin}. Start it with pnpm openclaw gateway start (installed service) or pnpm openclaw gateway (foreground).`,
      ),
    );
  };
  socket.setTimeout(3000, fail);
  socket.once("error", fail);
  socket.once("connect", () => {
    socket.destroy();
    resolve();
  });
});
console.log(
  `OpenClaw gateway reachable at ${url.origin}; fixture logins use normal device authentication.`,
);

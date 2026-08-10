/**
 * AdminBot service launcher — source run (`pnpm adminbot:dev`).
 *
 * Resolves modules from source; the composition itself lives in
 * extensions/adminbot/host/main.ts so this and start-adminbot.mjs cannot drift.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAdminBotHost } from "./extensions/adminbot/host/main.ts";
import { runEmailAutomation } from "./scripts/adminbot-email-automation.ts";
import {
  approveDevicePairing,
  ensureDeviceToken,
  requestDevicePairing,
  resolveSharedGatewayAuthIssuer,
} from "./src/plugin-sdk/device-bootstrap.ts";

await startAdminBotHost({
  repoRoot: path.dirname(fileURLToPath(import.meta.url)),
  runEmailAutomation,
  devicePairing: {
    approveDevicePairing,
    ensureDeviceToken,
    requestDevicePairing,
    resolveSharedGatewayAuthIssuer,
  },
  // Slack lives in another plugin and is only present in a built run, so a source run has no
  // Slack Connect invite. Sending one is an operator action, not part of the boot path.
});

/**
 * AdminBot service launcher — production run (`pnpm adminbot`, and the jinesis-adminbot systemd
 * unit on Aurora).
 *
 * Resolves modules from dist/; the composition itself lives in extensions/adminbot/host/main.ts so
 * this and start-adminbot.ts cannot drift. Run `pnpm build` first — dist/ is what this reads.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startAdminBotHost } from "./dist/extensions/adminbot/host/main.js";
import {
  approveDevicePairing,
  ensureDeviceToken,
  requestDevicePairing,
  resolveSharedGatewayAuthIssuer,
} from "./dist/plugin-sdk/device-bootstrap.js";
import { loadConfig } from "./dist/plugin-sdk/config-runtime.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Runs the hourly inbox processor out-of-process. It is a tsx script rather than built output, and
 * a partial run is still worth recording, hence ADMINBOT_EMAIL_ALLOW_PARTIAL.
 */
async function runEmailAutomation() {
  const executable = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const script = path.join(repoRoot, "scripts", "adminbot-email-automation.ts");
  const { stdout } = await execFileAsync(executable, [script], {
    cwd: repoRoot,
    env: { ...process.env, ADMINBOT_EMAIL_ALLOW_PARTIAL: "1" },
    timeout: 30 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!output) {
    throw new Error("email automation returned no completion summary");
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("email automation returned an invalid completion summary");
  }
}

/**
 * Mints a Slack Connect invite. Slack lives in another bundled plugin, so the invite is wired here
 * rather than imported by the AdminBot extension. Same call the hourly email automation already
 * makes for trial invites, so the scopes and token are known to work; Slack emails the invitee as
 * well, and the guide carries the same url so either message gets them in.
 */
async function inviteToSlackConnect({ email, channelId }) {
  const { getSlackWriteClient, resolveSlackAccount } = await import("./extensions/slack/api.js");
  const cfg = await loadConfig();
  const account = await resolveSlackAccount({ cfg });
  if (!account.botToken) {
    throw new Error("Slack bot token is not configured; cannot mint a Slack Connect invite");
  }
  const response = await getSlackWriteClient(account.botToken).apiCall(
    "conversations.inviteShared",
    { channel: channelId, emails: [email], external_limited: true },
  );
  const url = response?.url ?? response?.invite?.url;
  if (typeof url !== "string" || !url) {
    throw new Error("Slack did not return an invite url");
  }
  return { url };
}

await startAdminBotHost({
  repoRoot,
  runEmailAutomation,
  inviteToSlackConnect,
  devicePairing: {
    approveDevicePairing,
    ensureDeviceToken,
    requestDevicePairing,
    resolveSharedGatewayAuthIssuer,
  },
});

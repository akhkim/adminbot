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
import { loadConfig } from "./dist/plugin-sdk/config-runtime.js";
import {
  approveDevicePairing,
  ensureDeviceToken,
  requestDevicePairing,
  resolveSharedGatewayAuthIssuer,
} from "./dist/plugin-sdk/device-bootstrap.js";

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
 * Mints a Slack Connect invite, out-of-process through tsx.
 *
 * This used to `await import("./extensions/slack/api.js")` directly, which threw MODULE_NOT_FOUND
 * on every real send: this launcher runs under plain node and resolves everything else from dist/,
 * but extensions/slack is deliberately kept out of the bundle, so that path exists only as
 * TypeScript. It appeared to work solely under `pnpm adminbot:dev`, which runs through tsx.
 *
 * The script also resolves the bot token's SecretRef, which the old in-process version skipped --
 * so even with the import fixed it would have thrown UnresolvedSecretInputError. Same seam as
 * runEmailAutomation above, and the same stdin-JSON contract as the DCS form script.
 */
async function inviteToSlackConnect({ email, channelId }) {
  const executable = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const script = path.join(repoRoot, "scripts", "adminbot-slack-connect-invite.ts");
  // Generous, because this is a cold tsx start on a network filesystem: it compiles the script,
  // loads the email-automation module for its Slack resolver, reads the config and then waits on
  // Slack. A minute was enough by hand and not always enough under the service, and a timeout kill
  // leaves no stdout -- indistinguishable, before the reporting below, from the script failing.
  const child = execFile(executable, [script], { cwd: repoRoot, timeout: 5 * 60_000 });
  child.stdin.end(JSON.stringify({ email, channelId }));
  const { stdout, stderr, code, spawnError } = await new Promise((resolve) => {
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    // Resolve on either path rather than rejecting: a spawn failure (no tsx on this release) and a
    // module that threw while loading both produce no stdout, and the reason for each is only in
    // stderr or in the error itself. Rejecting here threw all of it away and left the operator
    // with "returned no result", which says nothing they can act on.
    child.on("error", (error) => resolve({ stdout: out, stderr: err, spawnError: error }));
    child.on("close", (exitCode, signal) =>
      resolve({ stdout: out, stderr: err, code: exitCode, signal }),
    );
  });
  const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!line) {
    const detail =
      spawnError?.message ??
      // A timeout kill reports only the signal, so name it rather than printing "exit null".
      (signal ? `killed by ${signal} (timed out?)` : undefined) ??
      stderr.trim().split(/\r?\n/u).filter(Boolean).at(-1) ??
      `exit ${code}`;
    throw new Error(`slack connect invite produced no result: ${detail}`);
  }
  const payload = JSON.parse(line);
  if (!payload?.ok || typeof payload.url !== "string" || !payload.url) {
    throw new Error(payload?.error ?? "slack connect invite failed");
  }
  return { url: payload.url };
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

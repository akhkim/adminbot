import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createAdminBotMessageExecutor,
  createAdminBotMockService,
  createAdminBotOpenReviewExecutor,
  createAdminBotReimbursementWorkflow,
  createAdminBotOverleafExecutor,
  createAdminBotSocialExecutor,
  createCompositeAdminBotExecutor,
  createGogAdminBotExecutor,
} from "./dist/extensions/adminbot/api.js";
// Core device-pairing lives behind the plugin-SDK bootstrap seam. Importing it here (repo-root
// composition), not inside the extension, keeps the AdminBot plugin free of core internals while
// letting the member-authenticated /auth/pair-device route approve a member's browser device.
import {
  approveDevicePairing,
  ensureDeviceToken,
  requestDevicePairing,
  resolveSharedGatewayAuthIssuer,
} from "./dist/plugin-sdk/device-bootstrap.js";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

try {
  process.loadEnvFile(path.join(os.homedir(), ".openclaw/.env"));
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

console.log(`AdminBot NVIDIA NIM configured: ${process.env.NVIDIA_API_KEY ? "yes" : "no"}`);

const openReviewScriptPath = path.join(repoRoot, "scripts/adminbot-openreview.py");

const service = createAdminBotMockService({
  databasePath: path.join(repoRoot, "state/adminbot.sqlite"),
  auditRetentionDays: 30,
  executor: createCompositeAdminBotExecutor([
    createAdminBotOverleafExecutor(),
    createAdminBotSocialExecutor(),
    createAdminBotMessageExecutor({
      command: process.execPath,
      commandArgsPrefix: [path.join(repoRoot, "openclaw.mjs")],
    }),
    createGogAdminBotExecutor(),
    // Reviewing-cycle reminders post through OpenReview's own message invitations.
    // ADMINBOT_OPENREVIEW_SEND is the deploy-time kill switch: without it every
    // approved reminder is composed and validated but not delivered.
    createAdminBotOpenReviewExecutor({
      scriptPath: openReviewScriptPath,
      send: process.env.ADMINBOT_OPENREVIEW_SEND === "1",
    }),
  ]),
  // Slack lives in another bundled plugin, so the invite is wired here rather than imported by
  // the AdminBot extension. Same call the hourly email automation already makes for trial invites,
  // so the scopes and token are known to work; Slack emails the invitee as well, and the guide
  // carries the same url so either message gets them in.
  inviteToSlackConnect: async ({ email, channelId }) => {
    const { getSlackWriteClient, resolveSlackAccount } = await import("./extensions/slack/api.js");
    const account = await resolveSlackAccount({});
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
  },
  sensitiveInfoPath: path.join(os.homedir(), ".openclaw/adminbot-sensitive-information.md"),
  emailAutomationRunner: runEmailAutomationProcess,
  reimbursementWorkflow: createAdminBotReimbursementWorkflow({
    formScriptPath: path.join(repoRoot, "scripts/adminbot-reimbursement-from-email.py"),
  }),
  openReviewScriptPath,
  fetchSlackLocations,
  devicePairingApprover: approveMemberDevicePairing,
  deviceTokenIssuer: issueMemberDeviceToken,
});

// Reads each member's location from their Slack profile via the OpenClaw CLI, the same
// seam the message executor uses. Slack reports `tz` (an IANA zone, whose city is what
// the map wants) for every active account; a workspace "location" profile field wins
// when one is configured. A member Slack knows nothing about simply gets no entry, and
// the map falls back to their roster location.
async function fetchSlackLocations(slackUserIds) {
  const located = new Map();
  for (const userId of slackUserIds) {
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          path.join(repoRoot, "openclaw.mjs"),
          "message",
          "member",
          "info",
          "--channel",
          "slack",
          "--user-id",
          userId,
          "--json",
        ],
        { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const payload = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
      const user = payload?.user ?? payload?.result?.user ?? payload;
      const fields = user?.profile?.fields ?? {};
      const fieldLocation = Object.values(fields).find(
        (field) => typeof field?.value === "string" && field.value.trim(),
      )?.value;
      const location = fieldLocation ?? user?.tz;
      if (typeof location === "string" && location.trim()) {
        located.set(userId, location.trim());
      }
    } catch (error) {
      // One unreachable profile must not abandon the other 143.
      console.warn(`slack location lookup failed for ${userId}: ${error?.message ?? error}`);
    }
  }
  return located;
}

// Approves a member's pending gateway device pairing, capping granted scopes at what their
// privilege allows. approveDevicePairing grants the device's *requested* scopes bounded by
// `callerScopes`, so passing the member's allowed scopes as the ceiling means a plain member who
// requests operator.write is rejected (caller-missing-scope) rather than over-granted. Both this
// process and the gateway share ~/.openclaw/devices state on disk, and the gateway re-reads paired
// state per connect, so the approval takes effect on the browser's next reconnect.
async function approveMemberDevicePairing({ requestId, allowedScopes }) {
  const result = await approveDevicePairing(requestId, { callerScopes: [...allowedScopes] });
  if (result === null) {
    return { ok: false, reason: "unknown_request" };
  }
  if (result.status === "approved") {
    return { ok: true };
  }
  // forbidden — most commonly the device asked for more scope than the member may hold.
  if (
    result.reason === "caller-missing-scope" ||
    result.reason === "scope-outside-requested-roles"
  ) {
    return { ok: false, reason: "scope_exceeds_privilege" };
  }
  return { ok: false, reason: "failed", message: `device pairing forbidden: ${result.reason}` };
}

// Pairs a member's browser device and mints its gateway token in one step, so the browser opens
// its first connection with a credential of its own instead of the shared gateway secret.
// `allowedScopes` is the ceiling from the member's privilege, and it is passed three times on
// purpose: as the requested pairing scopes, as the approval ceiling, and as the token's scopes.
// The issuer stamp must match what the gateway would have stamped, or connect rejects the token
// as a legacy browser credential.
async function issueMemberDeviceToken({
  deviceId,
  publicKey,
  platform,
  deviceFamily,
  displayName,
  allowedScopes,
}) {
  const issuer = resolveSharedGatewayAuthIssuer();
  if (!issuer) {
    return { ok: false, reason: "unsupported" };
  }
  const scopes = [...allowedScopes];
  // Reuse the device's existing token before touching pairing. approveDevicePairing always mints a
  // fresh token, so re-approving an already-approved device on every login/reload would rotate the
  // credential out from under every other live session on that device — the gateway then rejects
  // them with "device token mismatch". ensureDeviceToken is idempotent while the device stays
  // paired within its approved scope baseline, and returns null when it is not (never paired, or
  // the member's privilege now needs a wider grant), which is exactly when a real approval is due.
  // The reuse is still capped at the caller's privilege: a device approved as admin whose member
  // was since downgraded holds a token wider than `scopes`, and handing that back would re-grant
  // the privilege they just lost. Falling through re-runs approval, which denies it.
  const paired = await ensureDeviceToken({ deviceId, role: "operator", scopes, issuer });
  if (paired && paired.scopes.every((scope) => scopes.includes(scope))) {
    return { ok: true, token: paired.token, scopes: paired.scopes };
  }
  const pairing = await requestDevicePairing({
    deviceId,
    publicKey,
    clientId: "openclaw-control-ui",
    clientMode: "webchat",
    role: "operator",
    scopes,
    ...(platform ? { platform } : {}),
    ...(deviceFamily ? { deviceFamily } : {}),
    ...(displayName ? { displayName } : {}),
    // Silent: the member already proved who they are with their login session, so there is no
    // second human approval to wait for.
    silent: true,
  });
  const approval = await approveDevicePairing(pairing.request.requestId, {
    callerScopes: scopes,
  });
  if (approval?.status !== "approved") {
    return {
      ok: false,
      reason: "failed",
      message: `device pairing rejected: ${approval?.reason ?? "unknown"}`,
    };
  }
  const token = await ensureDeviceToken({ deviceId, role: "operator", scopes, issuer });
  if (!token) {
    return { ok: false, reason: "failed", message: "device token could not be issued" };
  }
  return { ok: true, token: token.token, scopes: token.scopes };
}

async function runEmailAutomationProcess() {
  const executable = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const script = path.join(repoRoot, "scripts", "adminbot-email-automation.ts");
  const { stdout } = await execFileAsync(executable, [script], {
    cwd: repoRoot,
    env: { ...process.env, ADMINBOT_EMAIL_ALLOW_PARTIAL: "1" },
    timeout: 30 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!output) throw new Error("email automation returned no completion summary");
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("email automation returned an invalid completion summary");
  }
}

await service.listen(8765, "127.0.0.1");
console.log(
  "AdminBot service with live gog/social/overleaf/message execution running on http://127.0.0.1:8765",
);

// Keep the service alive even when launched detached without an interactive stdin.
setInterval(() => {}, 2 ** 31 - 1);

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCompositeAdminBotExecutor } from "./extensions/adminbot/src/composite-executor.ts";
import { createGogAdminBotExecutor } from "./extensions/adminbot/src/gog-executor.ts";
import { createAdminBotMessageExecutor } from "./extensions/adminbot/src/message-executor.ts";
import {
  createAdminBotMockService,
  type DevicePairingApproval,
  type DeviceTokenIssuance,
} from "./extensions/adminbot/src/mock-service.ts";
import { createAdminBotOverleafExecutor } from "./extensions/adminbot/src/overleaf-executor.ts";
import { createAdminBotReimbursementWorkflow } from "./extensions/adminbot/src/reimbursement-workflow.ts";
import { createAdminBotSocialExecutor } from "./extensions/adminbot/src/social-executor.ts";
import { runEmailAutomation } from "./scripts/adminbot-email-automation.ts";
import {
  approveDevicePairing,
  ensureDeviceToken,
  requestDevicePairing,
  resolveSharedGatewayAuthIssuer,
} from "./src/plugin-sdk/device-bootstrap.ts";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const CONTROL_UI_DEVICE_ROLE = "operator";
loadOpenClawEnv();
console.log(`AdminBot NVIDIA NIM configured: ${process.env.NVIDIA_API_KEY ? "yes" : "no"}`);
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
  ]),
  sensitiveInfoPath: path.join(os.homedir(), ".openclaw/adminbot-sensitive-information.md"),
  emailAutomationRunner: runEmailAutomation,
  reimbursementWorkflow: createAdminBotReimbursementWorkflow({
    formScriptPath: path.join(repoRoot, "scripts/adminbot-reimbursement-from-email.py"),
  }),
  deviceTokenIssuer: issueMemberDeviceToken,
  devicePairingApprover: approveMemberDevicePairing,
});

await service.listen(8765, "127.0.0.1");
console.log(
  "AdminBot service with live gog/social/overleaf/message execution running on http://127.0.0.1:8765",
);

// Keep the service alive even when launched detached without an interactive stdin.
setInterval(() => {}, 2 ** 31 - 1);

// Mints the gateway credential a signed-in member's browser connects with, bound to that browser's
// own device key. Without this wiring `/auth/device-token` answers 503, the Control UI falls back to
// the shared gateway secret it deliberately no longer holds, and the member's connect frame reaches
// the Gateway with no auth at all (`auth=none device=yes ... reason=token_missing`).
//
// It has to live here, in the repo-root composition layer: the AdminBot extension must not import
// core device-pairing internals, and the Gateway runs as a separate process, so the pairing store on
// disk is the only shared state between the two.
async function issueMemberDeviceToken(params: {
  deviceId: string;
  publicKey: string;
  platform?: string;
  deviceFamily?: string;
  displayName?: string;
  allowedScopes: readonly string[];
}): Promise<DeviceTokenIssuance> {
  // Connect rejects a browser-family device token that carries no shared-auth issuer stamp, and one
  // stamped with a superseded generation. No shared secret means the Gateway stamps nothing either,
  // so there is no token this service could mint that connect would accept.
  const issuer = resolveSharedGatewayAuthIssuer();
  if (!issuer) {
    return {
      ok: false,
      reason: "unsupported",
      message: "gateway has no shared secret to bind a device token to",
    };
  }
  const scopes = [...params.allowedScopes];
  // Already-paired browsers keep their token across logins; this also re-stamps a token left stale
  // by a shared-secret rotation, which is otherwise indistinguishable from an unpaired device.
  const existing = await ensureDeviceToken({
    deviceId: params.deviceId,
    role: CONTROL_UI_DEVICE_ROLE,
    scopes,
    issuer,
  });
  if (existing) {
    return { ok: true, token: existing.token, scopes: existing.scopes };
  }
  const pending = await requestDevicePairing({
    deviceId: params.deviceId,
    publicKey: params.publicKey,
    ...(params.displayName ? { displayName: params.displayName } : {}),
    ...(params.platform ? { platform: params.platform } : {}),
    deviceFamily: params.deviceFamily ?? "browser",
    // Must match what the Control UI sends on connect, or the Gateway sees a different device.
    clientId: "openclaw-control-ui",
    clientMode: "webchat",
    role: CONTROL_UI_DEVICE_ROLE,
    roles: [CONTROL_UI_DEVICE_ROLE],
    scopes,
    // The member's own session is the approval; there is no owner prompt to raise.
    silent: true,
  });
  // `allowedScopes` is the ceiling the service derived from the member's privilege, so passing it as
  // the caller scopes is what keeps a plain member's device read-only.
  const approval = await approveDevicePairing(pending.request.requestId, { callerScopes: scopes });
  if (!approval) {
    return { ok: false, reason: "failed", message: "pairing request expired before approval" };
  }
  if (approval.status !== "approved") {
    return { ok: false, reason: "failed", message: `pairing refused: ${approval.reason}` };
  }
  const token = await ensureDeviceToken({
    deviceId: params.deviceId,
    role: CONTROL_UI_DEVICE_ROLE,
    scopes,
    issuer,
  });
  if (!token) {
    return { ok: false, reason: "failed", message: "device paired but no token could be issued" };
  }
  return { ok: true, token: token.token, scopes: token.scopes };
}

// Approves a pending pairing the Gateway itself raised during connect (PAIRING_REQUIRED), on the
// authority of the member's login session and capped at `allowedScopes`. The replacement token is
// minted by the Gateway on the next connect, so nothing is stamped here.
async function approveMemberDevicePairing(params: {
  requestId: string;
  allowedScopes: readonly string[];
}): Promise<DevicePairingApproval> {
  const approval = await approveDevicePairing(params.requestId, {
    callerScopes: [...params.allowedScopes],
  });
  if (!approval) {
    return { ok: false, reason: "unknown_request" };
  }
  if (approval.status === "forbidden") {
    const overPrivilege =
      approval.reason === "caller-missing-scope" || approval.reason === "caller-scopes-required";
    return {
      ok: false,
      reason: overPrivilege ? "scope_exceeds_privilege" : "failed",
      message: approval.reason,
    };
  }
  return { ok: true };
}

function loadOpenClawEnv(): void {
  try {
    process.loadEnvFile(path.join(os.homedir(), ".openclaw/.env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

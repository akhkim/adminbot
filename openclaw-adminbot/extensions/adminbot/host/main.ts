/**
 * AdminBot service composition root.
 *
 * There used to be two of these — start-adminbot.ts for source runs and start-adminbot.mjs for
 * built runs — and they drifted: the built one wired the OpenReview executor and the Slack Connect
 * invite, the source one did not, so a behaviour only reproduced in production. The composition
 * lives here once; the two launchers differ only in where they resolve modules from, which they
 * pass in as `deps`.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createAdminBotMockService,
  type DevicePairingApproval,
  type DeviceTokenIssuance,
} from "../src/api/server.js";
import { adminBotSlackActivityWindowDays } from "../src/contracts/actions.js";
import { createCompositeAdminBotExecutor } from "../src/connectors/composite.js";
import { createGogAdminBotExecutor } from "../src/connectors/gog.js";
import { createAdminBotMessageExecutor } from "../src/connectors/message.js";
import { createAdminBotOpenReviewExecutor } from "../src/connectors/openreview.js";
import { createAdminBotOverleafExecutor } from "../src/connectors/overleaf.js";
import { createAdminBotSlackAdminExecutor } from "../src/connectors/slack-admin.js";
import { createAdminBotSocialExecutor } from "../src/connectors/social.js";
import { createAdminBotReimbursementWorkflow } from "../src/workflows/reimbursements/workflow.js";

const execFileAsync = promisify(execFile);

/** The Control UI connects as this device role; scopes are capped per member privilege. */
const CONTROL_UI_DEVICE_ROLE = "operator";
const DEFAULT_SERVICE_PORT = 8765;
const SERVICE_HOST = "127.0.0.1";
const AUDIT_RETENTION_DAYS = 30;

/**
 * Cross-boundary dependencies the launchers resolve, because their module paths differ between a
 * source run and a built run, and because core device-pairing must not be imported by the plugin.
 */
export type AdminBotHostDeps = {
  /** Repo root, used to resolve state, scripts and the openclaw CLI. */
  repoRoot: string;
  /** Hourly inbox processor. */
  runEmailAutomation: () => Promise<unknown>;
  /** Core device-pairing seam, from the plugin SDK bootstrap. */
  devicePairing: {
    approveDevicePairing: (
      requestId: string,
      options: { callerScopes: string[] },
    ) => Promise<{ status: string; reason?: string } | null>;
    ensureDeviceToken: (params: {
      deviceId: string;
      role: string;
      scopes: string[];
      issuer: string;
      ownerMemberId?: string;
    }) => Promise<{ token: string; scopes: string[] } | null>;
    requestDevicePairing: (params: Record<string, unknown>) => Promise<{
      request: { requestId: string };
    }>;
    resolveSharedGatewayAuthIssuer: () => string | undefined;
  };
  /** Mints a Slack Connect invite. Slack lives in another plugin, so the launcher supplies it. */
  inviteToSlackConnect?: (params: { email: string; channelId: string }) => Promise<{ url: string }>;
};

/**
 * Listen port. Defaults to 8765 — the port the systemd unit, the Vercel UI and every doc assume —
 * but a second instance (a fresh clone, a smoke test) cannot bind it while the unit is up, so
 * ADMINBOT_PORT overrides. An unparseable or out-of-range value is a typo, not a request for the
 * default, so it fails loudly rather than silently colliding with the live service.
 */
export function resolveServicePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ADMINBOT_PORT?.trim();
  if (!raw) {
    return DEFAULT_SERVICE_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(
      `ADMINBOT_PORT must be an integer between 0 and 65535, got ${JSON.stringify(raw)}`,
    );
  }
  return port;
}

/** Loads ~/.openclaw/.env if present; a missing file is normal on a fresh box. */
export function loadOpenClawEnv(): void {
  try {
    process.loadEnvFile(path.join(os.homedir(), ".openclaw/.env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Mints the gateway credential a signed-in member's browser connects with, bound to that browser's
 * own device key. Without this wiring `/auth/device-token` answers 503, the Control UI falls back
 * to the shared gateway secret it deliberately no longer holds, and the member's connect frame
 * reaches the Gateway with no auth at all.
 */
function createDeviceTokenIssuer(deps: AdminBotHostDeps) {
  return async function issueMemberDeviceToken(params: {
    deviceId: string;
    publicKey: string;
    platform?: string;
    deviceFamily?: string;
    displayName?: string;
    allowedScopes: readonly string[];
    /** AdminBot member id owning this browser's device token, so its chat history stays theirs. */
    memberId?: string;
  }): Promise<DeviceTokenIssuance> {
    // Connect rejects a browser-family device token that carries no shared-auth issuer stamp, and
    // one stamped with a superseded generation. No shared secret means the Gateway stamps nothing
    // either, so there is no token this service could mint that connect would accept.
    const issuer = deps.devicePairing.resolveSharedGatewayAuthIssuer();
    if (!issuer) {
      return {
        ok: false,
        reason: "unsupported",
        message: "gateway has no shared secret to bind a device token to",
      };
    }
    const scopes = [...params.allowedScopes];
    // Already-paired browsers keep their token across logins; this also re-stamps a token left
    // stale by a shared-secret rotation, which is otherwise indistinguishable from unpaired.
    const existing = await deps.devicePairing.ensureDeviceToken({
      deviceId: params.deviceId,
      role: CONTROL_UI_DEVICE_ROLE,
      scopes,
      issuer,
      ...(params.memberId ? { ownerMemberId: params.memberId } : {}),
    });
    if (existing) {
      return { ok: true, token: existing.token, scopes: existing.scopes };
    }
    const pending = await deps.devicePairing.requestDevicePairing({
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
      ...(params.memberId ? { ownerMemberId: params.memberId } : {}),
    });
    // `allowedScopes` is the ceiling the service derived from the member's privilege, so passing it
    // as the caller scopes is what keeps a plain member's device read-only.
    const approval = await deps.devicePairing.approveDevicePairing(pending.request.requestId, {
      callerScopes: scopes,
    });
    if (!approval) {
      return { ok: false, reason: "failed", message: "pairing request expired before approval" };
    }
    if (approval.status !== "approved") {
      return { ok: false, reason: "failed", message: `pairing refused: ${approval.reason}` };
    }
    const token = await deps.devicePairing.ensureDeviceToken({
      deviceId: params.deviceId,
      role: CONTROL_UI_DEVICE_ROLE,
      scopes,
      issuer,
      ...(params.memberId ? { ownerMemberId: params.memberId } : {}),
    });
    if (!token) {
      return { ok: false, reason: "failed", message: "device paired but no token could be issued" };
    }
    return { ok: true, token: token.token, scopes: token.scopes };
  };
}

/**
 * Approves a pending pairing the Gateway raised during connect (PAIRING_REQUIRED), on the authority
 * of the member's login session and capped at `allowedScopes`. The replacement token is minted by
 * the Gateway on the next connect, so nothing is stamped here.
 */
function createDevicePairingApprover(deps: AdminBotHostDeps) {
  return async function approveMemberDevicePairing(params: {
    requestId: string;
    allowedScopes: readonly string[];
  }): Promise<DevicePairingApproval> {
    const approval = await deps.devicePairing.approveDevicePairing(params.requestId, {
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
  };
}

/** Raw `message member info` result for one Slack user, or null if the lookup failed. */
async function fetchSlackMemberInfo(repoRoot: string, userId: string): Promise<unknown> {
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
    return payload?.user ?? payload?.result?.user ?? payload;
  } catch (error) {
    // One unreachable profile must not abandon the rest of the roster.
    console.warn(
      `slack member info lookup failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * Reads each member's location from their Slack profile via the OpenClaw CLI, the same seam the
 * message executor uses. Slack reports `tz` (an IANA zone, whose city is what the map wants) for
 * every active account; a workspace "location" profile field wins when one is configured. A member
 * Slack knows nothing about simply gets no entry, and the map falls back to their roster location.
 */
function createSlackLocationReader(repoRoot: string) {
  return async function fetchSlackLocations(
    slackUserIds: readonly string[],
  ): Promise<Map<string, string>> {
    const located = new Map<string, string>();
    for (const userId of slackUserIds) {
      const user = (await fetchSlackMemberInfo(repoRoot, userId)) as
        | { profile?: { fields?: Record<string, unknown> }; tz?: unknown }
        | undefined;
      const fields = user?.profile?.fields ?? {};
      const fieldLocation = Object.values(fields).find(
        (field: unknown) =>
          typeof (field as { value?: unknown })?.value === "string" &&
          (field as { value: string }).value.trim(),
      ) as { value?: string } | undefined;
      const location = fieldLocation?.value ?? user?.tz;
      if (typeof location === "string" && location.trim()) {
        located.set(userId, location.trim());
      }
    }
    return located;
  };
}

/**
 * Reads each member's IANA timezone (`tz`, e.g. `America/Toronto`) straight from their Slack
 * account -- unlike createSlackLocationReader this never substitutes a workspace "location"
 * profile field, since the profile timezone selector needs the raw zone, not a city name.
 */
export function createSlackTimezoneReader(repoRoot: string) {
  return async function fetchSlackTimezones(
    slackUserIds: readonly string[],
  ): Promise<Map<string, string | null>> {
    const timezones = new Map<string, string | null>();
    for (const userId of slackUserIds) {
      const user = (await fetchSlackMemberInfo(repoRoot, userId)) as { tz?: unknown } | undefined;
      // fetchSlackMemberInfo answers `undefined` only when the lookup itself failed. Leaving the
      // key out says "we could not ask"; `null` says Slack answered and had no zone. The caller
      // clears on the second and never on the first.
      if (user === undefined) {
        continue;
      }
      timezones.set(userId, typeof user.tz === "string" && user.tz.trim() ? user.tz.trim() : null);
    }
    return timezones;
  };
}

/**
 * Counts how many messages each member sent across the workspace in the activity window.
 *
 * One pass over the channels AdminBot already tracks (the same channel ids the naming sweep works
 * from), reading recent messages per channel and tallying by author. That direction matters: Slack
 * has no "messages by user" endpoint a bot token can call, so the only way to this number is to
 * read channels and count. Doing it once per channel rather than once per member keeps the cost at
 * ~45 calls instead of ~45 x 159.
 *
 * Every member the sweep managed to read for gets a key, including a zero -- that is a real
 * measurement, and the service treats it differently from an absent key. If the whole read fails,
 * no keys come back at all and the service leaves the previous readings alone rather than marking
 * the entire lab inactive on one bad night.
 */
export function createSlackMessageCounter(repoRoot: string) {
  return async function fetchSlackMessageCounts(
    slackUserIds: readonly string[],
    channelIds: readonly string[],
  ): Promise<Map<string, number>> {
    const wanted = new Set(slackUserIds);
    const counts = new Map<string, number>();
    const since = Date.now() - adminBotSlackActivityWindowDays * 86_400_000;
    let readAny = false;
    for (const channelId of channelIds) {
      const messages = await readSlackChannel(repoRoot, channelId);
      if (messages === undefined) {
        continue;
      }
      readAny = true;
      for (const message of messages) {
        const author = typeof message.user === "string" ? message.user : "";
        if (!author || !wanted.has(author)) {
          continue;
        }
        // Slack timestamps are seconds with a microsecond fraction.
        const sentMs = Number.parseFloat(String(message.ts ?? "0")) * 1000;
        if (!Number.isFinite(sentMs) || sentMs < since) {
          continue;
        }
        counts.set(author, (counts.get(author) ?? 0) + 1);
      }
    }
    if (!readAny) {
      return new Map();
    }
    // A member the sweep read for and never saw really did send nothing; that is a zero, not a gap.
    for (const userId of wanted) {
      if (!counts.has(userId)) {
        counts.set(userId, 0);
      }
    }
    return counts;
  };
}

/** Recent messages in one Slack channel, or undefined when the read failed. */
async function readSlackChannel(
  repoRoot: string,
  channelId: string,
): Promise<Array<Record<string, unknown>> | undefined> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(repoRoot, "openclaw.mjs"),
        "message",
        "read",
        "--channel",
        "slack",
        "--target",
        channelId,
        "--limit",
        String(SLACK_HISTORY_LIMIT),
        "--json",
      ],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const payload = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    const messages = payload?.messages ?? payload?.result?.messages ?? payload?.result ?? [];
    return Array.isArray(messages) ? (messages as Array<Record<string, unknown>>) : [];
  } catch (error) {
    // One unreadable channel must not abandon the rest of the workspace.
    console.warn(
      `slack history read failed for ${channelId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

// Deep enough to cover a busy week in an active channel without paging. A channel that outruns it
// undercounts rather than failing, which is the safer direction for a badge.
const SLACK_HISTORY_LIMIT = 400;

/**
 * Resolves Slack user ids for members the roster has never linked to Slack, by email against the
 * workspace directory -- the seam a member self-editing `slack_user_id` normally fills in by hand.
 * One directory listing covers the whole workspace, so this never scales with roster size the way
 * a per-member CLI call would.
 */
export function createSlackDirectoryEmailResolver(repoRoot: string) {
  return async function resolveSlackUserIdsByEmail(
    emails: readonly string[],
  ): Promise<Map<string, string>> {
    const wanted = new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean));
    const resolved = new Map<string, string>();
    if (wanted.size === 0) {
      return resolved;
    }
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          path.join(repoRoot, "openclaw.mjs"),
          "directory",
          "peers",
          "list",
          "--channel",
          "slack",
          "--json",
        ],
        { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      );
      const entries = JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]") as Array<{
        id?: string;
        raw?: { profile?: { email?: string } };
      }>;
      for (const entry of entries) {
        const email = entry.raw?.profile?.email?.trim().toLowerCase();
        if (!email || !wanted.has(email)) {
          continue;
        }
        // Directory entries prefix the channel-native id (e.g. "user:U0123456789") to keep it
        // distinct from other channels' ids; the roster wants the bare Slack user id.
        const bareId = entry.id?.replace(/^user:/, "").trim();
        if (bareId) {
          resolved.set(email, bareId);
        }
      }
    } catch (error) {
      console.warn(
        `slack directory lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return resolved;
  };
}

// Private/loopback/link-local ranges (including Tailscale's 100.64.0.0/10 CGNAT block) never
// resolve to a meaningful public location, and sending them to a public geolocation API would
// either fail or return the API provider's own location -- worse than leaving the field alone.
const NON_ROUTABLE_IP_PATTERNS: readonly RegExp[] = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe80:/i,
];

export function isNonRoutableIp(ip: string): boolean {
  return NON_ROUTABLE_IP_PATTERNS.some((pattern) => pattern.test(ip));
}

/**
 * Geolocates a login's source IP to a human-readable "City, Region, Country" string via ipapi.co
 * (free tier, no API key). Returns undefined for anything that should not overwrite the member's
 * existing location -- a private/loopback address, a network error, or a provider-side failure --
 * so a flaky lookup can never blank out a value that was previously set.
 */
export function createIpLocationResolver() {
  return async function geolocateIp(ip: string): Promise<string | undefined> {
    if (isNonRoutableIp(ip)) {
      return undefined;
    }
    try {
      const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        return undefined;
      }
      const data = (await res.json()) as {
        error?: boolean;
        city?: string;
        region?: string;
        country_name?: string;
      };
      if (data.error) {
        return undefined;
      }
      const parts = [data.city, data.region, data.country_name]
        .map((part) => part?.trim())
        .filter((part): part is string => Boolean(part));
      return parts.length > 0 ? parts.join(", ") : undefined;
    } catch (error) {
      console.warn(
        `ip geolocation lookup failed for ${ip}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };
}

/** Builds the AdminBot service with every executor wired. */
export function createAdminBotHost(deps: AdminBotHostDeps) {
  const { repoRoot } = deps;
  return createAdminBotMockService({
    databasePath: path.join(repoRoot, "state/adminbot.sqlite"),
    auditRetentionDays: AUDIT_RETENTION_DAYS,
    executor: createCompositeAdminBotExecutor([
      createAdminBotOverleafExecutor(),
      createAdminBotSocialExecutor(),
      createAdminBotSlackAdminExecutor(),
      createAdminBotMessageExecutor({
        command: process.execPath,
        commandArgsPrefix: [path.join(repoRoot, "openclaw.mjs")],
      }),
      createGogAdminBotExecutor(),
      // Reviewing-cycle reminders post through OpenReview's own message invitations.
      // ADMINBOT_OPENREVIEW_SEND is the deploy-time kill switch: without it every approved
      // reminder is composed and validated but not delivered.
      createAdminBotOpenReviewExecutor({
        scriptPath: path.join(repoRoot, "scripts/adminbot-openreview.py"),
        send: process.env.ADMINBOT_OPENREVIEW_SEND === "1",
      }),
    ]),
    ...(deps.inviteToSlackConnect ? { inviteToSlackConnect: deps.inviteToSlackConnect } : {}),
    sensitiveInfoPath: path.join(os.homedir(), ".openclaw/adminbot-sensitive-information.md"),
    emailAutomationRunner: deps.runEmailAutomation,
    reimbursementWorkflow: createAdminBotReimbursementWorkflow({
      formScriptPath: path.join(repoRoot, "scripts/adminbot-reimbursement-from-email.py"),
    }),
    openReviewScriptPath: path.join(repoRoot, "scripts/adminbot-openreview.py"),
    dcsFormScriptPath: path.join(repoRoot, "scripts/adminbot-dcs-form-submit.ts"),
    fetchSlackLocations: createSlackLocationReader(repoRoot),
    fetchSlackTimezones: createSlackTimezoneReader(repoRoot),
    fetchSlackMessageCounts: createSlackMessageCounter(repoRoot),
    resolveSlackUserIdsByEmail: createSlackDirectoryEmailResolver(repoRoot),
    // No `geolocateIp` here on purpose. PR #17 replaced the city-level ipapi.co lookup below with
    // the country/continent IPinfo Lite one, which api/server.ts builds itself from IPINFO_TOKEN.
    // The old resolver wrote "City, Region, Country" straight into the member's `location` field —
    // the self-reported one — which the new contract explicitly forbids inferred data from
    // touching. createIpLocationResolver is now unwired; it and its tests can go once nothing
    // else wants a city-level lookup.
    slackChannelNamingSweepIntervalMs: 60 * 60 * 1000,
    deviceTokenIssuer: createDeviceTokenIssuer(deps),
    devicePairingApprover: createDevicePairingApprover(deps),
  });
}

/** Builds the service, starts listening, and keeps the process alive when launched detached. */
export async function startAdminBotHost(deps: AdminBotHostDeps): Promise<void> {
  loadOpenClawEnv();
  console.log(`AdminBot NVIDIA NIM configured: ${process.env.NVIDIA_API_KEY ? "yes" : "no"}`);
  const port = resolveServicePort();
  const service = createAdminBotHost(deps);
  await service.listen(port, SERVICE_HOST);
  console.log(
    `AdminBot service with live gog/social/overleaf/message/openreview execution running on http://${SERVICE_HOST}:${port}`,
  );
  // Keep the service alive even when launched detached without an interactive stdin.
  setInterval(() => {}, 2 ** 31 - 1);
}

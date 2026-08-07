import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createAccountApprovedEmailRunner } from "./account-approved-email.js";
import {
  AdminBotAuthService,
  type AdminBotAuthResponse,
  type AdminBotMemberPrincipal,
} from "./auth.js";
import { createCalendarInviteRunner } from "./calendar-invite.js";
import { adminBotRegistrationStatuses } from "./contracts.js";
import type {
  AdminBotActionProposal,
  AdminBotApprovalRequest,
  AdminBotExecutionRequest,
  AdminBotLabMemberInput,
  AdminBotMemberNudgeChannel,
  AdminBotMemberNudgeRequest,
  AdminBotPaperRecordInput,
  AdminBotPrivacyTaskRequest,
  AdminBotRegistrationStatus,
  AdminBotRemovePendingRequest,
  AdminBotSettingsInput,
} from "./contracts.js";
import { DEADLINE_VENUES } from "./deadlines-dataset.js";
import { renderDeadlinesWebUi } from "./deadlines-web-ui.js";
import { allowedGatewayScopesForPrivilege } from "./device-pairing-scopes.js";
import {
  createAdminBotOpenReviewWorkflow,
  type AdminBotOpenReviewWorkflow,
} from "./openreview-workflow.js";
import { createAdminBotPrivacyBroker, type AdminBotPrivacyBroker } from "./privacy-broker.js";
import type {
  AdminBotReimbursementRequest,
  AdminBotReimbursementWorkflow,
} from "./reimbursement-workflow.js";
import {
  createAdminBotSensitiveInfoDocument,
  type AdminBotSensitiveInfoDocument,
} from "./sensitive-info-doc.js";
import {
  AdminBotMemoryStore,
  AdminBotService,
  type AdminBotActionExecutor,
  type AdminBotServiceOptions,
  type AdminBotServiceResponse,
  type AdminBotServiceStore,
} from "./service-core.js";
import { createAdminBotSqliteService } from "./service-sqlite.js";
import { renderAdminBotWebUi } from "./web-ui.js";

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:18789",
  "http://127.0.0.1:18789",
];
const SESSION_COOKIE = "adminbot_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 604800;

export type AdminBotMockServiceOptions = {
  databasePath?: string;
  auditRetentionDays?: number;
  executor?: AdminBotActionExecutor;
  privacyBroker?: AdminBotPrivacyBroker;
  sensitiveInfoPath?: string;
  sensitiveInfoDocument?: AdminBotSensitiveInfoDocument;
  emailAutomationRunner?: () => Promise<unknown>;
  reimbursementWorkflow?: AdminBotReimbursementWorkflow;
  serviceToken?: string;
  gatewayToken?: string;
  gatewayUrl?: string;
  allowedOrigins?: string[];
  // Overrides the default `gws` CLI-backed calendar invite runner — used by tests to avoid
  // shelling out to a real `gws` binary.
  calendarInviteRunner?: (email: string) => Promise<void>;
  // Same for the `gog` CLI-backed "your account is approved" email.
  accountApprovedEmailRunner?: (params: { email: string; name?: string }) => Promise<void>;
  // Approves a pending gateway device pairing on behalf of a signed-in member. Injected from the
  // repo-root composition layer (start-adminbot.mjs) so the extension never imports core
  // device-pairing internals. `allowedScopes` is the ceiling derived from the member's privilege;
  // the approver must not grant beyond it. Absent in unit/mock setups that don't test pairing.
  devicePairingApprover?: DevicePairingApprover;
  // Pairs a member's browser device and mints a gateway token bound to it, so the browser never
  // needs the shared gateway secret to open its first connection. Injected from the repo-root
  // composition layer for the same boundary reason as devicePairingApprover.
  deviceTokenIssuer?: DeviceTokenIssuer;
  // Path to scripts/adminbot-openreview.py. Injected as a path rather than a built
  // workflow because the workflow needs the store this factory owns; absent in unit
  // setups, which leaves every /openreview route reporting 503 rather than half-working.
  openReviewScriptPath?: string;
  openReviewPythonCommand?: string;
  // Reads each member's location from their Slack profile. Injected from the repo-root
  // composition layer, which owns how Slack is reached; absent here means the map falls
  // back to roster locations for everyone.
  fetchSlackLocations?: (slackUserIds: string[]) => Promise<ReadonlyMap<string, string>>;
};

export type DeviceTokenIssuance =
  | { ok: true; token: string; scopes: string[] }
  | {
      ok: false;
      reason: "unsupported" | "failed";
      message?: string;
    };

export type DeviceTokenIssuer = (params: {
  deviceId: string;
  publicKey: string;
  platform?: string;
  deviceFamily?: string;
  displayName?: string;
  allowedScopes: readonly string[];
}) => Promise<DeviceTokenIssuance>;

export type DevicePairingApproval =
  | { ok: true }
  | {
      ok: false;
      reason: "unknown_request" | "scope_exceeds_privilege" | "failed";
      message?: string;
    };

export type DevicePairingApprover = (params: {
  requestId: string;
  allowedScopes: readonly string[];
}) => Promise<DevicePairingApproval>;

type AdminBotPrincipal =
  | { kind: "service" }
  | { kind: "anonymous"; ip?: string }
  | AdminBotMemberPrincipal;

// Reimbursement is deliberately usable without an account: the forms carry only the claimant's own
// details, which they are typing in anyway. The anonymous principal therefore reaches these two
// routes and nothing else -- it is rejected by isPrivileged, carries no member, and is re-checked
// against this list before any handler runs, so a new route cannot become anonymously reachable by
// being added to handleAuthenticatedRoute.
const ANONYMOUS_ROUTES = new Set(["/reimbursements/converse", "/reimbursements/generate"]);

function isAnonymousRoute(method: string | undefined, pathname: string): boolean {
  return method === "POST" && ANONYMOUS_ROUTES.has(pathname);
}

// Anonymous callers are unauthenticated by design, so the only abuse control left is volume. These
// caps are per-IP and generous enough that a real claimant filling one packet never notices; they
// exist to stop the open endpoint being used as free inference against the local model.
const ANONYMOUS_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const ANONYMOUS_RATE_LIMIT_MAX_REQUESTS = 60;
const ANONYMOUS_RATE_LIMIT_MAX_TRACKED_IPS = 10_000;

type AnonymousRateLimiter = { check(ip: string | undefined): boolean };

function createAnonymousRateLimiter(): AnonymousRateLimiter {
  const hits = new Map<string, number[]>();
  return {
    check(ip) {
      const key = ip ?? "unknown";
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter(
        (at) => now - at < ANONYMOUS_RATE_LIMIT_WINDOW_MS,
      );
      if (recent.length >= ANONYMOUS_RATE_LIMIT_MAX_REQUESTS) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      // Unbounded growth would be its own denial of service, so the map is swept once it is large
      // rather than kept forever for IPs that have gone quiet.
      if (hits.size > ANONYMOUS_RATE_LIMIT_MAX_TRACKED_IPS) {
        for (const [trackedIp, timestamps] of hits) {
          if (timestamps.every((at) => now - at >= ANONYMOUS_RATE_LIMIT_WINDOW_MS)) {
            hits.delete(trackedIp);
          }
        }
      }
      return true;
    },
  };
}

type AdminBotRouteContext = {
  service: AdminBotService;
  auth: AdminBotAuthService;
  privacyBroker: AdminBotPrivacyBroker;
  sensitiveInfo: AdminBotSensitiveInfoDocument;
  runEmailAutomation?: () => Promise<unknown>;
  reimbursementWorkflow?: AdminBotReimbursementWorkflow;
  openReviewWorkflow?: AdminBotOpenReviewWorkflow;
  fetchSlackLocations?: (slackUserIds: string[]) => Promise<ReadonlyMap<string, string>>;
  serviceToken?: string;
  devicePairingApprover?: DevicePairingApprover;
  deviceTokenIssuer?: DeviceTokenIssuer;
  allowedOrigins: Set<string>;
  anonymousRateLimiter: AnonymousRateLimiter;
};

export function createAdminBotMockService(options: AdminBotMockServiceOptions = {}) {
  let store: AdminBotServiceStore;
  let service: AdminBotService;
  let closeDurable: () => void = () => {};
  if (options.databasePath) {
    const durable = createAdminBotSqliteService({
      databasePath: options.databasePath,
      ...serviceOptions(options),
    });
    store = durable.store;
    service = durable.service;
    closeDurable = durable.close;
  } else {
    store = new AdminBotMemoryStore();
    service = new AdminBotService(store, serviceOptions(options));
  }
  const gatewayToken = trimmedEnv(options.gatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN);
  // No default: a loopback URL is only reachable by a browser on this host, so guessing one and
  // handing it to a remote member replaced their working gateway URL with a dead one. Left unset,
  // the client keeps the URL it already connects with.
  const gatewayUrl = trimmedEnv(options.gatewayUrl ?? process.env.ADMINBOT_GATEWAY_WS_URL);
  const serviceToken = trimmedEnv(options.serviceToken ?? process.env.ADMINBOT_SERVICE_TOKEN);
  const allowedOrigins = new Set(
    options.allowedOrigins ??
      parseOrigins(process.env.ADMINBOT_ALLOWED_ORIGINS) ??
      DEFAULT_ALLOWED_ORIGINS,
  );
  const auth = new AdminBotAuthService({
    store,
    // Signup approval mints a roster member through the same governed path as any admin edit so
    // access grants and validation stay identical.
    createMember: (input) => {
      const result = service.upsertLabMember(input);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.payload;
    },
    inviteToLabCalendar: options.calendarInviteRunner ?? createCalendarInviteRunner(),
    sendAccountApprovedEmail:
      options.accountApprovedEmailRunner ?? createAccountApprovedEmailRunner(),
    ...(gatewayToken ? { gatewayToken } : {}),
    ...(gatewayUrl ? { gatewayUrl } : {}),
  });
  const sensitiveInfo =
    options.sensitiveInfoDocument ??
    createAdminBotSensitiveInfoDocument({
      filePath: options.sensitiveInfoPath,
    });
  const privacyBroker =
    options.privacyBroker ??
    createAdminBotPrivacyBroker(undefined, {
      sensitiveTermsProvider: () => sensitiveInfo.listSensitiveTerms(),
    });
  let activeEmailAutomation: Promise<unknown> | undefined;
  const emailAutomationRunner = options.emailAutomationRunner;
  const runEmailAutomation = emailAutomationRunner
    ? () => {
        activeEmailAutomation ??= emailAutomationRunner().finally(() => {
          activeEmailAutomation = undefined;
        });
        return activeEmailAutomation;
      }
    : undefined;
  const openReviewWorkflow = options.openReviewScriptPath
    ? createAdminBotOpenReviewWorkflow({
        scriptPath: options.openReviewScriptPath,
        ...(options.openReviewPythonCommand
          ? { pythonCommand: options.openReviewPythonCommand }
          : {}),
        service,
        store,
      })
    : undefined;
  const ctx: AdminBotRouteContext = {
    service,
    auth,
    privacyBroker,
    sensitiveInfo,
    ...(runEmailAutomation ? { runEmailAutomation } : {}),
    ...(options.reimbursementWorkflow
      ? { reimbursementWorkflow: options.reimbursementWorkflow }
      : {}),
    ...(serviceToken ? { serviceToken } : {}),
    ...(options.devicePairingApprover
      ? { devicePairingApprover: options.devicePairingApprover }
      : {}),
    ...(options.deviceTokenIssuer ? { deviceTokenIssuer: options.deviceTokenIssuer } : {}),
    ...(openReviewWorkflow ? { openReviewWorkflow } : {}),
    ...(options.fetchSlackLocations ? { fetchSlackLocations: options.fetchSlackLocations } : {}),
    allowedOrigins,
    anonymousRateLimiter: createAnonymousRateLimiter(),
  };
  const server = createServer(async (req, res) => {
    try {
      await routeRequest(req, res, ctx);
    } catch (error) {
      sendJson(res, 500, {
        error: { message: error instanceof Error ? error.message : "mock service failed" },
      });
    }
  });
  return {
    server,
    service,
    auth,
    async listen(port = 8765, host = "127.0.0.1") {
      await listen(server, port, host);
      return `http://${host}:${port}`;
    },
    close() {
      closeDurable();
    },
  };
}

function serviceOptions(options: AdminBotMockServiceOptions): AdminBotServiceOptions {
  return {
    ...(typeof options.auditRetentionDays === "number"
      ? { auditRetentionDays: options.auditRetentionDays }
      : {}),
    ...(options.executor ? { executor: options.executor } : {}),
  };
}

async function routeRequest(req: IncomingMessage, res: ServerResponse, ctx: AdminBotRouteContext) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  applyCors(req, res, ctx.allowedOrigins);
  if (req.method === "OPTIONS") {
    // CORS preflight: headers already set by applyCors; body-less 204.
    res.statusCode = 204;
    res.end();
    return;
  }

  // Exempt public surfaces: HTML shells and the auth endpoints themselves.
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/adminbot")) {
    sendHtml(res, 200, renderAdminBotWebUi());
    return;
  }
  if (req.method === "GET" && url.pathname === "/deadlines") {
    sendHtml(res, 200, renderDeadlinesWebUi(DEADLINE_VENUES));
    return;
  }
  if (req.method === "GET" && url.pathname === "/deadlines/venues.json") {
    sendJson(res, 200, { items: DEADLINE_VENUES });
    return;
  }
  if (url.pathname.startsWith("/auth/")) {
    await handleAuthRoute(req, res, ctx, url);
    return;
  }

  const principal = resolvePrincipal(req, ctx);
  if (!principal) {
    if (!isAnonymousRoute(req.method, url.pathname)) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const ip = remoteIp(req);
    if (!ctx.anonymousRateLimiter.check(ip)) {
      ctx.service.recordAnonymousReimbursementUse({
        route: url.pathname,
        outcome: "rate_limited",
        ...(ip ? { ip } : {}),
      });
      sendJson(res, 429, {
        error: { message: "too many reimbursement requests; please try again later" },
      });
      return;
    }
    ctx.service.recordAnonymousReimbursementUse({
      route: url.pathname,
      outcome: "accepted",
      ...(ip ? { ip } : {}),
    });
    await handleAuthenticatedRoute(req, res, ctx, url, {
      kind: "anonymous",
      ...(ip ? { ip } : {}),
    });
    return;
  }
  await handleAuthenticatedRoute(req, res, ctx, url, principal);
}

async function handleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
  url: URL,
): Promise<void> {
  if (req.method === "GET" && url.pathname === "/auth/roster") {
    sendJson(res, 200, { members: ctx.auth.listRoster() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/claim") {
    const body = readRecord(await readJson(req));
    const result = ctx.auth.claim({
      member_id: asString(body.member_id),
      email: asString(body.email),
      password: asString(body.password),
      ...(remoteIp(req) ? { remoteIp: remoteIp(req) } : {}),
    });
    sendAuthResult(res, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/signup") {
    const body = readRecord(await readJson(req));
    const result = ctx.auth.signup({
      profile: readRecord(body.profile),
      email: asString(body.email),
      password: asString(body.password),
      ...(remoteIp(req) ? { remoteIp: remoteIp(req) } : {}),
    });
    sendAuthResult(res, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/login") {
    const body = readRecord(await readJson(req));
    const result = ctx.auth.login({
      email: asString(body.email),
      password: asString(body.password),
      ...(remoteIp(req) ? { remoteIp: remoteIp(req) } : {}),
    });
    if (!result.ok && result.code === "pending_approval") {
      // Distinct body so the client can route the applicant to a "waiting for approval" state.
      sendJson(res, result.status, { error: result.error.message, code: result.code });
      return;
    }
    sendAuthResult(res, result);
    return;
  }
  if (url.pathname === "/auth/registrations" || url.pathname.startsWith("/auth/registrations/")) {
    await handleRegistrationRoute(req, res, ctx, url);
    return;
  }
  if (req.method === "GET" && url.pathname === "/auth/session") {
    const principal = resolvePrincipal(req, ctx);
    if (!principal || principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    sendJson(res, 200, ctx.auth.sessionView(principal));
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/pair-device") {
    await handlePairDeviceRoute(req, res, ctx);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/device-token") {
    await handleDeviceTokenRoute(req, res, ctx);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/logout") {
    const principal = resolvePrincipal(req, ctx);
    if (!principal || principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const token = bearerToken(req) ?? cookieToken(req);
    if (token) {
      ctx.auth.logout(token);
    }
    clearSessionCookie(res);
    sendJson(res, 200, { logged_out: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/password") {
    const principal = resolvePrincipal(req, ctx);
    if (!principal || principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    const result = ctx.auth.changePassword(
      principal.member.id,
      asString(body.current_password),
      asString(body.new_password),
    );
    sendAuthResult(res, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/email") {
    const principal = resolvePrincipal(req, ctx);
    if (!principal) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    if (principal.kind !== "member") {
      // The service principal has no credential to reverify; email change is a member-only action.
      sendJson(res, 400, { error: { message: "member principal required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    const result = ctx.auth.changeEmail(
      principal.member.id,
      asString(body.new_email),
      asString(body.current_password),
      remoteIp(req),
    );
    sendAuthResult(res, result);
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}

// Registration review is admin/service-only, so it resolves a principal even though it lives under
// the otherwise-public /auth/ prefix.
async function handleRegistrationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
  url: URL,
): Promise<void> {
  const principal = resolvePrincipal(req, ctx);
  if (!principal) {
    sendJson(res, 401, { error: { message: "authentication required" } });
    return;
  }
  if (!requirePrivileged(res, principal)) {
    return;
  }
  const decidedBy = principalActor(principal);
  if (req.method === "GET" && url.pathname === "/auth/registrations") {
    const raw = url.searchParams.get("status");
    const status = adminBotRegistrationStatuses.includes(raw as AdminBotRegistrationStatus)
      ? (raw as AdminBotRegistrationStatus)
      : "pending";
    sendJson(res, 200, { registrations: ctx.auth.listRegistrations(status) });
    return;
  }
  const approve = /^\/auth\/registrations\/([^/]+)\/approve$/u.exec(url.pathname);
  if (req.method === "POST" && approve?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    sendAuthResult(res, ctx.auth.approveRegistration(decodeURIComponent(approve[1]), decidedBy));
    return;
  }
  const reject = /^\/auth\/registrations\/([^/]+)\/reject$/u.exec(url.pathname);
  if (req.method === "POST" && reject?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    sendAuthResult(res, ctx.auth.rejectRegistration(decodeURIComponent(reject[1]), decidedBy));
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}

function principalActor(principal: AdminBotPrincipal): string {
  if (principal.kind === "service") {
    return "service";
  }
  return principal.kind === "anonymous" ? "anonymous" : principal.member.id;
}

// Approves a pending gateway device pairing for the signed-in member, with scopes capped by their
// privilege. This is what makes member-side gateway enforcement automatic: the member's own login
// session authorizes their browser's device, and the injected approver binds member-appropriate
// scopes server-side. The shared service principal is denied outright — otherwise any agent tool
// call could pair itself a write-scoped device and re-open the escalation this closes.
async function handlePairDeviceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
): Promise<void> {
  const principal = resolvePrincipal(req, ctx);
  if (!principal || principal.kind !== "member") {
    sendJson(res, 401, { error: { message: "member session required" } });
    return;
  }
  if (!ctx.devicePairingApprover) {
    sendJson(res, 503, { error: { message: "device pairing is not configured" } });
    return;
  }
  const body = readRecord(await readJson(req));
  const requestId = asString(body.requestId);
  if (!requestId) {
    sendJson(res, 400, { error: { message: "requestId is required" } });
    return;
  }
  const allowedScopes = allowedGatewayScopesForPrivilege(principal.member.privilege_level);
  const result = await ctx.devicePairingApprover({ requestId, allowedScopes });
  if (result.ok) {
    sendJson(res, 200, { approved: true, scopes: allowedScopes });
    return;
  }
  if (result.reason === "unknown_request") {
    sendJson(res, 404, { error: { message: "no pending pairing for this request" } });
    return;
  }
  if (result.reason === "scope_exceeds_privilege") {
    sendJson(res, 403, {
      error: {
        message: "this device requested more access than your account allows",
      },
    });
    return;
  }
  sendJson(res, 502, {
    error: { message: result.message ?? "device pairing approval failed" },
  });
}

// Issues the signed-in member's browser a gateway token bound to its own device key, scoped to
// their privilege. Without this the browser can only reach the gateway by holding the shared
// gateway secret, which every member would then possess -- the escalation this whole design
// closes -- and a member with no secret is stuck at a manual "paste a token" prompt instead.
//
// A member can only ever mint a token for a device key they present, capped at their own
// privilege, so claiming someone else's device id buys nothing they could not get with their own.
async function handleDeviceTokenRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
): Promise<void> {
  const principal = resolvePrincipal(req, ctx);
  if (!principal || principal.kind !== "member") {
    sendJson(res, 401, { error: { message: "member session required" } });
    return;
  }
  if (!ctx.deviceTokenIssuer) {
    sendJson(res, 503, { error: { message: "device token issuance is not configured" } });
    return;
  }
  const body = readRecord(await readJson(req));
  const deviceId = asString(body.deviceId);
  const publicKey = asString(body.publicKey);
  if (!deviceId || !publicKey) {
    sendJson(res, 400, { error: { message: "deviceId and publicKey are required" } });
    return;
  }
  const platform = asString(body.platform);
  const deviceFamily = asString(body.deviceFamily);
  const allowedScopes = allowedGatewayScopesForPrivilege(principal.member.privilege_level);
  const result = await ctx.deviceTokenIssuer({
    deviceId,
    publicKey,
    ...(platform ? { platform } : {}),
    ...(deviceFamily ? { deviceFamily } : {}),
    displayName: principal.member.name,
    allowedScopes,
  });
  if (result.ok) {
    sendJson(res, 200, { token: result.token, scopes: result.scopes, deviceId });
    return;
  }
  // "unsupported" means the gateway has no shared secret to bind the token to, so the browser
  // must keep using whatever credential it already has rather than retry forever.
  sendJson(res, result.reason === "unsupported" ? 501 : 502, {
    error: { message: result.message ?? "device token issuance failed" },
  });
}

// An approval must name a real person, so the shared service principal (which every agent tool
// call authenticates as) cannot supply one.
function approverIdentityFor(
  principal: AdminBotPrincipal,
): { approver_role: string; approver_id: string } | undefined {
  // Only a member principal names a person: the shared service principal is anonymous by
  // construction, and the anonymous reimbursement principal has no account at all.
  if (principal.kind !== "member") {
    return undefined;
  }
  return {
    approver_role: principal.member.privilege_level,
    approver_id: principal.member.id,
  };
}

async function handleAuthenticatedRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
  url: URL,
  principal: AdminBotPrincipal,
): Promise<void> {
  // Re-assert the anonymous boundary here rather than trusting the caller: this function is the
  // single entry point for every authenticated route, so a route added later is denied to
  // anonymous callers unless it is explicitly added to ANONYMOUS_ROUTES.
  if (principal.kind === "anonymous" && !isAnonymousRoute(req.method, url.pathname)) {
    sendJson(res, 401, { error: { message: "authentication required" } });
    return;
  }
  const { service, privacyBroker, sensitiveInfo } = ctx;
  if (req.method === "POST" && url.pathname === "/automation/email/run") {
    // Triggers outbound email on behalf of the lab; not a per-member action.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    if (!ctx.runEmailAutomation) {
      sendJson(res, 503, { error: { message: "email automation runner is not configured" } });
      return;
    }
    sendJson(res, 200, await ctx.runEmailAutomation());
    return;
  }
  if (req.method === "GET" && url.pathname === "/member-map") {
    // Where everyone is, by name. Privileged rather than public: the doc calls this a
    // public website function, but publishing 144 people's locations is a decision to
    // make deliberately, not a side effect of building the view.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, service.memberMap());
    return;
  }
  if (req.method === "POST" && url.pathname === "/member-map/refresh") {
    if (!requirePrivileged(res, principal)) {
      return;
    }
    if (!ctx.fetchSlackLocations) {
      sendJson(res, 503, { error: { message: "slack location lookup is not configured" } });
      return;
    }
    sendServiceResult(
      res,
      await service.refreshMemberMap(ctx.fetchSlackLocations, principalActor(principal)),
    );
    return;
  }
  if (url.pathname.startsWith("/openreview/")) {
    // The whole reviewing-cycle surface is admin-only: it mails conference committees
    // under Zhijing's OpenReview identity and mutates reviewer assignments.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    if (!ctx.openReviewWorkflow) {
      sendJson(res, 503, { error: { message: "openreview workflow is not configured" } });
      return;
    }
    const workflow = ctx.openReviewWorkflow;
    if (req.method === "GET" && url.pathname === "/openreview/status") {
      sendServiceResult(res, service.listOpenReviewStatus());
      return;
    }
    if (req.method === "POST" && url.pathname === "/openreview/cycle/run") {
      // Dry run unless the caller explicitly asks to send, so a stray trigger of the
      // route reports what it would have done instead of mailing anyone.
      const body = (await readJson(req)) as { send?: boolean } | undefined;
      sendJson(res, 200, await workflow.runCycle({ dryRun: body?.send !== true }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/openreview/load-forms") {
      sendJson(res, 200, { forms: await workflow.loadForms() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/openreview/suggest-reviewers") {
      const venueId = url.searchParams.get("venue");
      if (!venueId) {
        sendJson(res, 400, { error: { message: "venue query parameter is required" } });
        return;
      }
      sendJson(res, 200, { submissions: await workflow.suggestReviewers(venueId) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/openreview/assignments") {
      const body = (await readJson(req)) as {
        venue_id?: string;
        submission?: string;
        reviewer?: string;
        remove?: boolean;
      };
      if (!body?.venue_id || !body?.submission || !body?.reviewer) {
        sendJson(res, 400, {
          error: { message: "venue_id, submission and reviewer are required" },
        });
        return;
      }
      const result = await workflow.applyAssignment({
        venueId: body.venue_id,
        submission: body.submission,
        reviewer: body.reviewer,
        ...(body.remove ? { remove: true } : {}),
      });
      sendJson(res, result.ok === true ? 200 : 502, result);
      return;
    }
  }
  if (req.method === "POST" && url.pathname === "/reimbursements/converse") {
    if (!ctx.reimbursementWorkflow) {
      sendJson(res, 503, { error: { message: "reimbursement workflow is not configured" } });
      return;
    }
    const body = (await readJson(req)) as AdminBotReimbursementRequest;
    sendJson(res, 200, await ctx.reimbursementWorkflow.converse(body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/reimbursements/generate") {
    if (!ctx.reimbursementWorkflow) {
      sendJson(res, 503, { error: { message: "reimbursement workflow is not configured" } });
      return;
    }
    const body = (await readJson(req)) as AdminBotReimbursementRequest;
    sendJson(res, 200, await ctx.reimbursementWorkflow.generate(body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/proposals") {
    const body = (await readJson(req)) as AdminBotActionProposal;
    sendServiceResult(res, service.createProposal(body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/privacy/tasks") {
    const body = (await readJson(req)) as AdminBotPrivacyTaskRequest;
    sendJson(res, 200, await privacyBroker.handle(body));
    return;
  }
  if (req.method === "GET" && url.pathname === "/proposals/pending") {
    // The pending-action queue is a governance surface: plain members must not see what is
    // awaiting approval. Service principal stays allowed so agent tooling can still triage.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit ? Number(rawLimit) : undefined;
    sendServiceResult(res, service.listPending(limit));
    return;
  }
  if (req.method === "GET" && url.pathname === "/lab/members") {
    sendServiceResult(res, service.listLabMembers());
    return;
  }
  if (req.method === "GET" && url.pathname === "/settings") {
    // Lab-wide settings (escalation windows, head professor, applicant sheet id) are
    // governance config, not member-facing data.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, service.getSettings());
    return;
  }
  if (req.method === "PUT" && url.pathname === "/settings") {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = (await readJson(req)) as AdminBotSettingsInput;
    sendServiceResult(res, service.updateSettings(body));
    return;
  }
  if (req.method === "GET" && url.pathname === "/sensitive-info") {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    sendJson(res, 200, await sensitiveInfo.get());
    return;
  }
  if (req.method === "PUT" && url.pathname === "/sensitive-info") {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = readRecord(await readJson(req));
    const markdown = typeof body.markdown === "string" ? body.markdown : "";
    sendJson(res, 200, await sensitiveInfo.update(markdown));
    return;
  }
  if (req.method === "POST" && url.pathname === "/onboarding/ack") {
    // Self-service only: the body names a step, never a member, so this can never reach anyone
    // else's checklist. The shared service principal has no checklist of its own and is denied.
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "member session required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    const stepId = asString(body.step_id);
    if (!stepId) {
      sendJson(res, 400, { error: { message: "step_id is required" } });
      return;
    }
    sendServiceResult(res, service.acknowledgeOwnOnboardingStep(principal.member.id, stepId));
    return;
  }
  if (req.method === "GET" && url.pathname === "/papers/relevant") {
    if (principal.kind !== "member") {
      sendJson(res, 400, { error: { message: "member principal required" } });
      return;
    }
    sendServiceResult(res, service.listPapersRelevantToMember(principal.member.id));
    return;
  }
  const labMember = /^\/lab\/members\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "PUT" && labMember?.[1]) {
    const memberId = decodeURIComponent(labMember[1]);
    const body = readRecord(await readJson(req));
    // Only a genuine admin *member* session (the Control UI's own Bearer) gets the full governance
    // write that can set privilege_level/status/email/access_overrides. The shared service principal
    // drives every agent tool call regardless of which member is chatting, so it must NOT imply
    // admin here; it is limited to the same whitelisted profile fields as a member self-edit (but
    // for any member id, so non-escalation automation can sync those fields). updateOwnProfile
    // rejects governed fields with a clear 4xx and performs no partial write.
    if (principal.kind === "member" && principal.member.privilege_level === "admin") {
      sendServiceResult(
        res,
        service.upsertLabMember({ ...(body as AdminBotLabMemberInput), id: memberId }),
      );
      return;
    }
    if (principal.kind === "service") {
      sendServiceResult(res, service.updateOwnProfile(memberId, body));
      return;
    }
    // Unreachable while this route stays out of ANONYMOUS_ROUTES, but written as an explicit deny
    // so profile writes fail closed rather than depending on a check made elsewhere.
    if (principal.kind === "anonymous") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    if (principal.member.id !== memberId) {
      sendJson(res, 403, { error: { message: "members can only update their own profile" } });
      return;
    }
    sendServiceResult(res, service.updateOwnProfile(memberId, body));
    return;
  }
  if (req.method === "GET" && url.pathname === "/papers") {
    sendServiceResult(res, service.listPapers());
    return;
  }
  const paper = /^\/papers\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "PUT" && paper?.[1]) {
    const paperId = decodeURIComponent(paper[1]);
    // Admins and automation write any paper. A plain member gets the narrower self-service path:
    // their own submissions only, and without the governance fields the paper flow owns.
    if (isPrivileged(principal)) {
      const body = (await readJson(req)) as AdminBotPaperRecordInput;
      sendServiceResult(res, service.upsertPaper({ ...body, id: paperId }));
      return;
    }
    if (principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendServiceResult(res, service.upsertOwnPaper(principal.member.id, { ...body, id: paperId }));
    return;
  }
  if (req.method === "DELETE" && paper?.[1]) {
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(res, service.deletePaper(decodeURIComponent(paper[1])));
    return;
  }
  if (req.method === "GET" && url.pathname === "/papers/nudges") {
    sendServiceResult(res, service.listPaperNudges(url.searchParams.get("now") ?? undefined));
    return;
  }
  const onboardingStep = /^\/lab\/members\/([^/]+)\/onboarding\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "POST" && onboardingStep?.[1] && onboardingStep[2]) {
    const memberId = decodeURIComponent(onboardingStep[1]);
    // Members tick off their own checklist; admins can correct anyone's. The service principal
    // is allowed so the agent can mark a step done when it observes the work (e.g. it just sent
    // the calendar invite) -- this is roster bookkeeping, not an outbound action. An anonymous
    // caller never reaches here: this route is not in ANONYMOUS_ROUTES.
    if (principal.kind === "member" && principal.member.id !== memberId) {
      if (!requirePrivileged(res, principal)) {
        return;
      }
    }
    const body = (await readJson(req)) as { complete?: boolean };
    sendServiceResult(
      res,
      service.setOnboardingStep(
        memberId,
        decodeURIComponent(onboardingStep[2]),
        body.complete !== false,
        principalActor(principal),
      ),
    );
    return;
  }
  const onboardingPending = /^\/onboarding\/([^/]+)\/pending$/u.exec(url.pathname);
  if (req.method === "GET" && onboardingPending?.[1]) {
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendServiceResult(
      res,
      service.listOnboardingStepPending(decodeURIComponent(onboardingPending[1])),
    );
    return;
  }
  const onboardingNudge = /^\/onboarding\/([^/]+)\/nudge$/u.exec(url.pathname);
  if (req.method === "POST" && onboardingNudge?.[1]) {
    // Same reasoning as /nudges/send: this fans out real Slack/email messages to a set of
    // members, so it needs a genuine admin session, not the shared service principal.
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = (await readJson(req)) as {
      channel?: AdminBotMemberNudgeChannel;
      message?: string;
    };
    sendServiceResult(
      res,
      await service.nudgeOnboardingStep(
        {
          step_id: decodeURIComponent(onboardingNudge[1]),
          channel: body.channel ?? "slack",
          ...(body.message ? { message: body.message } : {}),
        },
        principalActor(principal),
      ),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/nudges/send") {
    // Same reasoning as /settings and /sensitive-info: this fans out real Slack/email sends to a
    // chosen set of members, so it must be driven by a genuine admin member session,
    // never the shared service principal every agent tool call authenticates as.
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = (await readJson(req)) as AdminBotMemberNudgeRequest;
    sendServiceResult(res, await service.sendMemberNudge(body, principalActor(principal)));
    return;
  }
  const remove = /^\/proposals\/([^/]+)\/remove$/u.exec(url.pathname);
  if (req.method === "POST" && remove?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const actionId = decodeURIComponent(remove[1]);
    const body = (await readJson(req)) as AdminBotRemovePendingRequest;
    sendServiceResult(res, service.removePending(actionId, body));
    return;
  }
  const approve = /^\/approvals\/([^/]+)\/approve$/u.exec(url.pathname);
  if (req.method === "POST" && approve?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const actionId = decodeURIComponent(approve[1]);
    const body = (await readJson(req)) as AdminBotApprovalRequest;
    // Role and approver id come from the session, never the body: a client-chosen role would make
    // the policy check self-attested, and a client-chosen id would let one person fill a
    // two-person quorum alone.
    const identity = approverIdentityFor(principal);
    if (!identity) {
      sendJson(res, 403, {
        error: {
          message:
            "approvals require an admin or core member session and cannot be recorded by the service principal",
        },
      });
      return;
    }
    sendServiceResult(res, service.approve(actionId, { ...body, ...identity }));
    return;
  }
  const execute = /^\/actions\/([^/]+)\/execute$/u.exec(url.pathname);
  if (req.method === "POST" && execute?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const actionId = decodeURIComponent(execute[1]);
    const body = (await readJson(req)) as AdminBotExecutionRequest;
    sendServiceResult(res, await service.execute(actionId, body));
    return;
  }
  if (req.method === "GET" && url.pathname === "/audit") {
    // Audit events carry auth activity (incl. failed-login emails); admin/core only.
    if (!requirePrivileged(res, principal)) {
      return;
    }
    sendJson(res, 200, { events: service.listAuditEvents() });
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}

// Sensitive routes: service principal, or admin privilege.
function isPrivileged(principal: AdminBotPrincipal): boolean {
  if (principal.kind === "service") {
    return true;
  }
  if (principal.kind === "anonymous") {
    return false;
  }
  const level = principal.member.privilege_level;
  return level === "admin";
}

function requirePrivileged(res: ServerResponse, principal: AdminBotPrincipal): boolean {
  if (isPrivileged(principal)) {
    return true;
  }
  sendJson(res, 403, { error: { message: "insufficient privileges" } });
  return false;
}

// Escalation-sensitive governance (global settings, sensitive-info read/write, registration
// approve/reject) must be driven by a real member session. The shared service principal is used by
// every agent tool call regardless of which member is chatting, so treating it as admin here would
// let any signed-in member perform these actions through the agent. Require an admin member
// Bearer session and deny the service principal outright.
function requireMemberPrivileged(res: ServerResponse, principal: AdminBotPrincipal): boolean {
  if (principal.kind === "service") {
    sendJson(res, 403, {
      error: {
        message:
          "this action requires an admin or core member session and cannot be performed by the service principal",
      },
    });
    return false;
  }
  return requirePrivileged(res, principal);
}

function resolvePrincipal(
  req: IncomingMessage,
  ctx: AdminBotRouteContext,
): AdminBotPrincipal | undefined {
  const bearer = bearerToken(req);
  if (bearer) {
    // Service-principal check first with a constant-time compare. If the env token is unset the
    // service principal is unavailable and this path fails closed.
    if (ctx.serviceToken && constantTimeEqual(bearer, ctx.serviceToken)) {
      return { kind: "service" };
    }
    const member = ctx.auth.resolveSession(bearer);
    if (member) {
      return member;
    }
  }
  const cookie = cookieToken(req);
  if (cookie) {
    const member = ctx.auth.resolveSession(cookie);
    if (member) {
      return member;
    }
  }
  return undefined;
}

function applyCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: Set<string>): void {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !allowedOrigins.has(origin)) {
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

function sendAuthResult<T>(res: ServerResponse, result: AdminBotAuthResponse<T>): void {
  if (result.ok) {
    if (result.sessionToken) {
      setSessionCookie(res, result.sessionToken);
    }
    sendJson(res, result.status, result.payload);
    return;
  }
  const body =
    typeof result.retry_after_seconds === "number"
      ? { error: result.error, retry_after_seconds: result.retry_after_seconds }
      : { error: result.error };
  sendJson(res, result.status, body);
}

// No Secure attribute: the AdminBot service is reached over loopback plain HTTP, where a Secure
// cookie would never be sent back. SameSite=Lax + HttpOnly still block third-party/script access.
function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
  );
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/u.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function cookieToken(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== "string") {
    return undefined;
  }
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) {
      continue;
    }
    if (pair.slice(0, index).trim() === SESSION_COOKIE) {
      return pair.slice(index + 1).trim() || undefined;
    }
  }
  return undefined;
}

function remoteIp(req: IncomingMessage): string | undefined {
  return req.socket.remoteAddress ?? undefined;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return timingSafeEqual(leftBuf, rightBuf);
}

function trimmedEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function parseOrigins(value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

function sendServiceResult<T>(res: ServerResponse, result: AdminBotServiceResponse<T>): void {
  if (result.ok) {
    sendJson(res, result.status, result.payload);
    return;
  }
  sendJson(res, result.status, { error: result.error });
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

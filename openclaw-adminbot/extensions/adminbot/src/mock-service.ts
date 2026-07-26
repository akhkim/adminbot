import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
  AdminBotMemberNudgeRequest,
  AdminBotPaperRecordInput,
  AdminBotPrivacyTaskRequest,
  AdminBotRegistrationStatus,
  AdminBotRemovePendingRequest,
  AdminBotSettingsInput,
} from "./contracts.js";
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

const DEFAULT_GATEWAY_WS_URL = "ws://127.0.0.1:18789";
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
};

type AdminBotPrincipal = { kind: "service" } | AdminBotMemberPrincipal;

type AdminBotRouteContext = {
  service: AdminBotService;
  auth: AdminBotAuthService;
  privacyBroker: AdminBotPrivacyBroker;
  sensitiveInfo: AdminBotSensitiveInfoDocument;
  runEmailAutomation?: () => Promise<unknown>;
  reimbursementWorkflow?: AdminBotReimbursementWorkflow;
  serviceToken?: string;
  allowedOrigins: Set<string>;
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
  const gatewayUrl =
    trimmedEnv(options.gatewayUrl ?? process.env.ADMINBOT_GATEWAY_WS_URL) ?? DEFAULT_GATEWAY_WS_URL;
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
    ...(gatewayToken ? { gatewayToken } : {}),
    gatewayUrl,
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
    allowedOrigins,
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
  if (url.pathname.startsWith("/auth/")) {
    await handleAuthRoute(req, res, ctx, url);
    return;
  }

  const principal = resolvePrincipal(req, ctx);
  if (!principal) {
    sendJson(res, 401, { error: { message: "authentication required" } });
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
  return principal.kind === "service" ? "service" : principal.member.id;
}

async function handleAuthenticatedRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
  url: URL,
  principal: AdminBotPrincipal,
): Promise<void> {
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
    const body = (await readJson(req)) as AdminBotPaperRecordInput;
    sendServiceResult(res, service.upsertPaper({ ...body, id: paperId }));
    return;
  }
  if (req.method === "DELETE" && paper?.[1]) {
    sendServiceResult(res, service.deletePaper(decodeURIComponent(paper[1])));
    return;
  }
  if (req.method === "GET" && url.pathname === "/papers/nudges") {
    sendServiceResult(res, service.listPaperNudges(url.searchParams.get("now") ?? undefined));
    return;
  }
  if (req.method === "POST" && url.pathname === "/nudges/send") {
    // Same reasoning as /settings and /sensitive-info: this fans out real Slack/email sends to a
    // chosen set of members, so it must be driven by a genuine admin/core_member member session,
    // never the shared service principal every agent tool call authenticates as.
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const body = (await readJson(req)) as AdminBotMemberNudgeRequest;
    sendServiceResult(res, service.sendMemberNudge(body, principalActor(principal)));
    return;
  }
  const remove = /^\/proposals\/([^/]+)\/remove$/u.exec(url.pathname);
  if (req.method === "POST" && remove?.[1]) {
    const actionId = decodeURIComponent(remove[1]);
    const body = (await readJson(req)) as AdminBotRemovePendingRequest;
    sendServiceResult(res, service.removePending(actionId, body));
    return;
  }
  const approve = /^\/approvals\/([^/]+)\/approve$/u.exec(url.pathname);
  if (req.method === "POST" && approve?.[1]) {
    if (!requirePrivileged(res, principal)) {
      return;
    }
    const actionId = decodeURIComponent(approve[1]);
    const body = (await readJson(req)) as AdminBotApprovalRequest;
    sendServiceResult(res, service.approve(actionId, body));
    return;
  }
  const execute = /^\/actions\/([^/]+)\/execute$/u.exec(url.pathname);
  if (req.method === "POST" && execute?.[1]) {
    if (!requirePrivileged(res, principal)) {
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

// Sensitive routes: service principal, or admin/core_member privilege.
function isPrivileged(principal: AdminBotPrincipal): boolean {
  if (principal.kind === "service") {
    return true;
  }
  const level = principal.member.privilege_level;
  return level === "admin" || level === "core_member";
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
// let any signed-in member perform these actions through the agent. Require an admin/core_member
// member Bearer session and deny the service principal outright.
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

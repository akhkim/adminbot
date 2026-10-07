// Sign-in, sign-up, sessions, impersonation, password changes, registration review, and device
// pairing: every route under /auth/. These run before a principal is resolved for the request,
// so each one establishes or checks identity itself.
//
// Cut from server.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  adminBotRegistrationStatuses,
  type AdminBotRegistrationStatus,
} from "../../contracts/actions.js";
import type { AdminBotMemberPrincipal } from "../../workflows/identity/auth.js";
import { allowedGatewayScopesForPrivilege } from "../../workflows/identity/device-pairing-scopes.js";
import { sendJson, readRecord, readJson, asString } from "../server.http.js";
import { enrollNewMember, queueNewMemberGuide } from "../server.member-onboarding.js";
import type { AdminBotRouteContext } from "./context.js";
import {
  requirePrivileged,
  principalActor,
  requireMemberPrivileged,
  approverIdentityFor,
} from "./guards.js";
import { memberOnboardingDeps } from "./onboarding.js";
import { remoteIp } from "./origin.js";
import {
  sendAuthResult,
  requestIsSecure,
  clearSessionCookie,
  resolvePrincipal,
  bearerToken,
  cookieToken,
} from "./session.js";

export async function handleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
  url: URL,
): Promise<void> {
  if (req.method === "GET" && url.pathname === "/auth/roster") {
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query.length > 80) {
      sendJson(res, 400, { error: { message: "roster search is too long" } });
      return;
    }
    sendJson(res, 200, { members: await ctx.auth.listRoster(query) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/claim") {
    const body = readRecord(await readJson(req));
    const ip = remoteIp(req, ctx.trustProxyHeaders);
    const result = await ctx.auth.claim({
      member_id: asString(body.member_id),
      email: asString(body.email),
      password: asString(body.password),
      ...(ip ? { remoteIp: ip } : {}),
    });
    sendAuthResult(res, result, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/signup") {
    const body = readRecord(await readJson(req));
    const ip = remoteIp(req, ctx.trustProxyHeaders);
    const result = await ctx.auth.signup({
      profile: readRecord(body.profile),
      email: asString(body.email),
      password: asString(body.password),
      ...(ip ? { remoteIp: ip } : {}),
    });
    sendAuthResult(res, result, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/login") {
    const body = readRecord(await readJson(req));
    const ip = remoteIp(req, ctx.trustProxyHeaders);
    const result = await ctx.auth.login({
      email: asString(body.email),
      password: asString(body.password),
      ...(ip ? { remoteIp: ip } : {}),
    });
    if (!result.ok && result.code === "pending_approval") {
      // Distinct body so the client can route the applicant to a "waiting for approval" state.
      sendJson(res, result.status, { error: result.error.message, code: result.code });
      return;
    }
    sendAuthResult(res, result, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  if (url.pathname === "/auth/registrations" || url.pathname.startsWith("/auth/registrations/")) {
    await handleRegistrationRoute(req, res, ctx, url);
    return;
  }
  if (req.method === "GET" && url.pathname === "/auth/session") {
    const principal = await resolvePrincipal(req, ctx);
    if (!principal || principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    sendJson(res, 200, ctx.auth.sessionView(principal));
    return;
  }
  // Open and close a "view as" session. Both are member-authenticated rather than
  // requirePrivileged: the admin check lives in the auth service, which is also where the
  // no-nesting and not-yourself rules are, so all four refusals are stated in one place.
  if (req.method === "POST" && url.pathname === "/auth/impersonate") {
    const principal = await resolvePrincipal(req, ctx);
    if (!principal || principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const body = readRecord(await readJson(req));
    sendAuthResult(
      res,
      await ctx.auth.startImpersonation({ admin: principal, memberId: asString(body.member_id) }),
      requestIsSecure(req, ctx.trustProxyHeaders),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/impersonate/stop") {
    const token = bearerToken(req) ?? cookieToken(req);
    if (!token) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    // No principal resolution first: an impersonated session that has already expired should still
    // be closable, and the auth service refuses anything that is not an impersonation row anyway.
    sendAuthResult(
      res,
      await ctx.auth.endImpersonation(token),
      requestIsSecure(req, ctx.trustProxyHeaders),
    );
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
    const principal = await resolvePrincipal(req, ctx);
    if (!principal || principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    const token = bearerToken(req) ?? cookieToken(req);
    if (token) {
      await ctx.auth.logout(token);
    }
    clearSessionCookie(res, requestIsSecure(req, ctx.trustProxyHeaders));
    sendJson(res, 200, { logged_out: true });
    return;
  }
  // Both reset routes are deliberately unauthenticated: the whole point is that the caller cannot
  // sign in. The auth service rate-limits them and keeps the response identical for known and
  // unknown addresses, so neither leaks roster membership.
  if (req.method === "POST" && url.pathname === "/auth/password-reset") {
    const body = readRecord(await readJson(req));
    const result = await ctx.auth.requestPasswordReset({
      email: asString(body.email),
      ...(() => {
        const ip = remoteIp(req, ctx.trustProxyHeaders);
        return ip ? { remoteIp: ip } : {};
      })(),
    });
    sendAuthResult(res, result, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/password-reset/confirm") {
    const body = readRecord(await readJson(req));
    const result = await ctx.auth.resetPassword({
      token: asString(body.token),
      newPassword: asString(body.new_password),
    });
    sendAuthResult(res, result, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/password") {
    const principal = await resolvePrincipal(req, ctx);
    if (!principal || principal.kind !== "member") {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    if (refuseWhileImpersonating(res, principal)) {
      return;
    }
    const body = readRecord(await readJson(req));
    const result = await ctx.auth.changePassword(
      principal.member.id,
      asString(body.current_password),
      asString(body.new_password),
    );
    if (result.ok) {
      clearSessionCookie(res, requestIsSecure(req, ctx.trustProxyHeaders));
    }
    sendAuthResult(res, result, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/email") {
    const principal = await resolvePrincipal(req, ctx);
    if (!principal) {
      sendJson(res, 401, { error: { message: "authentication required" } });
      return;
    }
    if (principal.kind !== "member") {
      // The service principal has no credential to reverify; email change is a member-only action.
      sendJson(res, 400, { error: { message: "member principal required" } });
      return;
    }
    if (refuseWhileImpersonating(res, principal)) {
      return;
    }
    const body = readRecord(await readJson(req));
    const result = await ctx.auth.changeEmail(
      principal.member.id,
      asString(body.new_email),
      asString(body.current_password),
      remoteIp(req, ctx.trustProxyHeaders),
    );
    sendAuthResult(res, result, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}

// Registration review is admin/service-only, so it resolves a principal even though it lives under
// the otherwise-public /auth/ prefix.
export async function handleRegistrationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
  url: URL,
): Promise<void> {
  const principal = await resolvePrincipal(req, ctx);
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
    sendJson(res, 200, { registrations: await ctx.auth.listRegistrations(status) });
    return;
  }
  const approve = /^\/auth\/registrations\/([^/]+)\/approve$/u.exec(url.pathname);
  if (req.method === "POST" && approve?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    const approved = await ctx.auth.approveRegistration(decodeURIComponent(approve[1]), decidedBy);
    // A sign-up that created a member is onboarded like every other new member: the access its
    // level grants, approved by this admin, and its guide queued. A claim of an existing roster
    // row created nobody, and was onboarded by whichever path added that row.
    const member =
      approved.ok && approved.payload.member_created
        ? ctx.store.getLabMember(approved.payload.member_id)
        : undefined;
    if (member) {
      const deps = memberOnboardingDeps(ctx, principal, approverIdentityFor(principal));
      // The account is already approved and committed; a failed step is audited by the step itself
      // and must not turn that into an error response.
      // The account address, when the record has none: a sign-up's login email lives on its
      // credential, and it is the address every step here has to reach.
      const email = member.email?.trim() || (approved.ok ? approved.payload.email : "");
      try {
        await enrollNewMember(deps, { ...member, email });
        await queueNewMemberGuide(deps, member.id, { email });
      } catch (error) {
        deps.recordAudit({
          type: "lab_member.member_type_applied",
          actor: decidedBy,
          details: {
            member_id: member.id,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    sendAuthResult(res, approved, requestIsSecure(req, ctx.trustProxyHeaders));
    return;
  }
  const reject = /^\/auth\/registrations\/([^/]+)\/reject$/u.exec(url.pathname);
  if (req.method === "POST" && reject?.[1]) {
    if (!requireMemberPrivileged(res, principal)) {
      return;
    }
    sendAuthResult(
      res,
      await ctx.auth.rejectRegistration(decodeURIComponent(reject[1]), decidedBy),
      requestIsSecure(req, ctx.trustProxyHeaders),
    );
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}

/**
 * Refuse the two routes that change how a member signs in, when the caller is only visiting.
 *
 * Both already demand the member's current password, so an admin cannot reach them anyway -- this
 * turns a confusing "invalid email or password" into an answer, and states the boundary in code
 * rather than leaving it as a property of the password check that a later refactor could drop.
 * The line is between acting *as* an account and taking it over: everything else an impersonated
 * session does is recorded against the admin and can be undone by whoever reads the audit trail,
 * while a changed password or account email locks the member out of their own account.
 */
export function refuseWhileImpersonating(
  res: ServerResponse,
  principal: AdminBotMemberPrincipal,
): boolean {
  if (!principal.impersonator) {
    return false;
  }
  sendJson(res, 403, {
    error: {
      message: "sign-in credentials cannot be changed while viewing as another member",
    },
  });
  return true;
}

// Approves a pending gateway device pairing for the signed-in member, with scopes capped by their
// privilege. This is what makes member-side gateway enforcement automatic: the member's own login
// session authorizes their browser's device, and the injected approver binds member-appropriate
// scopes server-side. The shared service principal is denied outright — otherwise any agent tool
// call could pair itself a write-scoped device and re-open the escalation this closes.
export async function handlePairDeviceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
): Promise<void> {
  const principal = await resolvePrincipal(req, ctx);
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
export async function handleDeviceTokenRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
): Promise<void> {
  const principal = await resolvePrincipal(req, ctx);
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
    memberId: principal.member.id,
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

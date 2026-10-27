// Personal API tokens and `adminbot login`: /auth/api-tokens* and /auth/device/*. The policy lives
// in AdminBotApiTokenService; this module only reads requests and resolves who is asking.
//
// See docs/adminbot/api-tokens.md.

import type { IncomingMessage, ServerResponse } from "node:http";
import { runWithApiToken } from "../../workflows/identity/api-token-context.js";
import type { AdminBotMemberPrincipal } from "../../workflows/identity/auth.js";
import { sendJson, readRecord, readJson } from "../server.http.js";
import type { AdminBotRouteContext } from "./context.js";
import { remoteIp } from "./origin.js";
import { requestIsSecure, resolvePrincipal, sendAuthResult } from "./session.js";

/** True when this module answered the request. */
export async function handleApiTokenRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
  url: URL,
): Promise<boolean> {
  const path = url.pathname;
  if (
    path !== "/auth/api-tokens" &&
    !path.startsWith("/auth/api-tokens/") &&
    !path.startsWith("/auth/device/")
  ) {
    return false;
  }
  const secure = requestIsSecure(req, ctx.trustProxyHeaders);
  const ip = remoteIp(req, ctx.trustProxyHeaders);

  // The two anonymous steps of `adminbot login`: the CLI has no credential until poll succeeds.
  if (req.method === "POST" && url.pathname === "/auth/device/start") {
    const body = readRecord(await readJson(req, 4096));
    sendAuthResult(
      res,
      await ctx.apiTokens.startDeviceLogin({
        name: body.name,
        expires_in_days: body.expires_in_days,
        ...(ip ? { remoteIp: ip } : {}),
      }),
      secure,
    );
    return true;
  }
  if (req.method === "POST" && url.pathname === "/auth/device/poll") {
    const body = readRecord(await readJson(req, 4096));
    res.setHeader("Cache-Control", "no-store");
    sendAuthResult(res, await ctx.apiTokens.pollDeviceLogin(body.device_code), secure);
    return true;
  }

  const principal = await resolvePrincipal(req, ctx);
  if (!principal || principal.kind !== "member") {
    sendJson(res, 401, { error: { message: "member sign-in required" } });
    return true;
  }
  await runWithApiToken(principal.apiToken, () =>
    handleMemberRoute(req, res, ctx, url, principal, ip, secure),
  );
  return true;
}

async function handleMemberRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminBotRouteContext,
  url: URL,
  principal: AdminBotMemberPrincipal,
  ip: string | undefined,
  secure: boolean,
): Promise<void> {
  if (req.method === "GET" && url.pathname === "/auth/api-tokens") {
    sendJson(res, 200, {
      allowed: ctx.apiTokens.allowedFor(principal),
      tokens: await ctx.apiTokens.list(principal),
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/api-tokens") {
    const body = readRecord(await readJson(req, 4096));
    res.setHeader("Cache-Control", "no-store");
    sendAuthResult(
      res,
      await ctx.apiTokens.create(principal, {
        name: body.name,
        expires_in_days: body.expires_in_days,
        password: body.password,
        ...(ip ? { remoteIp: ip } : {}),
      }),
      secure,
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/api-tokens/revoke-all") {
    sendAuthResult(res, await ctx.apiTokens.revokeAll(principal), secure);
    return;
  }
  const one = /^\/auth\/api-tokens\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "DELETE" && one) {
    sendAuthResult(res, await ctx.apiTokens.revoke(principal, one[1]!), secure);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/device/lookup") {
    const body = readRecord(await readJson(req, 4096));
    sendAuthResult(res, await ctx.apiTokens.describeDeviceLogin(principal, body.user_code), secure);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/device/approve") {
    const body = readRecord(await readJson(req, 4096));
    sendAuthResult(
      res,
      await ctx.apiTokens.approveDeviceLogin(principal, {
        user_code: body.user_code,
        password: body.password,
      }),
      secure,
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/device/deny") {
    const body = readRecord(await readJson(req, 4096));
    sendAuthResult(res, await ctx.apiTokens.denyDeviceLogin(principal, body.user_code), secure);
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}

/**
 * Refuses a request made with an API token, for the routes a token must never reach: changing the
 * owner's password or email, impersonation, and pairing gateway devices. A leaked token can then
 * neither lock its owner out nor turn itself into a longer-lived credential.
 */
export function refuseApiToken(res: ServerResponse, principal: AdminBotMemberPrincipal): boolean {
  if (!principal.apiToken) {
    return false;
  }
  sendJson(res, 403, {
    error: { message: "not available with an API token; sign in to AdminBot in a browser" },
  });
  return true;
}

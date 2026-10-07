import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminBotAuthResponse } from "../../workflows/identity/auth.js";
import { sendJson } from "../server.http.js";
import type { AdminBotRouteContext, AdminBotPrincipal } from "./context.js";
import { remoteIp } from "./origin.js";

export const SESSION_COOKIE = "adminbot_session";

export const SESSION_COOKIE_MAX_AGE_SECONDS = 604800;

// `Secure` whenever the request arrived over TLS -- see requestIsSecure. It used to be omitted
// unconditionally, on the grounds that the service is reached over loopback plain HTTP; that is
// true of the cron wrappers, and false of every browser that reaches it through the public proxy,
// which is where a session cookie is actually issued. HttpOnly and SameSite=Lax are unconditional.
export function sessionCookieAttributes(secure: boolean): string {
  return `HttpOnly; SameSite=Lax; Path=/${secure ? "; Secure" : ""}`;
}

export function setSessionCookie(res: ServerResponse, token: string, secure: boolean): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; ${sessionCookieAttributes(secure)}; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
  );
}

// Same attributes as the cookie being cleared: a browser only replaces a cookie when the pair
// matches, so a logout that forgot Secure would leave the real cookie in place.
export function clearSessionCookie(res: ServerResponse, secure: boolean): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${sessionCookieAttributes(secure)}; Max-Age=0`);
}

// Behind a reverse proxy (Render, Fly, etc.), req.socket.remoteAddress is the proxy's own
// address, not the real caller's — the actual IP only shows up in X-Forwarded-For, which the
// proxy sets and the app must not trust unless it knows every request actually passes through
// that proxy (otherwise a direct caller could hand-write the header to spoof it).
/**
 * Whether this request reached us over TLS, and so whether its session cookie may be `Secure`.
 *
 * Decided per request rather than once at startup because both are true of the same deployment:
 * the service is reached over loopback plain HTTP by the cron wrappers and the verify commands,
 * and over HTTPS by real browsers through the public proxy (ADMINBOT_PUBLIC_URL). A cookie marked
 * `Secure` on the loopback path would never come back, and one left unmarked on the public path
 * travels in the clear the first time anything addresses that host over http://.
 *
 * `x-forwarded-proto` only when the proxy is trusted, exactly as remoteIp treats x-forwarded-for:
 * an untrusted client could otherwise set it, though here the lie is self-harming (it only adds a
 * restriction to the attacker's own cookie).
 */
export function requestIsSecure(req: IncomingMessage, trustProxyHeaders: boolean): boolean {
  if (trustProxyHeaders) {
    const header = req.headers["x-forwarded-proto"];
    const first = (Array.isArray(header) ? header[0] : header)?.split(",")[0]?.trim();
    if (first) {
      return first.toLowerCase() === "https";
    }
  }
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

export function sendAuthResult<T>(
  res: ServerResponse,
  result: AdminBotAuthResponse<T>,
  secure: boolean,
): void {
  if (result.ok) {
    if (result.sessionToken) {
      setSessionCookie(res, result.sessionToken, secure);
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

export async function resolvePrincipal(
  req: IncomingMessage,
  ctx: AdminBotRouteContext,
): Promise<AdminBotPrincipal | undefined> {
  const bearer = bearerToken(req);
  if (bearer) {
    // Service-principal check first with a constant-time compare. If the env token is unset the
    // service principal is unavailable and this path fails closed.
    if (ctx.serviceToken && constantTimeEqual(bearer, ctx.serviceToken)) {
      return { kind: "service" };
    }
    const member = await ctx.auth.resolveSession(bearer);
    if (member) {
      // Every authenticated request lands here, which is what makes it the place to notice an
      // account being used from somewhere new. noteAccountUse is a no-op unless the address
      // actually changed, so this costs a map lookup on the hot path.
      ctx.auth.noteAccountUse(member, remoteIp(req, ctx.trustProxyHeaders));
      return member;
    }
  }
  const cookie = cookieToken(req);
  if (cookie) {
    const member = await ctx.auth.resolveSession(cookie);
    if (member) {
      ctx.auth.noteAccountUse(member, remoteIp(req, ctx.trustProxyHeaders));
      return member;
    }
  }
  return undefined;
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/u.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

export function cookieToken(req: IncomingMessage): string | undefined {
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

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return timingSafeEqual(leftBuf, rightBuf);
}

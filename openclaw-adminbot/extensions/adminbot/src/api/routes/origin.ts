// Where a request comes from: the CORS allow-list, and the client address behind a proxy.
//
// Cut from server.ts. Origin checks run before anything else in routeRequest, so they own no route.

import type { IncomingMessage, ServerResponse } from "node:http";

export const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:18789",
  "http://127.0.0.1:18789",
];

/**
 * Whether `target` is a different origin from the one this request arrived on.
 *
 * Used to keep the `/` redirect from pointing at itself. The comparison is on host and protocol
 * only: behind the tunnel the request arrives as plain HTTP on 127.0.0.1 with the public host in
 * `x-forwarded-host`/`x-forwarded-proto`, so the forwarded pair is what a browser actually typed
 * and the socket is not. An unparseable target counts as foreign — the configured value is then
 * a URL this code cannot reason about, and refusing to redirect would strand the operator on the
 * console with no signal about why.
 */
export function isForeignOrigin(target: string, req: IncomingMessage): boolean {
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return true;
  }
  const forwardedHost = firstHeaderValue(req.headers["x-forwarded-host"]);
  const host = forwardedHost ?? req.headers.host;
  if (!host) {
    return true;
  }
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]);
  const proto = forwardedProto ?? "http";
  return targetUrl.host !== host || targetUrl.protocol !== `${proto}:`;
}

/** A header can arrive repeated or comma-joined; the first value is the original client's. */
export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const first = raw?.split(",")[0]?.trim();
  return first || undefined;
}

export function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: Set<string>,
  // Origins already reported, so the warning fires once each rather than once per request. Held by
  // the service rather than the module so two services in one process cannot silence each other.
  refusedOrigins: Set<string>,
): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string") {
    return true;
  }
  if (!allowedOrigins.has(origin)) {
    // A refused origin is otherwise completely silent: the service answers normally, the browser
    // discards the response for want of a header, and the page reports only that it could not
    // reach anything. Naming the rejected origin next to the allowed ones turns "it does not work"
    // into a diff — a scheme, a subdomain or a port is usually the whole story. Once per origin,
    // so a misconfigured client cannot flood the log.
    if (!refusedOrigins.has(origin)) {
      refusedOrigins.add(origin);
      console.warn(
        `[adminbot] refused cross-origin request from ${origin}; ADMINBOT_ALLOWED_ORIGINS is ${
          [...allowedOrigins].join(", ") || "(empty)"
        }`,
      );
    }
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Idempotency-Key, Prefer, If-None-Match",
  );
  // A cross-origin script cannot read ETag unless it is exposed, and without it the console has
  // nothing to revalidate with.
  res.setHeader("Access-Control-Expose-Headers", "ETag");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  return true;
}

export function parseOrigins(value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function remoteIp(req: IncomingMessage, trustProxyHeaders: boolean): string | undefined {
  if (trustProxyHeaders) {
    const header = req.headers["x-forwarded-for"];
    const first = (Array.isArray(header) ? header[0] : header)?.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return req.socket.remoteAddress ?? undefined;
}

// Request and response plumbing for the AdminBot HTTP surface.
//
// Cut from server.ts, which owns the route table: these are the half-dozen helpers every route
// reaches for, and keeping them here is what lets a route handler live in its own file without
// importing the router back (see server.logistics.ts, and check:import-cycles for why that
// matters). Nothing here knows what any route means.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import type { AdminBotServiceResponse } from "../kernel/service.js";
import { avatarJsonReplacer, avatarJsonReviver, type Avatar } from "./avatars.js";

// Typed API requests are small. Routes carrying files pass a larger explicit ceiling; making the
// ordinary default finite prevents a newly added or anonymous JSON route from silently buffering
// an attacker-controlled amount of memory.
export const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 1024;

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The whole request body as JSON.
 *
 * `maxBytes` is for the routes that carry member-supplied files: without it the only ceiling on a
 * POST is the process's memory, and the buffer is built before any validator gets to see it, so a
 * cap enforced in the service would arrive far too late to matter.
 */
export async function readJson(
  req: IncomingMessage,
  maxBytes = DEFAULT_JSON_BODY_LIMIT_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (maxBytes !== undefined && total > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"), avatarJsonReviver);
}

/**
 * The same read, but an empty body is an empty object rather than a parse error.
 *
 * For routes where the body is entirely optional -- a button that posts nothing when it means
 * "all of it" -- so the common press is not the one that has to send `{}` to work.
 */
export async function readJsonOrEmpty(
  req: IncomingMessage,
  maxBytes = DEFAULT_JSON_BODY_LIMIT_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (maxBytes !== undefined && total > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw, avatarJsonReviver) : {};
}

/** Thrown by `readJson` past its cap, so the route answers 413 rather than dying on a parse. */
export class PayloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body is larger than ${maxBytes} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

export function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The status a JSON response goes out with: 502 and 504 leave as 500.
 *
 * The service answers 502 when a connector refuses -- Google rejecting a protected cell, gog's
 * token expired -- and the message it carries is the whole diagnosis. But the Control UI reaches
 * the service through a Cloudflare tunnel, and Cloudflare replaces an origin 502 or 504 with its
 * own error page. That page has none of this service's CORS headers, so the browser's fetch
 * rejects outright and the console reports "Couldn't reach the AdminBot service" for a service
 * that answered in milliseconds. 500 passes through the tunnel untouched. The service results,
 * audit rows and callers inside this process keep 502; only the wire changes, and nothing
 * client-side distinguishes 502 from any other 5xx.
 */
export function wireStatus(status: number): number {
  return status === 502 || status === 504 ? 500 : status;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = wireStatus(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Every JSON response here reflects live, mutable state (roster, sessions, map places...);
  // without this a browser can silently serve a stale GET from its disk cache instead of
  // re-asking the server, which is indistinguishable from the data actually being wrong.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Accept-Encoding");
  // Inline photos go out as /avatars/<hash> (see ./avatars.ts) rather than megabytes of base64.
  const json = JSON.stringify(body, avatarJsonReplacer);
  // Roster and paper payloads run to megabytes of repetitive JSON, which gzip shrinks ~5-10x.
  // Small bodies are not worth the CPU or the header bytes.
  if (json.length >= GZIP_MIN_BYTES && acceptsGzip(res.req)) {
    res.setHeader("Content-Encoding", "gzip");
    res.end(gzipSync(json));
    return;
  }
  res.end(json);
}

const GZIP_MIN_BYTES = 1024;

function acceptsGzip(req: IncomingMessage | undefined): boolean {
  const header = req?.headers?.["accept-encoding"];
  return typeof header === "string" && /\bgzip\b(?!;q=0(?:\.0*)?\b)/i.test(header);
}

/**
 * A profile photo by content address. The address changes with the photo, so it is cached for
 * good; nosniff and the raster-only allowlist in ./avatars.ts keep it from being anything but an
 * image, and the cross-origin policy lets the console on its own origin show it.
 */
export function sendAvatar(res: ServerResponse, avatar: Avatar | undefined): void {
  if (!avatar) {
    res.statusCode = 404;
    res.setHeader("Cache-Control", "no-store");
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", avatar.contentType);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.end(avatar.bytes);
}

type RenderedPage = { html: string; gzip: Buffer; etag: string };
const renderedPages = new WeakMap<() => string, RenderedPage>();

/**
 * One of the service's own pages (console, venue picker, member map).
 *
 * Each is fixed for the life of the build, so it is rendered and gzipped on first request and kept;
 * a deploy restarts the process, which is the only time a page can change. `no-cache` plus the
 * ETag makes the browser ask every time and get an empty 304 when nothing moved.
 */
export function sendHtml(res: ServerResponse, render: () => string): void {
  let page = renderedPages.get(render);
  if (!page) {
    const html = render();
    page = {
      html,
      gzip: gzipSync(html),
      etag: `"${createHash("sha256").update(html).digest("hex").slice(0, 32)}"`,
    };
    renderedPages.set(render, page);
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Vary", "Accept-Encoding");
  res.setHeader("ETag", page.etag);
  if (res.req?.headers["if-none-match"] === page.etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  if (acceptsGzip(res.req)) {
    res.setHeader("Content-Encoding", "gzip");
    res.end(page.gzip);
    return;
  }
  res.end(page.html);
}

/**
 * Send a browser somewhere else.
 *
 * 302 rather than 301, and `no-store` alongside it, because the target is configuration
 * (ADMINBOT_CONTROL_UI_URL) rather than a fact about this route. A 301 is cached by browsers
 * indefinitely and survives the config being corrected, which turns one wrong value into a
 * support problem on every machine that ever loaded the page.
 */
export function sendRedirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

export function sendServiceResult(
  res: ServerResponse,
  result: AdminBotServiceResponse<unknown>,
): void {
  if (result.ok) {
    sendJson(res, result.status, result.payload);
    return;
  }
  sendJson(res, result.status, { error: result.error });
}

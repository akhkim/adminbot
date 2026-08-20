// Request and response plumbing for the AdminBot HTTP surface.
//
// Cut from server.ts, which owns the route table: these are the half-dozen helpers every route
// reaches for, and keeping them here is what lets a route handler live in its own file without
// importing the router back (see server.logistics.ts, and check:import-cycles for why that
// matters). Nothing here knows what any route means.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminBotServiceResponse } from "../kernel/service.js";

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The whole request body as JSON.
 *
 * `maxBytes` is for the routes that carry member-supplied files: without it the only ceiling on a
 * POST is the process's memory, and the buffer is built before any validator gets to see it, so a
 * cap enforced in the service would arrive far too late to matter. Routes that carry only typed
 * fields pass nothing and keep the old behaviour.
 */
export async function readJson(req: IncomingMessage, maxBytes?: number): Promise<unknown> {
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
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * The same read, but an empty body is an empty object rather than a parse error.
 *
 * For routes where the body is entirely optional -- a button that posts nothing when it means
 * "all of it" -- so the common press is not the one that has to send `{}` to work.
 */
export async function readJsonOrEmpty(req: IncomingMessage, maxBytes?: number): Promise<unknown> {
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
  return raw ? JSON.parse(raw) : {};
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

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Every JSON response here reflects live, mutable state (roster, sessions, map places...);
  // without this a browser can silently serve a stale GET from its disk cache instead of
  // re-asking the server, which is indistinguishable from the data actually being wrong.
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

export function sendServiceResult<T>(
  res: ServerResponse,
  result: AdminBotServiceResponse<T>,
): void {
  if (result.ok) {
    sendJson(res, result.status, result.payload);
    return;
  }
  sendJson(res, result.status, { error: result.error });
}

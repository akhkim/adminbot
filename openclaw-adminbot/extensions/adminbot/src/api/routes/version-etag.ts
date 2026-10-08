// ETags for the heavy list routes, derived from a version instead of the response bytes.
//
// sendJson's default tag hashes the JSON it is about to send, so a 304 still costs the whole
// read, projection and serialization -- for a 1000-member lab, most of the request. A route with
// a cheap "may have changed" token (the parsed-roster generation, a per-table write counter) can
// instead hash that token together with everything else the body depends on, and answer 304
// before building anything.
//
// The rule that keeps this safe: every input to the body must be in `parts`. The version covers
// stored rows; the caller adds whatever the projection reads from the principal (role, and the
// member's id or name where the body is filtered or redacted by them), the query parameters, and
// any setting the body is filtered by. A route whose body has an input with no cheap version stays
// on the byte hash; the member views version theirs in members-etag.ts.
import { createHash, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { etagMatches } from "../server.http.js";
import type { AdminBotPrincipal } from "./context.js";

// Versions are counters in this process's memory and restart from zero, so a tag issued before a
// restart could otherwise match a different body after it.
const BOOT_ID = randomUUID();

export type EtagPart = string | number | boolean | null | undefined;

export function versionEtag(route: string, parts: readonly EtagPart[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([BOOT_ID, route, ...parts.map((part) => part ?? null)]))
    .digest("base64url")
    .slice(0, 27);
  return `W/"v.${digest}"`;
}

/** The role a projection branches on; part of every version tag, so roles never share one. */
export function principalRole(principal: AdminBotPrincipal): string {
  return principal.kind === "member"
    ? `member:${principal.member.privilege_level}`
    : principal.kind;
}

/**
 * Answer 304 when the caller already holds the body this tag names. Returns true when it did, and
 * the route must then build nothing. Same headers as sendJson's 304.
 */
export function sendNotModified(res: ServerResponse, etag: string): boolean {
  const req = res.req;
  if (req?.method !== "GET" || !etagMatches(req.headers["if-none-match"], etag)) {
    return false;
  }
  res.statusCode = 304;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Accept-Encoding");
  res.setHeader("ETag", etag);
  res.end();
  return true;
}

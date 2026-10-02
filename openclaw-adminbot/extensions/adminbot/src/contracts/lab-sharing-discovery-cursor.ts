import { createHash } from "node:crypto";
import type { LabSharingDiscoveryQuery } from "./lab-sharing-discovery.js";

export type DiscoveryPosition = { title: string; hours: number; paperId: string };
const fingerprint = (query: LabSharingDiscoveryQuery) => createHash("sha256")
  .update(JSON.stringify([query.query, query.maxHours, query.sort, query.limit])).digest("hex");

/** A cursor is navigation state, never proof of authorization; every lookup must recheck visibility. */
export function encodeDiscoveryCursor(query: LabSharingDiscoveryQuery, position: DiscoveryPosition): string {
  return Buffer.from(JSON.stringify({v: 1, filters: fingerprint(query), ...position})).toString("base64url");
}

export function decodeDiscoveryCursor(query: LabSharingDiscoveryQuery, cursor: string): DiscoveryPosition | string {
  const invalid = "Invalid page token. Restart the search.";
  if (!cursor || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) return invalid;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) return invalid;
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || value.v !== 1 ||
      typeof value.title !== "string" || value.title.length > 2000 ||
      typeof value.paperId !== "string" || !value.paperId || value.paperId.length > 512 ||
      typeof value.hours !== "number" || !Number.isFinite(value.hours) || value.hours <= 0 || value.hours > 168) return invalid;
    if (value.filters !== fingerprint(query)) return "Search filters changed. Restart the search.";
    return {title: value.title, hours: value.hours, paperId: value.paperId};
  } catch { return invalid; }
}

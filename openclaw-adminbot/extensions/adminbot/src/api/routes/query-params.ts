// Query-string readers more than one route zone shares: list paging, edit-history limits, and
// day windows.
//
// Cut from server.ts.

import type { AdminBotListPage } from "../../kernel/service.js";

export function readListPage(url: URL): AdminBotListPage | "invalid" | undefined {
  const params = url.searchParams;
  if (!["limit", "offset", "q"].some((key) => params.has(key))) {
    return undefined;
  }
  const rawLimit = params.get("limit") ?? "50";
  const rawOffset = params.get("offset") ?? "0";
  const q = (params.get("q") ?? "").trim();
  if (!/^[1-9]\d*$/u.test(rawLimit) || !/^\d+$/u.test(rawOffset) || q.length > 120) {
    return "invalid";
  }
  const limit = Number(rawLimit);
  const offset = Number(rawOffset);
  if (!Number.isSafeInteger(limit) || limit > 100 || !Number.isSafeInteger(offset)) {
    return "invalid";
  }
  return { limit, offset, ...(q ? { q } : {}) };
}

/** A positive `?limit=`, or undefined and the reader picks its default. */
export function limitParam(url: URL): number | undefined {
  const raw = Number(url.searchParams.get("limit") ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * A `?days=` value as a number, or undefined when it is absent or not one.
 *
 * Undefined rather than a default: the window's default belongs to the service, which is what the
 * two readers of this log and any later one share.
 */
export function asDays(raw: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }
  const days = Number(raw);
  return Number.isFinite(days) ? days : undefined;
}

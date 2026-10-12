// The few routes a visitor with no account may reach, and the per-IP limiter that caps them.
//
// Cut from server.ts. routeRequest consults this before resolving a principal, and
// handleAuthenticatedRoute re-checks it, so a new route is never anonymous by accident.

import type { AnonymousRateLimiter } from "./context.js";

// Routes the anonymous principal may reach, keyed as "METHOD pathname" -- re-checked against this
// list before any handler runs, so a new route cannot become anonymously reachable by being added
// to handleAuthenticatedRoute.
//
// Reimbursement is deliberately usable without an account: the forms carry only the claimant's own
// details, which they are typing in anyway.
//
// GET /member-map is deliberately public too, same spirit as GET /deadlines: the handler itself
// still checks isPrivileged and gives an anonymous (or non-admin) caller a names-stripped, counts-
// only summary -- publishing where people are by name was the thing worth gating, headcounts
// per city were not.
export const ANONYMOUS_ROUTES = new Set([
  "POST /reimbursements/converse",
  "POST /reimbursements/generate",
  "GET /member-map",
  // The conference-paper surface, which the Control UI opens to visitors along with the rest of
  // General Tools. Both are reads over a published conference programme, ranked against text the
  // caller typed: no lab data, nothing filtered by who is asking, and neither writes. The search
  // does spend an embedding call, which is what the per-IP limiter below is for -- the same reason
  // the reimbursement pair is capped. Indexing a venue stays privileged: it is the expensive half
  // and the only one that writes.
  "GET /venue-papers/sources",
  "GET /venue-papers/categories",
  "POST /venue-papers/search",
  // The Opportunities board, which the Control UI shows to visitors alongside Deadlines. Only
  // approved entries reach an anonymous caller; the handler resolves that from the principal, so
  // being on this list buys the read and nothing else. Every write below needs a member session.
  "GET /opportunities",
]);

export function isAnonymousRoute(method: string | undefined, pathname: string): boolean {
  return ANONYMOUS_ROUTES.has(`${method} ${pathname}`);
}

// Anonymous callers are unauthenticated by design, so the only abuse control left is volume. These
// caps are per-IP and generous enough that a real claimant filling one packet never notices; they
// exist to stop the open endpoint being used as free inference against the local model.
export const ANONYMOUS_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export const ANONYMOUS_RATE_LIMIT_MAX_REQUESTS = 60;

export const ANONYMOUS_RATE_LIMIT_MAX_TRACKED_IPS = 10_000;

export function createAnonymousRateLimiter(): AnonymousRateLimiter {
  const hits = new Map<string, number[]>();
  return {
    check(ip) {
      const key = ip ?? "unknown";
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter(
        (at) => now - at < ANONYMOUS_RATE_LIMIT_WINDOW_MS,
      );
      if (recent.length >= ANONYMOUS_RATE_LIMIT_MAX_REQUESTS) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      // Unbounded growth would be its own denial of service, so the map is swept once it is large
      // rather than kept forever for IPs that have gone quiet.
      if (hits.size > ANONYMOUS_RATE_LIMIT_MAX_TRACKED_IPS) {
        for (const [trackedIp, timestamps] of hits) {
          if (timestamps.every((at) => now - at >= ANONYMOUS_RATE_LIMIT_WINDOW_MS)) {
            hits.delete(trackedIp);
          }
        }
      }
      return true;
    },
  };
}

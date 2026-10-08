// The administrator's work queues, read for the page that shows them rather than on every load.
//
// An admin load used to fire five reads on whatever page it ran for -- the pending proposals, the
// email review queue (which the service builds alongside a PaperFlow stage sweep), the paper
// nudges, the conference travel rosters, and the lab settings -- so opening Meetings or a member's
// own Profile paid for all five. Each queue now belongs to the pages that draw it:
//
//   adminbot (Actions)   proposals, email review
//   adminbotPapers       proposals and nudges (overview metrics, nudge board), travel rosters
//   chat                 proposals and nudges (the AdminBot side panel's top three and counts)
//   dashboard            two numbers from /admin/queue-counts for the attention cards
//
// The lab settings are read once per session on any page: the landing redirect for the head
// professor (applyViewerHome) and the paper dialogs need them wherever the admin starts. The
// Settings tab is the one place a reload re-reads them.
//
// State is per host and per session token. A reload (a load after the page has been drawn, which
// is what every write triggers) re-reads the active page's queues and marks the others stale, so
// the next page that shows one reads it again instead of drawing what it had before the write.
// Nothing is cleared first: each queue's previous rows stay on screen until its read lands, and a
// read that fails keeps them.
import type { ConferenceRoster } from "../api/paper-admin.ts";
import {
  type AdminBotEmailReviewItem,
  type AdminBotEmailReviewPaperflowCandidate,
  type AdminBotResolvedEmailReviewItem,
  fetchMemberResource,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";
import type {
  AdminBotActionProposal,
  AdminBotDashboardData,
  AdminBotHost,
  AdminBotPaperNudge,
  AdminBotSettings,
} from "./admin.ts";

export type AdminQueue =
  | "proposals"
  | "emailReview"
  | "nudges"
  | "conferenceRosters"
  | "settings"
  | "counts";

/** What the dashboard's attention cards show when the full queues have not been read. */
export type AdminQueueCounts = { pendingProposals: number; emailReviews: number };

export function adminQueuesForTab(tab: unknown): AdminQueue[] {
  switch (tab) {
    case "adminbot":
      return ["proposals", "emailReview"];
    case "adminbotPapers":
      return ["proposals", "nudges", "conferenceRosters"];
    case "chat":
      return ["proposals", "nudges"];
    case "dashboard":
      return ["counts"];
    case "adminbotSettings":
      return ["settings"];
    default:
      return [];
  }
}

type QueueState = {
  token: string;
  fresh: Set<AdminQueue>;
  inFlight: Map<AdminQueue, Promise<boolean | null>>;
};

const queueStates = new WeakMap<object, QueueState>();

function stateFor(host: object, token: string): QueueState {
  const existing = queueStates.get(host);
  if (existing?.token === token) {
    return existing;
  }
  const created: QueueState = { token, fresh: new Set(), inFlight: new Map() };
  queueStates.set(host, created);
  return created;
}

/** Sign-out and View-as: the next admin load starts from nothing. */
export function forgetAdminQueues(host: object): void {
  queueStates.delete(host);
}

type QueueSession = { sessionToken: string; baseUrl: string };

/**
 * Read the queues the active page shows, and the session's settings if they are not in yet.
 *
 * `refresh` re-reads the page's queues even when they are already loaded (a reload after a write,
 * or a Refresh button); otherwise only what this session has not read is fetched, so opening a page
 * twice costs nothing the second time. Resolves to whether any read was served from the offline
 * cache.
 */
export async function loadAdminQueues(
  host: AdminBotHost,
  session: QueueSession,
  options: { tab: unknown; refresh: boolean },
): Promise<boolean> {
  const state = stateFor(host, session.sessionToken);
  const pageQueues = adminQueuesForTab(options.tab);
  if (options.refresh) {
    // Whatever another page showed may have been changed by the write that caused this reload.
    // The session's settings are the exception: only the Settings tab writes them.
    for (const queue of state.fresh) {
      if (queue !== "settings" && !pageQueues.includes(queue)) {
        state.fresh.delete(queue);
      }
    }
  }
  const wanted = new Set<AdminQueue>([...pageQueues, "settings"]);
  const reads = [...wanted].map((queue) => {
    const forced = options.refresh && pageQueues.includes(queue);
    if (!forced && state.fresh.has(queue)) {
      return Promise.resolve(false);
    }
    const pending = state.inFlight.get(queue);
    if (pending && !forced) {
      return pending;
    }
    const promise = readQueue(host, session, queue).finally(() => {
      if (state.inFlight.get(queue) === promise) {
        state.inFlight.delete(queue);
      }
    });
    state.inFlight.set(queue, promise);
    return promise.then((usedCache) => {
      // A failed read is not marked loaded, so the next page that shows the queue tries again.
      if (usedCache !== null && loadStoredMemberSession()?.sessionToken === session.sessionToken) {
        state.fresh.add(queue);
      }
      return usedCache;
    });
  });
  const cached = await Promise.all(reads);
  return cached.some((usedCache) => usedCache === true);
}

/**
 * Navigation into a page that shows a queue this session has not read (or that a write made
 * stale). The first admin load runs this itself; a later visit gets it from refreshActiveTab.
 */
export function ensureAdminQueuesForTab(host: AdminBotHost, tab: unknown): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored || host.memberPrivilegeLevel !== "admin" || adminQueuesForTab(tab).length === 0) {
    return Promise.resolve();
  }
  return loadAdminQueues(
    host,
    { sessionToken: stored.sessionToken, baseUrl: resolveAdminBotBaseUrl(host.settings) },
    { tab, refresh: false },
  ).then(() => host.requestUpdate?.());
}

type QueueRead = { value: unknown; cached: boolean } | { missing: true } | null;

async function readOne(session: QueueSession, path: string): Promise<QueueRead> {
  const result = await fetchMemberResource(path, session.sessionToken, session.baseUrl);
  if (result.ok) {
    return { value: result.value, cached: Boolean(result.cached) };
  }
  return result.kind === "not-found" ? { missing: true } : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list<T>(value: unknown, key: string): T[] {
  const raw = record(value)[key];
  return Array.isArray(raw) ? (raw as T[]) : [];
}

function count(value: unknown, key: string): number {
  const raw = record(value)[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

// One queue's read and its merge into the dashboard data. Resolves to whether it came from the
// offline cache, or null when it failed; a refused or failed read leaves the previous rows where
// they were.
async function readQueue(
  host: AdminBotHost,
  session: QueueSession,
  queue: AdminQueue,
): Promise<boolean | null> {
  const path = QUEUE_PATHS[queue];
  const read = await readOne(session, path);
  if (loadStoredMemberSession()?.sessionToken !== session.sessionToken) {
    return null;
  }
  if (!read || "missing" in read) {
    if (queue === "counts" && read) {
      // A service older than /admin/queue-counts: count from the queues themselves, as before.
      const [proposals, emails] = await Promise.all([
        readQueue(host, session, "proposals"),
        readQueue(host, session, "emailReview"),
      ]);
      return proposals === null || emails === null ? null : proposals || emails;
    }
    return null;
  }
  host.adminBotData = { ...host.adminBotData, ...mergeQueue(host.adminBotData, queue, read.value) };
  host.requestUpdate?.();
  return read.cached;
}

const QUEUE_PATHS: Record<AdminQueue, string> = {
  // The window the Actions panel, the chat panel and the dashboard count have always used.
  proposals: "/proposals/pending?limit=50",
  emailReview: "/automation/email/review",
  nudges: "/papers/nudges",
  conferenceRosters: "/papers/conference-rosters",
  settings: "/settings",
  counts: "/admin/queue-counts",
};

function mergeQueue(
  data: AdminBotDashboardData,
  queue: AdminQueue,
  value: unknown,
): Partial<AdminBotDashboardData> {
  switch (queue) {
    case "proposals": {
      const proposals = list<AdminBotActionProposal>(value, "proposals");
      // Keep the dashboard's number in step with the list it summarizes, so a page that has the
      // list never shows a count from before the last approval.
      return { proposals, queueCounts: withCount(data, { pendingProposals: proposals.length }) };
    }
    case "emailReview": {
      const emailReviews = list<AdminBotEmailReviewItem>(value, "reviews");
      return {
        emailReviews,
        emailReviewCandidates: list<AdminBotEmailReviewPaperflowCandidate>(
          value,
          "paperflow_candidates",
        ),
        emailReviewHistory: list<AdminBotResolvedEmailReviewItem>(value, "recent_resolutions"),
        queueCounts: withCount(data, { emailReviews: emailReviews.length }),
      };
    }
    case "nudges":
      return { nudges: list<AdminBotPaperNudge>(value, "nudges") };
    case "conferenceRosters":
      return { conferenceRosters: list<ConferenceRoster>(value, "conferences") };
    case "settings": {
      const settings = record(value);
      return {
        settings: Object.keys(settings).length > 0 ? (settings as AdminBotSettings) : null,
      };
    }
    case "counts":
      return {
        queueCounts: {
          pendingProposals: count(value, "pending_proposals"),
          emailReviews: count(value, "email_reviews"),
        },
      };
  }
}

function withCount(
  data: AdminBotDashboardData,
  patch: Partial<AdminQueueCounts>,
): AdminQueueCounts | undefined {
  // Only an existing count is updated: before the dashboard has read its numbers the cards count
  // the lists directly, and inventing the other half here would show a zero nobody read.
  return data.queueCounts ? { ...data.queueCounts, ...patch } : undefined;
}

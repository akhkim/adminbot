// Venue paper search, lab relevance, and workshop nudges.
//
// Controller for this zone: loads through api/conference-papers.ts and writes the result onto the host state.
// Cut from controllers/admin.ts, which keeps the host shape and the shared lab read.

import {
  cancelWorkshopNudges,
  fetchVenueSources,
  fetchWorkshopConferences,
  previewWorkshopNudges,
  rebuildVenueIndexes,
  refreshWorkshopNudges,
  searchLabPaperRelevance,
  searchVenuePapers,
  sendWorkshopNudges,
} from "../api/conference-papers.ts";
import {
  type AdminBotHost,
  type AdminBotLabPaperReport,
  type AdminBotVenueSearchResult,
  type AdminBotVenueSourceView,
  cvErrorText,
  loadAdminBotVenueCategories,
  optionalSession,
  requirePrivilegedSession,
  type WorkshopNudgeRunView,
} from "./admin.ts";

/**
 * A member's stored topics as the one string the interests box shows.
 *
 * Mirrors `interestsFromTopics` in the service's venue-relevance.ts; ui/ cannot import from
 * extensions/. Kept in step because what the box shows has to be exactly what gets embedded.
 */
function interestsFromTopics(topics: readonly string[] | undefined): string {
  return (topics ?? [])
    .map((topic) => topic.trim())
    .filter(Boolean)
    .join(", ");
}

export async function runAdminBotVenueIndexJob(host: AdminBotHost): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    return;
  }
  host.adminBotVenueIndexJob = { status: "running" };
  try {
    const result = await rebuildVenueIndexes(session.sessionToken, session.baseUrl);
    if (!result.ok) {
      host.adminBotVenueIndexJob = {
        status: "error",
        detail: result.message?.trim() || cvErrorText(result.kind, "rebuild the paper indexes"),
        finishedAtMs: Date.now(),
      };
      return;
    }
    const payload = result.value as {
      built?: Array<{ label?: string; paper_count?: number }>;
      failed?: Array<{ venue_id: string; reason: string }>;
    };
    const built = payload.built ?? [];
    const failed = payload.failed ?? [];
    const papers = built.reduce((total, entry) => total + (entry.paper_count ?? 0), 0);
    host.adminBotVenueIndexJob = {
      status: failed.length ? "error" : "ok",
      detail: failed.length
        ? `Indexed ${built.length} of ${built.length + failed.length}: ${failed
            .map((entry) => `${entry.venue_id} (${entry.reason})`)
            .join("; ")}`
        : `Indexed ${papers.toLocaleString()} papers across ${built.length} conference${
            built.length === 1 ? "" : "s"
          }.`,
      finishedAtMs: Date.now(),
    };
  } catch (error) {
    host.adminBotVenueIndexJob = {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
      finishedAtMs: Date.now(),
    };
  }
}

/**
 * Loads the conference list, and prefills the interests box from the member's own topics.
 *
 * The prefill only ever happens while the box is untouched. Re-opening the tab should pick up a
 * profile edit, but re-loading the list must never overwrite a sentence the member is part way
 * through typing.
 */
export async function loadAdminBotVenueSources(host: AdminBotHost): Promise<void> {
  const session = optionalSession(host);
  host.adminBotVenuePapers = { ...host.adminBotVenuePapers, loadingSources: true, error: null };
  try {
    const result = await fetchVenueSources(session.sessionToken, session.baseUrl);
    if (!result.ok) {
      host.adminBotVenuePapers = {
        ...host.adminBotVenuePapers,
        loadingSources: false,
        error: result.message?.trim() || cvErrorText(result.kind, "load the conference list"),
      };
      return;
    }
    const sources = (result.value as { sources?: AdminBotVenueSourceView[] })?.sources ?? [];
    const state = host.adminBotVenuePapers;
    const self = host.adminBotData?.members?.find((member) => member.id === host.memberId);
    host.adminBotVenuePapers = {
      ...state,
      sources,
      loadingSources: false,
      // Default to the first conference an admin listed; the list is ordered deliberately.
      venueId: state.venueId || (sources[0]?.venue_id ?? ""),
      interests: state.interestsTouched
        ? state.interests
        : interestsFromTopics(self?.research_topics),
    };
    if (host.adminBotVenuePapers.venueId) {
      await loadAdminBotVenueCategories(host);
    }
  } catch (error) {
    host.adminBotVenuePapers = {
      ...host.adminBotVenuePapers,
      loadingSources: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Ranks the chosen conference against the interests currently in the box. */
export async function searchAdminBotVenuePapers(host: AdminBotHost): Promise<void> {
  const session = optionalSession(host);
  const { venueId, interests, categoryId } = host.adminBotVenuePapers;
  if (!venueId || !interests.trim()) {
    return;
  }
  host.adminBotVenuePapers = {
    ...host.adminBotVenuePapers,
    searching: true,
    error: null,
    expanded: [],
  };
  try {
    const result = await searchVenuePapers(
      { venueId, interests, categoryId },
      session.sessionToken,
      session.baseUrl,
    );
    // A result belongs to the exact conference and category that produced it. If the member
    // changed either control while the request was running, leave the newer selection untouched.
    if (
      host.adminBotVenuePapers.venueId !== venueId ||
      host.adminBotVenuePapers.categoryId !== categoryId
    ) {
      return;
    }
    if (!result.ok) {
      host.adminBotVenuePapers = {
        ...host.adminBotVenuePapers,
        searching: false,
        result: null,
        error: result.message?.trim() || cvErrorText(result.kind, "search the conference"),
      };
      return;
    }
    host.adminBotVenuePapers = {
      ...host.adminBotVenuePapers,
      searching: false,
      result: result.value as AdminBotVenueSearchResult,
    };
  } catch (error) {
    if (
      host.adminBotVenuePapers.venueId !== venueId ||
      host.adminBotVenuePapers.categoryId !== categoryId
    ) {
      return;
    }
    host.adminBotVenuePapers = {
      ...host.adminBotVenuePapers,
      searching: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Rank the lab's own papers against whatever is in the box.
 *
 * One request per press, like the conference search. Nothing is cached: the corpus changes
 * whenever anybody edits a paper, and a stale answer about our own work is worse than a slow one.
 */
export async function searchAdminBotLabPapers(host: AdminBotHost): Promise<void> {
  const session = optionalSession(host);
  const query = host.adminBotLabPapers.query.trim();
  if (!query) {
    return;
  }
  host.adminBotLabPapers = {
    ...host.adminBotLabPapers,
    searching: true,
    error: null,
    expanded: [],
  };
  try {
    const result = await searchLabPaperRelevance({ query }, session.sessionToken, session.baseUrl);
    if (!result.ok) {
      host.adminBotLabPapers = {
        ...host.adminBotLabPapers,
        searching: false,
        result: null,
        error: result.message?.trim() || cvErrorText(result.kind, "rank the lab's papers"),
      };
      return;
    }
    host.adminBotLabPapers = {
      ...host.adminBotLabPapers,
      searching: false,
      result: result.value as AdminBotLabPaperReport,
    };
  } catch (error) {
    host.adminBotLabPapers = {
      ...host.adminBotLabPapers,
      searching: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** How often the page checks back on a pass that is still running. */
const WORKSHOP_RUN_POLL_MS = 5_000;

/**
 * Start a new match.
 *
 * Separate from loading, because they cost wildly different things: reading the stored answer is
 * one cheap request, and producing a new one is thousands of model calls. Opening the page must
 * never do the second by accident.
 */
export async function loadWorkshopConferences(host: AdminBotHost): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    return;
  }
  const result = await fetchWorkshopConferences(session.sessionToken, session.baseUrl);
  // Silent on failure, and specifically on a 404 from a service too old to have the route: the
  // picker is an optional narrowing of a pass that already works without it, so a missing list
  // leaves the admin with "every open workshop" rather than with an error over a working tab.
  host.adminBotWorkshopNudges = {
    ...host.adminBotWorkshopNudges,
    conferences: result.ok ? result.value : [],
  };
}

export async function refreshWorkshopNudgePreview(
  host: AdminBotHost,
  // Set when the administrator is deliberately replacing a pass that still says it is running,
  // rather than waiting out the server's stall window.
  force = false,
): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      error: "Sign in with a lab administrator account before refreshing recommendations.",
    };
    return;
  }
  host.adminBotWorkshopNudges = { ...host.adminBotWorkshopNudges, loading: true, error: null };
  const started = await refreshWorkshopNudges(
    session.sessionToken,
    session.baseUrl,
    force,
    host.adminBotWorkshopNudges.conferenceKey,
  );
  if (!started.ok) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      loading: false,
      error: started.message?.trim() || cvErrorText(started.kind, "start a workshop match"),
    };
    return;
  }
  host.adminBotWorkshopNudges = { ...host.adminBotWorkshopNudges, loading: false };
  await loadWorkshopNudgePreview(host);
}

export async function loadWorkshopNudgePreview(host: AdminBotHost): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      error: "Sign in with a lab administrator account before refreshing recommendations.",
    };
    return;
  }
  const current = host.adminBotWorkshopNudges;
  if (current.loading || current.sending) {
    return;
  }
  host.adminBotWorkshopNudges = {
    ...current,
    loading: true,
    error: null,
    selectedRecipientIds: [],
  };
  try {
    const result = await previewWorkshopNudges(session.sessionToken, session.baseUrl);
    if (!result.ok) {
      host.adminBotWorkshopNudges = {
        ...host.adminBotWorkshopNudges,
        loading: false,
        result: null,
        error: result.message?.trim() || cvErrorText(result.kind, "load workshop nudges"),
      };
      return;
    }
    const run = result.value as WorkshopNudgeRunView;
    const value = run.preview ?? null;
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      loading: false,
      run,
      result: value,
      // A failed pass says why on the page rather than looking like an empty result.
      error: run.status === "failed" ? (run.error ?? "The last match did not finish.") : null,
      selectedRecipientIds: value
        ? value.recipients
            .filter((recipient) => recipient.delivery_ready)
            .map((recipient) => recipient.recipient_member_id)
        : [],
      view: { ...host.adminBotWorkshopNudges.view, page: 0, detailKey: null },
    };
    // While a pass is in flight the page checks back on its own, so somebody who pressed Refresh
    // and walked away comes back to the answer rather than to a spinner that stopped meaning
    // anything. Polling stops the moment the pass is terminal.
    if (
      run.status === "running" &&
      run.task_status !== "needs_retry" &&
      run.task_status !== "shed"
    ) {
      setTimeout(() => {
        if ("isConnected" in host && host.isConnected === false) {
          return;
        }
        void loadWorkshopNudgePreview(host);
      }, WORKSHOP_RUN_POLL_MS);
    }
  } catch (error) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      loading: false,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Stop the pass in flight.
 *
 * Reaching a stalled pass used to mean waiting out the server's thirty-minute window or restarting
 * the service, neither of which is available to somebody looking at a wedged tab in a browser.
 */
export async function cancelWorkshopNudgeRun(host: AdminBotHost): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      error: "Sign in with a lab administrator account before stopping a pass.",
    };
    return;
  }
  host.adminBotWorkshopNudges = { ...host.adminBotWorkshopNudges, loading: true, error: null };
  const stopped = await cancelWorkshopNudges(session.sessionToken, session.baseUrl);
  if (!stopped.ok) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      loading: false,
      error: stopped.message?.trim() || cvErrorText(stopped.kind, "stop the workshop match"),
    };
    return;
  }
  host.adminBotWorkshopNudges = { ...host.adminBotWorkshopNudges, loading: false };
  await loadWorkshopNudgePreview(host);
}

export async function sendWorkshopNudgeSelection(host: AdminBotHost): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    return;
  }
  const current = host.adminBotWorkshopNudges;
  if (current.sending || current.loading) {
    return;
  }
  if (!current.selectedRecipientIds.length) {
    host.adminBotWorkshopNudges = { ...current, error: "Select at least one recipient." };
    return;
  }
  host.adminBotWorkshopNudges = { ...current, sending: true, error: null, sendResult: null };
  try {
    const result = await sendWorkshopNudges(
      current.selectedRecipientIds,
      session.sessionToken,
      session.baseUrl,
    );
    if (!result.ok) {
      host.adminBotWorkshopNudges = {
        ...host.adminBotWorkshopNudges,
        sending: false,
        error: result.message?.trim() || cvErrorText(result.kind, "send workshop nudges"),
      };
      return;
    }
    const value = result.value as {
      created: Array<{ member_id: string }>;
      skipped: Array<{ member_id: string; reason: string }>;
    };
    const skipped = value.skipped.length
      ? ` Skipped ${value.skipped.length}: ${value.skipped.map((entry) => entry.reason).join(", ")}.`
      : "";
    host.adminBotNotice = {
      kind: value.skipped.length ? "error" : "success",
      text: `Sent ${value.created.length} workshop nudge${value.created.length === 1 ? "" : "s"}.${skipped}`,
    };
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      sending: false,
      // Only clear the ticks for recipients that actually went. A skipped one stays selected, so
      // pressing Nudge again after fixing the cause retries exactly those.
      selectedRecipientIds: value.skipped.map((entry) => entry.member_id),
      sendResult: { created: value.created.length, skipped: value.skipped },
    };
  } catch (error) {
    host.adminBotWorkshopNudges = {
      ...host.adminBotWorkshopNudges,
      sending: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

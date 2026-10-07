// Slack channel names, the channel-naming sweep, and the CV digest.
//
// Controller for this zone: loads through api/directory.ts and writes the result onto the host state.
// Cut from controllers/admin.ts, which keeps the host shape and the shared lab read.

import {
  fetchSlackChannelNames,
  publishCvDigest,
  runChannelNamingSweep,
} from "../api/directory.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import {
  ADMINBOT_SERVICE_UNREACHABLE_MESSAGE,
  type AdminBotHost,
  cvErrorText,
  requirePrivilegedSession,
} from "./admin.ts";

/** What POST /cv/publish-digest answers with. Mirrors the service; ui/ cannot import extensions/. */
export type AdminBotCvDigestPublishResult = {
  document_url: string;
  published_at: string;
  day_count: number;
  change_count: number;
};

/**
 * Rebuilds every configured conference index.
 *
 * The slow job of the pair: a few thousand papers fetched from OpenReview and embedded one batch
 * at a time, roughly a minute and a half per conference. It reports per-venue rather than pass or
 * fail because the venues are independent — one dead id should not read as "indexing is broken".
 */
/**
 * Files a rename proposal for every Slack channel whose naming reminder has run out.
 *
 * Reports what it queued rather than what it changed, because it changes nothing: the renames go
 * to Pending Actions for an admin to approve. A run that finds channels still waiting on an
 * earlier proposal says so instead of filing them twice.
 */
export async function runAdminBotChannelNamingJob(host: AdminBotHost): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    return;
  }
  host.adminBotChannelNamingJob = { status: "running" };
  try {
    const result = await runChannelNamingSweep(session.sessionToken, session.baseUrl);
    if (!result.ok) {
      host.adminBotChannelNamingJob = {
        status: "error",
        detail: result.message?.trim() || cvErrorText(result.kind, "run the channel naming sweep"),
        finishedAtMs: Date.now(),
      };
      return;
    }
    const payload = result.value as {
      scanned?: number;
      reminders_pending?: number;
      renames_proposed?: number;
      renames_awaiting_approval?: number;
    };
    host.adminBotChannelNamingJob = {
      status: "ok",
      detail: describeNamingSweep(payload),
      finishedAtMs: Date.now(),
    };
  } catch (error) {
    host.adminBotChannelNamingJob = {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
      finishedAtMs: Date.now(),
    };
  }
}

// Every outcome is worth a sentence, because all three mean different things to the person who
// just pressed the button: something is waiting on them, something is waiting on a channel owner,
// or the roster is clean.
function describeNamingSweep(payload: {
  scanned?: number;
  reminders_pending?: number;
  renames_proposed?: number;
  renames_awaiting_approval?: number;
}): string {
  const proposed = payload.renames_proposed ?? 0;
  const awaiting = payload.renames_awaiting_approval ?? 0;
  const reminded = payload.reminders_pending ?? 0;
  const parts: string[] = [];
  if (proposed) {
    parts.push(
      `Proposed ${proposed} rename${proposed === 1 ? "" : "s"} — approve them in Pending Actions.`,
    );
  }
  if (awaiting) {
    parts.push(`${awaiting} already waiting for approval.`);
  }
  if (reminded) {
    parts.push(`${reminded} still inside the 48-hour window.`);
  }
  if (!parts.length) {
    return `Nothing to rename across ${payload.scanned ?? 0} watched channel${
      (payload.scanned ?? 0) === 1 ? "" : "s"
    }.`;
  }
  return parts.join(" ");
}

/**
 * Runs the CV digest job: scan every linked CV, then rewrite the CV Updates doc from the whole
 * change ledger.
 *
 * The scan is the slow half — one fetch and, for anything that changed, one model call per member
 * — so the button reports "running" for as long as it takes rather than optimistically claiming
 * success. Nothing here is optimistic: the state only advances once the service says the document
 * was written, because the point of the job is that the doc actually changed.
 */
export async function runAdminBotCvDigestJob(host: AdminBotHost): Promise<void> {
  const session = requirePrivilegedSession(host);
  if (!session) {
    return;
  }
  host.adminBotCvDigestJob = { status: "running" };
  host.adminBotNotice = null;
  try {
    const result = await publishCvDigest(session.sessionToken, session.baseUrl);
    if (!result.ok) {
      host.adminBotCvDigestJob = {
        status: "error",
        // The service's own sentence when it sent one (a missing document id, a gog failure);
        // the generic copy only when it did not.
        detail: result.message?.trim() || cvErrorText(result.kind, "publish the CV digest"),
        finishedAtMs: Date.now(),
      };
      return;
    }
    const published = result.value as AdminBotCvDigestPublishResult;
    host.adminBotCvDigestJob = {
      status: "ok",
      detail: describeDigestRun(published),
      resultUrl: published.document_url,
      finishedAtMs: Date.now(),
    };
  } catch (error) {
    // A thrown error here is a bug or a dead network rather than a service refusal, but leaving
    // the button stuck on "Running…" would be worse than saying so.
    host.adminBotCvDigestJob = {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
      finishedAtMs: Date.now(),
    };
  }
}

// A run that published nothing is still a run: the document was rewritten with a fresh date, and
// saying "0 updates" is what stops an admin pressing the button again to check.
function describeDigestRun(published: AdminBotCvDigestPublishResult): string {
  if (published.change_count === 0) {
    return "No CV updates recorded yet — the document was refreshed with today's date.";
  }
  const updates = `${published.change_count} update${published.change_count === 1 ? "" : "s"}`;
  const days = `${published.day_count} day${published.day_count === 1 ? "" : "s"}`;
  return `Published ${updates} across ${days}.`;
}

/**
 * Load the workspace's channel names so the project form can check an alias against them.
 *
 * Only ever called when somebody ticks the box, because it is a paginated walk over the whole
 * workspace and most projects are new ones with no channel to match.
 *
 * Every failure leaves `channels` null rather than empty. The distinction is the whole point: an
 * empty list would make the form tell a member with a perfectly good alias that no channel matches
 * it, which is worse than not checking.
 */
export async function loadSlackChannelNames(host: AdminBotHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.myWorkChannelCheck = {
      ...host.myWorkChannelCheck,
      enabled: true,
      channels: null,
      loading: false,
      error: "Sign in to check this against the lab's Slack channels.",
    };
    return;
  }
  host.myWorkChannelCheck = {
    ...host.myWorkChannelCheck,
    enabled: true,
    loading: true,
    error: null,
  };
  const result = await fetchSlackChannelNames(
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (result.ok) {
    host.myWorkChannelCheck = {
      enabled: true,
      channels: result.value.channels,
      loading: false,
      error: null,
    };
    return;
  }
  host.myWorkChannelCheck = {
    enabled: true,
    channels: null,
    loading: false,
    error:
      result.kind === "unconfigured"
        ? "AdminBot cannot read Slack channels on this deployment, so the alias cannot be checked here."
        : result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : ((result as { message?: string }).message ?? "Couldn't read the lab's Slack channels."),
  };
}

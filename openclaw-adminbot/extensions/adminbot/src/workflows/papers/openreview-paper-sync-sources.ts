// Gathers the OpenReview evidence the paper sync reads, outside the (synchronous) service.
//
// Each source is optional and fails on its own: a missing snapshot (the author-results cron is
// not installed yet) or an unreachable Drive leaves the other source to speak, and the report
// says which ones were read. Nothing here writes anything.

import { readFile } from "node:fs/promises";
import {
  evidenceFromAuthorResults,
  evidenceFromNotifications,
  type OpenReviewEvidence,
} from "./openreview-paper-sync.js";

export type OpenReviewPaperSyncSourceDeps = {
  /** The author-results snapshot file; absent disables that source. */
  snapshotPath?: string;
  /** scripts/openreview-notifications/adminbot_decisions.py; absent disables the CSV source. */
  decisionsScriptPath?: string;
  readFile?: (path: string) => Promise<string>;
  downloadNotificationsCsv?: (signal?: AbortSignal) => Promise<string>;
  runDecisionsScript?: (scriptPath: string, input: unknown, signal?: AbortSignal) => Promise<string>;
};

export type OpenReviewPaperSyncRequest = {
  /** A snapshot supplied by the caller (the results cron posts the one it just wrote). */
  author_results?: unknown;
  /** A CSV supplied by the caller instead of the Drive copy. */
  notifications_csv?: string;
  signal?: AbortSignal;
};

export type OpenReviewPaperSyncSources = {
  evidence: OpenReviewEvidence[];
  read: string[];
  warnings: string[];
};

export async function gatherOpenReviewPaperEvidence(
  deps: OpenReviewPaperSyncSourceDeps,
  request: OpenReviewPaperSyncRequest = {},
): Promise<OpenReviewPaperSyncSources> {
  const out: OpenReviewPaperSyncSources = { evidence: [], read: [], warnings: [] };

  let snapshot = request.author_results;
  if (snapshot === undefined && deps.snapshotPath) {
    try {
      snapshot = JSON.parse(await (deps.readFile ?? defaultReadFile)(deps.snapshotPath));
    } catch (error) {
      out.warnings.push(
        isMissingFile(error)
          ? "author-results snapshot not found; is the openreview results cron installed?"
          : "author-results snapshot unreadable",
      );
    }
  }
  if (snapshot !== undefined) {
    out.evidence.push(...evidenceFromAuthorResults(snapshot));
    out.read.push("author_results");
  }

  if (deps.decisionsScriptPath && deps.runDecisionsScript) {
    try {
      const csv =
        request.notifications_csv ??
        (deps.downloadNotificationsCsv
          ? await deps.downloadNotificationsCsv(request.signal)
          : undefined);
      if (csv !== undefined) {
        const result = JSON.parse(
          await deps.runDecisionsScript(
            deps.decisionsScriptPath,
            { notifications_csv: csv },
            request.signal,
          ),
        ) as { ok?: boolean; error?: string };
        if (result.ok) {
          out.evidence.push(...evidenceFromNotifications(result));
          out.read.push("notifications");
        } else {
          out.warnings.push(`notification export rejected: ${result.error ?? "unknown error"}`);
        }
      }
    } catch {
      // The gog and Python failures carry account and path details; the operator reruns the
      // drafts tool to see them.
      out.warnings.push("notification export unavailable (Drive read or parser failed)");
    }
  }
  return out;
}

function defaultReadFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

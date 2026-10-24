// Gathers the OpenReview evidence the paper sync reads, outside the (synchronous) service.
//
// The source is the author-results snapshot the results cron writes from OpenReview's API. A
// missing or unreadable snapshot reads nothing and says so, and so does one the results cron has
// stopped refreshing: a stale snapshot is how a paper's status quietly falls behind OpenReview.
// Nothing here writes anything.

import { readFile } from "node:fs/promises";
import { evidenceFromAuthorResults, type OpenReviewEvidence } from "./openreview-paper-sync.js";

/** Older than this, the results cron (every six hours) has missed at least two passes. */
export const STALE_SNAPSHOT_HOURS = 13;

export type OpenReviewPaperSyncSourceDeps = {
  /** The author-results snapshot file; absent disables that source. */
  snapshotPath?: string;
  readFile?: (path: string) => Promise<string>;
  now?: () => Date;
};

export type OpenReviewPaperSyncRequest = {
  /** A snapshot supplied by the caller (the sync cron posts the one the results cron wrote). */
  author_results?: unknown;
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
    const stale = staleness(snapshot, (deps.now ?? (() => new Date()))());
    if (stale) {
      out.warnings.push(stale);
    }
  }
  return out;
}

function staleness(snapshot: unknown, now: Date): string | undefined {
  const fetchedAt = (snapshot as { fetched_at?: unknown } | null)?.fetched_at;
  const at = typeof fetchedAt === "string" ? Date.parse(fetchedAt) : Number.NaN;
  if (Number.isNaN(at)) {
    return "author-results snapshot has no fetched_at; its age is unknown";
  }
  const hours = (now.getTime() - at) / 3_600_000;
  return hours > STALE_SNAPSHOT_HOURS
    ? `author-results snapshot is ${Math.floor(hours)} hours old; is the openreview results cron failing (OpenReview login)?`
    : undefined;
}

function defaultReadFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

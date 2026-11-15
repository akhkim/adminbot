// The citation checks as the Reference Check page draws them.
//
// The stored rows carry every reference of every checked version: a few megabytes once a hundred
// papers have each been checked a couple of times. The page shows one row per paper -- its latest
// version -- with the reference count and only the references somebody has to look at, so that is
// all this projection keeps. The full rows stay on the unqualified read, for the CLI and exports.
import type {
  CitationCheckFinding,
  OpenReviewCitationCheck,
} from "../../contracts/openreview-citation-checks.js";
import { isFlagged } from "./openreview-citation-watch.js";

export type OpenReviewCitationCheckSummary = Omit<OpenReviewCitationCheck, "findings"> & {
  /** Only the references that need a look (`not_found` or `review`), without their match details. */
  findings?: Array<Pick<CitationCheckFinding, "citation" | "status" | "explanation">>;
  /** How many references the check covered, flagged or not. */
  finding_count: number;
  /** How many versions of this submission have been checked, this one included. */
  version_count: number;
};

/**
 * One summary per submission, from rows listed newest first (the store's order), so the first row
 * seen for a submission is its latest checked version.
 */
export function summarizeOpenReviewCitationChecks(
  checks: readonly OpenReviewCitationCheck[],
): OpenReviewCitationCheckSummary[] {
  const latest = new Map<string, OpenReviewCitationCheckSummary>();
  for (const check of checks) {
    const seen = latest.get(check.submission_id);
    if (seen) {
      seen.version_count++;
      continue;
    }
    const { findings, ...row } = check;
    latest.set(check.submission_id, {
      ...row,
      ...(findings
        ? {
            findings: findings
              .filter(isFlagged)
              .map(({ citation, status, explanation }) => ({ citation, status, explanation })),
          }
        : {}),
      finding_count: findings?.length ?? 0,
      version_count: 1,
    });
  }
  return [...latest.values()];
}

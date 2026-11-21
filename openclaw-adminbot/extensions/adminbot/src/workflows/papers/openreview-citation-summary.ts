// The citation checks as the Reference Check page draws them.
//
// The stored rows carry every reference of every checked version: megabytes once a few hundred
// papers have each been checked a couple of times. The page lists one row per paper -- its latest
// version -- with counts only, and fetches a paper's flagged references when somebody opens them
// (`flaggedCitationFindings`). The full rows stay on the unqualified read, for the CLI and exports.
import type {
  CitationCheckFinding,
  OpenReviewCitationCheck,
} from "../../contracts/openreview-citation-checks.js";
import { isFlagged } from "./openreview-citation-watch.js";

export type OpenReviewCitationCheckSummary = Omit<OpenReviewCitationCheck, "findings" | "pdf_path"> & {
  /** How many references the check covered, flagged or not. */
  finding_count: number;
  /** References that need a look (`not_found` or `review`). */
  flagged_count: number;
  /** Of the flagged ones, those found in no database. */
  not_found_count: number;
  /** How many versions of this submission have been checked, this one included. */
  version_count: number;
};

export type FlaggedCitationFinding = Pick<CitationCheckFinding, "citation" | "status" | "explanation">;

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
    const { findings, pdf_path: _pdfPath, ...row } = check;
    const flagged = (findings ?? []).filter(isFlagged);
    latest.set(check.submission_id, {
      ...row,
      finding_count: findings?.length ?? 0,
      flagged_count: flagged.length,
      not_found_count: flagged.filter((finding) => finding.status === "not_found").length,
      version_count: 1,
    });
  }
  return [...latest.values()];
}

/** The flagged references of a submission's latest checked version, without match details. */
export function flaggedCitationFindings(
  checks: readonly OpenReviewCitationCheck[],
): FlaggedCitationFinding[] {
  return (checks[0]?.findings ?? [])
    .filter(isFlagged)
    .map(({ citation, status, explanation }) => ({ citation, status, explanation }));
}

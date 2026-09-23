// Automatic citation checks of the lab's own OpenReview submissions.
//
// One row per submission *version*. OpenReview API2 stores each upload under a content-addressed
// path (`/pdf/<hash>.pdf`), so a new upload is a new `pdf_path` and gets exactly one new check,
// while an unchanged paper is never downloaded again.

/** Same shape as the CheckIfExist connector's finding; restated so contracts import nothing. */
export type CitationCheckFinding = {
  citation: string;
  status: "matched" | "review" | "not_found" | "unavailable";
  explanation: string;
  source?: string;
  title?: string;
  url?: string;
  oversized_chars?: number;
};

/**
 * `unreadable` is terminal for that version (no bibliography heading, encrypted, too many
 * references): checking the same bytes again gives the same answer. `failed` is transient
 * (download, timeout, every database unreachable) and is retried by later sweeps.
 */
export type OpenReviewCitationCheckStatus = "completed" | "unreadable" | "failed";

export type OpenReviewCitationCheck = {
  submission_id: string;
  pdf_path: string;
  /** Absent only when the PDF could not be downloaded. */
  pdf_sha256?: string;
  title: string;
  venue_id: string;
  status: OpenReviewCitationCheckStatus;
  checked_at: string;
  attempts: number;
  findings?: CitationCheckFinding[];
  /** A fixed, operator-facing message; never provider or manuscript text. */
  error?: string;
  /** The `email.send` proposal raised for flagged citations, if any. */
  notification_proposal_id?: string;
  /** Which extractor produced the row; absent means the first. See the watch's version constant. */
  extractor_version?: number;
};

export type OpenReviewCitationCheckStore = {
  getOpenReviewCitationCheck(
    submissionId: string,
    pdfPath: string,
  ): OpenReviewCitationCheck | undefined;
  listOpenReviewCitationChecks(submissionId?: string): OpenReviewCitationCheck[];
  saveOpenReviewCitationCheck(check: OpenReviewCitationCheck): void;
};

/** One of the account's submissions, as the sweep needs it. */
export type OpenReviewSubmission = {
  id: string;
  title: string;
  venue_id: string;
  pdf_path: string;
  /** OpenReview's `tmdate`, used to check the most recently changed papers first. */
  modified_at: number;
};

export type OpenReviewSubmissionReader = {
  /** The profile the credentials belong to, e.g. `~Jane_Doe1`. */
  profileId(): Promise<string>;
  listSubmissions(): Promise<OpenReviewSubmission[]>;
  readPdf(submissionId: string): Promise<Uint8Array>;
};

export type OpenReviewCitationSweepSummary = {
  started_at: string;
  finished_at?: string;
  checked: number;
  flagged: number;
  failed: number;
  reused: number;
};

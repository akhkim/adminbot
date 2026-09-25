// Pre-deadline integrity checks of the lab's own ICLR submissions: an AI-text score from Pangram,
// read alongside the citation check the OpenReview citation watch already stores for the same
// uploaded version.
//
// One row per submission *version*, keyed like the citation checks by OpenReview's
// content-addressed `pdf_path`, so an unchanged paper is never scored (or billed) twice.

/**
 * `unreadable` is terminal for that version (placeholder upload, too little text): the same bytes
 * give the same answer. `failed` is transient (download, Pangram error, out of credits) and is
 * retried by later sweeps, up to a bound.
 */
export type PaperAiTextCheckStatus = "completed" | "unreadable" | "failed";

/** What the integrity alert was raised for. Each is raised at most once per version. */
/**
 * "ai_text" and "citations" are the group alert to the PI and authors; "citations_reported" is the
 * operator DM about a confirmed fabricated reference (IclrIntegrityWatchDeps.citationReportTo).
 */
export type PaperIntegrityAlertReason = "ai_text" | "citations" | "citations_reported";

export type PaperAiTextCheck = {
  submission_id: string;
  pdf_path: string;
  /** Absent only when the PDF could not be downloaded. */
  pdf_sha256?: string;
  title: string;
  venue_id: string;
  status: PaperAiTextCheckStatus;
  checked_at: string;
  attempts: number;
  /** Pangram's share of the scored text classified as AI-written, 0..1. */
  fraction_ai?: number;
  fraction_ai_assisted?: number;
  fraction_human?: number;
  /** Pangram's short label ("AI", "AI-Assisted", "Human", "Mixed"). */
  prediction?: string;
  /** Words sent to Pangram. */
  words_scored?: number;
  /**
   * What was scored. "full_text" is the whole document's text under Pangram 4, which matches the
   * website. The earlier two are re-scored once: "pdf" (the file endpoint, stuck on Pangram 3.3.2)
   * and "text" or absent (the main body only, before the References heading).
   */
  scored_from?: "full_text" | "pdf" | "text";
  /** Pangram's reported model version for this score ("4.0"). */
  model_version?: string;
  /** A fixed, operator-facing message; never provider or manuscript text. */
  error?: string;
  /** Reasons a Slack alert has already been raised for, so none is repeated. */
  alerted_for?: PaperIntegrityAlertReason[];
  /** The `paper_integrity.alert` proposals raised for this version. */
  alert_proposal_ids?: string[];
  /** Why an alert that was due could not be sent (no one to send it to, Slack refused). */
  alert_error?: string;
};

export type PaperAiTextCheckStore = {
  getPaperAiTextCheck(submissionId: string, pdfPath: string): PaperAiTextCheck | undefined;
  listPaperAiTextChecks(submissionId?: string): PaperAiTextCheck[];
  savePaperAiTextCheck(check: PaperAiTextCheck): void;
};

export type AiTextScore = {
  fraction_ai: number;
  fraction_ai_assisted: number;
  fraction_human: number;
  prediction?: string;
  /** The provider's model version, as it reported it. */
  model_version?: string;
};

/** Scores a document's text. Rejects on any provider or network failure. */
export type AiTextScorer = (text: string, signal: AbortSignal) => Promise<AiTextScore>;

export type PaperIntegritySweepSummary = {
  started_at: string;
  finished_at?: string;
  /** ICLR submissions under review that the sweep looked at. */
  submissions: number;
  scored: number;
  reused: number;
  failed: number;
  alerts: number;
  /** Set when the sweep's digest DM could not be sent; see IclrIntegrityWatchDeps.reportTo. */
  report_error?: string;
  /** Score cells written to the lab's paper sheet this sweep; see IclrIntegrityWatchDeps.sheet. */
  sheet_updated?: number;
  /** Titles of submissions no sheet row could be matched to, by title or by authors. */
  sheet_unmatched?: string[];
  sheet_error?: string;
};

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
export type PaperIntegrityAlertReason = "ai_text" | "citations";

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
  /** Words Pangram scored: its own extraction of the whole PDF (the main text for "text"). */
  words_scored?: number;
  /**
   * What was sent to Pangram. "pdf" is the whole file, scored the way Pangram's website scores
   * an upload; "text" (or absent) is the older main-text-only score, which is re-scored once.
   */
  scored_from?: "pdf" | "text";
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
  /** Words the provider scored, from its own extraction of the file. */
  words_scored?: number;
};

/** Scores a whole PDF. Rejects on any provider or network failure. */
export type AiTextScorer = (pdf: Uint8Array, signal: AbortSignal) => Promise<AiTextScore>;

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
};

// Pre-deadline integrity check of the lab's ICLR submissions: an AI-text score from Pangram, and
// the hallucinated-citation result the OpenReview citation watch stores for the same version.
//
// Run hourly. Each uploaded version is scored once -- Pangram bills per 1,000 words, and an
// unchanged paper has nothing new to say -- so the hourly cadence costs nothing between uploads and
// catches the flurry of re-uploads in the last hours before the deadline within the hour.
//
// When the current version of a paper reads as more than half AI-written, or has a reference that
// no scholarly database knows, AdminBot opens a Slack group DM with the head professor and the
// paper's first two full / coauthor-major lab authors. Each reason alerts at most once per version:
// a second message about the same PDF is the lab nagging, not a warning.
//
// What leaves the host: the submission PDF goes to Pangram, whole, the way its website scores an
// upload (see connectors/pangram.ts for why not just the main text). The text is still read here
// first, only to recognize a placeholder before paying to score it. The citation strings are
// looked up by the citation watch, not here -- this reads its stored rows.

import { createHash } from "node:crypto";
import { PangramError } from "../../connectors/pangram.js";
import { NO_TEXT_LAYER, ReferenceCheckError } from "../../connectors/reference-check.js";
import {
  adminBotIsAlumniMember,
  adminBotIsCoauthorMajorType,
  adminBotIsFullMemberType,
  type AdminBotLabMember,
} from "../../contracts/actions.js";
import type {
  OpenReviewCitationCheck,
  OpenReviewSubmission,
  OpenReviewSubmissionReader,
} from "../../contracts/openreview-citation-checks.js";
import type {
  AiTextScorer,
  PaperAiTextCheck,
  PaperIntegrityAlertReason,
  PaperIntegritySweepSummary,
} from "../../contracts/paper-integrity-checks.js";
import type { AdminBotService, AdminBotServiceStore } from "../../kernel/service.js";

/**
 * An ICLR main-conference paper still under review. Accepted papers move to
 * `ICLR.cc/<year>/Conference` and rejected ones to `.../Rejected_Submission`, so a PI's history of
 * past ICLR papers -- hundreds of billable scores -- never matches.
 */
/** A completed score of the extracted main text, from before scoring moved to the whole PDF. */
function isTextScore(check: PaperAiTextCheck): boolean {
  return check.status === "completed" && check.scored_from !== "pdf";
}

export const ICLR_UNDER_REVIEW = /^ICLR\.cc\/\d{4}\/Conference\/Submission$/u;
/** Alert when Pangram classifies more than this share of the main text as AI-written. */
export const DEFAULT_AI_THRESHOLD = 0.5;
export const MAX_AI_CHECK_ATTEMPTS = 3;
// Below this the PDF is a placeholder or an abstract-only upload; a score of it means nothing.
const MIN_WORDS = 300;
const DEFAULT_SCORE_TIMEOUT_MS = 15 * 60_000;
const MAX_LISTED_CITATIONS = 8;
// The alert names at most this many lab authors, besides the head professor.
const ALERTED_AUTHORS = 2;

export type IclrIntegrityWatchDeps = {
  store: AdminBotServiceStore;
  service: AdminBotService;
  reader: OpenReviewSubmissionReader;
  score: AiTextScorer;
  /** The main text of a PDF; rejects with ReferenceCheckError when there is none to read. */
  extractText: (pdf: Uint8Array) => Promise<string>;
  threshold?: number;
  now?: () => Date;
  scoreTimeoutMs?: number;
  /**
   * When the check stops for good: the submission deadline it exists to protect. After it,
   * nothing is scored (and billed) or alerted -- a paper can no longer be fixed, so a message
   * about it is only an accusation.
   */
  until?: Date;
};

export type IclrIntegritySweepStart = {
  started: boolean;
  submissions: number;
  pending: number;
  /** Set when the check is past its `until` and will not run again. */
  ended_at?: string;
  last_sweep?: PaperIntegritySweepSummary;
};

export class IclrIntegrityWatch {
  private running?: Promise<void>;
  private starting = false;
  private current?: PaperIntegritySweepSummary;
  private last?: PaperIntegritySweepSummary;

  constructor(private readonly deps: IclrIntegrityWatchDeps) {}

  status() {
    return {
      running: Boolean(this.running || this.starting),
      threshold: this.threshold(),
      ...(this.deps.until ? { until: this.deps.until.toISOString(), ended: this.ended() } : {}),
      ...(this.current ? { current_sweep: { ...this.current } } : {}),
      ...(this.last ? { last_sweep: { ...this.last } } : {}),
    };
  }

  /** Resolves when the background sweep (if any) has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    await this.running;
  }

  /**
   * Lists the account's ICLR submissions under review (so a credential failure surfaces to the
   * caller) and starts a background sweep that scores new versions and raises due alerts.
   */
  async start(): Promise<IclrIntegritySweepStart> {
    if (this.ended()) {
      return {
        started: false,
        submissions: 0,
        pending: 0,
        ended_at: this.deps.until!.toISOString(),
        ...(this.last ? { last_sweep: { ...this.last } } : {}),
      };
    }
    if (this.running || this.starting) {
      return {
        started: false,
        submissions: 0,
        pending: 0,
        ...(this.last ? { last_sweep: { ...this.last } } : {}),
      };
    }
    this.starting = true;
    let submissions: OpenReviewSubmission[];
    try {
      submissions = (await this.deps.reader.listSubmissions()).filter((submission) =>
        ICLR_UNDER_REVIEW.test(submission.venue_id),
      );
    } finally {
      this.starting = false;
    }
    const pending = submissions.filter((submission) => this.needsScore(submission)).length;
    const previous = this.last;
    const summary: PaperIntegritySweepSummary = {
      started_at: this.now().toISOString(),
      submissions: submissions.length,
      scored: 0,
      reused: 0,
      failed: 0,
      alerts: 0,
    };
    this.current = summary;
    this.running = this.sweep(submissions, summary)
      .catch(() => undefined)
      .finally(() => {
        summary.finished_at = this.now().toISOString();
        this.last = summary;
        this.current = undefined;
        this.running = undefined;
      });
    return {
      started: true,
      submissions: submissions.length,
      pending,
      ...(previous ? { last_sweep: { ...previous } } : {}),
    };
  }

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  private threshold() {
    return this.deps.threshold ?? DEFAULT_AI_THRESHOLD;
  }

  private ended() {
    return Boolean(this.deps.until && this.now().getTime() >= this.deps.until.getTime());
  }

  private needsScore(submission: OpenReviewSubmission): boolean {
    const existing = this.deps.store.getPaperAiTextCheck(submission.id, submission.pdf_path);
    return (
      !existing ||
      (existing.status === "failed" && existing.attempts < MAX_AI_CHECK_ATTEMPTS) ||
      isTextScore(existing)
    );
  }

  private async sweep(submissions: OpenReviewSubmission[], summary: PaperIntegritySweepSummary) {
    // Most recently changed first: near a deadline that is the paper somebody is still fixing.
    for (const submission of submissions.toSorted((a, b) => b.modified_at - a.modified_at)) {
      // Checked per paper: a sweep that straddles the cutoff stops rather than alerting late.
      if (this.ended()) {
        return;
      }
      if (this.needsScore(submission)) {
        await this.scoreVersion(submission, summary);
      }
      // Every sweep, not only after a fresh score: the citation watch finishes on its own
      // schedule, and its result for an already-scored version still has to reach the authors.
      await this.alertIfDue(submission, summary).catch(() => undefined);
    }
  }

  private async scoreVersion(
    submission: OpenReviewSubmission,
    summary: PaperIntegritySweepSummary,
  ) {
    const { store } = this.deps;
    const prior = store.getPaperAiTextCheck(submission.id, submission.pdf_path);
    // A re-score of a text-era result is the same version, so what was already alerted about it
    // carries over: without this, the new row would forget the alert and raise it a second time.
    const rescoring = prior && isTextScore(prior) ? prior : undefined;
    const base = {
      submission_id: submission.id,
      pdf_path: submission.pdf_path,
      title: submission.title,
      venue_id: submission.venue_id,
      attempts: rescoring ? 1 : (prior?.attempts ?? 0) + 1,
      checked_at: this.now().toISOString(),
      ...(rescoring?.alerted_for ? { alerted_for: rescoring.alerted_for } : {}),
      ...(rescoring?.alert_proposal_ids
        ? { alert_proposal_ids: rescoring.alert_proposal_ids }
        : {}),
      ...(rescoring?.alert_error ? { alert_error: rescoring.alert_error } : {}),
    };
    let bytes: Uint8Array;
    try {
      bytes = await this.deps.reader.readPdf(submission.id);
    } catch {
      summary.failed++;
      store.savePaperAiTextCheck({
        ...base,
        status: "failed",
        error: "The PDF could not be downloaded from OpenReview.",
      });
      return;
    }
    const pdfSha256 = createHash("sha256").update(bytes).digest("hex");
    // The same bytes under a new path (a metadata-only edit re-stores the file): reuse the score
    // and what was already alerted, rather than paying for it and messaging about it twice.
    const identical = store
      .listPaperAiTextChecks(submission.id)
      .find(
        (check) =>
          check.pdf_sha256 === pdfSha256 && check.status !== "failed" && !isTextScore(check),
      );
    if (identical) {
      summary.reused++;
      store.savePaperAiTextCheck({
        ...identical,
        ...base,
        pdf_sha256: pdfSha256,
      });
      return;
    }
    // Read locally only to recognize a placeholder: an abstract-only or text-less upload is not
    // worth paying Pangram to score. What Pangram scores is the PDF itself, below.
    let text: string;
    try {
      text = await this.deps.extractText(bytes);
    } catch (error) {
      summary.scored++;
      store.savePaperAiTextCheck({
        ...base,
        pdf_sha256: pdfSha256,
        status: "unreadable",
        error:
          error instanceof ReferenceCheckError
            ? error.message === NO_TEXT_LAYER
              ? "Placeholder PDF with no text; the full paper is scored when it is uploaded."
              : error.message
            : "The PDF could not be read.",
      });
      return;
    }
    const words = text.split(/\s+/u).filter(Boolean).length;
    if (words < MIN_WORDS) {
      summary.scored++;
      store.savePaperAiTextCheck({
        ...base,
        pdf_sha256: pdfSha256,
        status: "unreadable",
        words_scored: words,
        error: `Only ${words} words of main text; the full paper is scored when it is uploaded.`,
      });
      return;
    }
    const signal = AbortSignal.timeout(this.deps.scoreTimeoutMs ?? DEFAULT_SCORE_TIMEOUT_MS);
    try {
      const score = await this.deps.score(bytes, signal);
      summary.scored++;
      store.savePaperAiTextCheck({
        ...base,
        pdf_sha256: pdfSha256,
        status: "completed",
        scored_from: "pdf",
        words_scored: score.words_scored ?? words,
        fraction_ai: score.fraction_ai,
        fraction_ai_assisted: score.fraction_ai_assisted,
        fraction_human: score.fraction_human,
        ...(score.prediction ? { prediction: score.prediction } : {}),
      });
    } catch (error) {
      summary.failed++;
      // A failed re-score leaves the text-era score standing rather than replacing a real number
      // with an error; the next sweep tries again.
      if (rescoring) {
        return;
      }
      store.savePaperAiTextCheck({
        ...base,
        pdf_sha256: pdfSha256,
        status: "failed",
        words_scored: words,
        error:
          error instanceof PangramError
            ? error.message
            : signal.aborted
              ? "Pangram did not answer in time."
              : "The AI-text score could not be completed.",
      });
    }
  }

  private async alertIfDue(submission: OpenReviewSubmission, summary: PaperIntegritySweepSummary) {
    const { store, service } = this.deps;
    const check = store.getPaperAiTextCheck(submission.id, submission.pdf_path);
    if (!check) {
      return;
    }
    const citations = store.getOpenReviewCitationCheck(submission.id, submission.pdf_path);
    const notFound = notFoundCitations(citations);
    const already = new Set(check.alerted_for ?? []);
    const aiHigh = check.status === "completed" && (check.fraction_ai ?? 0) > this.threshold();
    const due: PaperIntegrityAlertReason[] = [
      ...(aiHigh && !already.has("ai_text") ? (["ai_text"] as const) : []),
      ...(notFound.length && !already.has("citations") ? (["citations"] as const) : []),
    ];
    if (!due.length) {
      return;
    }
    const recipients = this.recipients(submission);
    const userIds = [
      ...new Set(
        [recipients.professor, ...recipients.authors]
          .map((member) => member?.slack_user_id?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (!userIds.length) {
      // Not stamped: once someone links a Slack account the next sweep sends it.
      store.savePaperAiTextCheck({
        ...check,
        alert_error: "No head professor or lab author on this paper has a linked Slack account.",
      });
      return;
    }
    const message = buildIntegrityAlertMessage({
      submission,
      check,
      notFound,
      threshold: this.threshold(),
      professor: recipients.professor,
      authors: recipients.authors,
    });
    const proposed = service.createProposal({
      type: "paper_integrity.alert",
      summary: `Pre-deadline check flagged “${submission.title}” (${due.join(", ")})`,
      target: { service: "slack", channel: "slack", target: userIds.join(",") },
      proposed_payload: {
        channel: "slack",
        user_ids: userIds,
        message,
        paper_integrity: {
          submission_id: submission.id,
          pdf_path: submission.pdf_path,
          reasons: due,
        },
      },
      undo_plan: "Send a follow-up in the same group DM if the flag turns out to be wrong.",
    });
    if (!proposed.ok) {
      store.savePaperAiTextCheck({ ...check, alert_error: proposed.error.message });
      return;
    }
    // Stamped before the send and left stamped: a duplicate warning to a PI about their students'
    // paper is worse than one that has to be re-raised by hand from the audit log.
    const stamped: PaperAiTextCheck = {
      ...check,
      alerted_for: [...already, ...due],
      alert_proposal_ids: [...(check.alert_proposal_ids ?? []), proposed.payload.id],
    };
    delete stamped.alert_error;
    store.savePaperAiTextCheck(stamped);
    const executed = await service.execute(proposed.payload.id, { dry_run: false });
    if (!executed.ok) {
      store.savePaperAiTextCheck({ ...stamped, alert_error: executed.error.message });
      return;
    }
    summary.alerts++;
  }

  /** The head professor, and the first two full / coauthor-major lab members in author order. */
  private recipients(submission: OpenReviewSubmission): {
    professor?: AdminBotLabMember;
    authors: AdminBotLabMember[];
  } {
    const { store, service } = this.deps;
    const settings = service.getSettings();
    const professorId = settings.ok ? settings.payload.head_professor_member_id?.trim() : undefined;
    const professor = professorId ? store.getLabMember(professorId) : undefined;
    const byAuthorId = new Map<string, AdminBotLabMember>();
    for (const member of store.listLabMembers()) {
      for (const key of [member.openreview_id, member.email, member.calendar_email]) {
        const normalized = normalizeAuthorId(key);
        if (normalized && !byAuthorId.has(normalized)) {
          byAuthorId.set(normalized, member);
        }
      }
    }
    const authors: AdminBotLabMember[] = [];
    for (const authorId of submission.author_ids ?? []) {
      const member = byAuthorId.get(normalizeAuthorId(authorId) ?? "");
      if (
        !member ||
        member.id === professor?.id ||
        authors.some((author) => author.id === member.id) ||
        adminBotIsAlumniMember(member) ||
        !(
          adminBotIsFullMemberType(member.member_type) ||
          adminBotIsCoauthorMajorType(member.member_type)
        )
      ) {
        continue;
      }
      authors.push(member);
      if (authors.length === ALERTED_AUTHORS) {
        break;
      }
    }
    return { ...(professor ? { professor } : {}), authors };
  }
}

/** A tilde id, a profile URL or an email, lower-cased so the roster's spelling does not matter. */
export function normalizeAuthorId(value: string | undefined): string | undefined {
  let id = value?.trim();
  if (!id) {
    return undefined;
  }
  const fromUrl = /openreview\.net\/profile\?id=([^&#\s]+)/iu.exec(id);
  if (fromUrl) {
    try {
      id = decodeURIComponent(fromUrl[1]);
    } catch {
      id = fromUrl[1];
    }
  }
  return id.toLowerCase();
}

function notFoundCitations(check: OpenReviewCitationCheck | undefined): string[] {
  if (!check || check.status !== "completed") {
    return [];
  }
  return (check.findings ?? [])
    .filter((finding) => finding.status === "not_found")
    .map((finding) => finding.citation);
}

function displayName(member: AdminBotLabMember) {
  return member.preferred_name?.trim() || member.name.trim();
}

function percent(fraction: number | undefined) {
  return `${Math.round((fraction ?? 0) * 100)}%`;
}

export function buildIntegrityAlertMessage(input: {
  submission: OpenReviewSubmission;
  check: PaperAiTextCheck;
  notFound: string[];
  threshold: number;
  professor?: AdminBotLabMember;
  authors: AdminBotLabMember[];
}): string {
  const { submission, check, notFound, threshold, professor, authors } = input;
  const people = [professor, ...authors]
    .filter((member): member is AdminBotLabMember => Boolean(member))
    .map(displayName);
  const lines = [
    `:rotating_light: ICLR pre-deadline check: “${submission.title}”`,
    `https://openreview.net/forum?id=${submission.id}`,
    ...(people.length ? [`For ${people.join(", ")}.`] : []),
    ...(authors.length
      ? []
      : [
          "No full or coauthor-major lab member could be matched on this paper's author list, so only the professor is here.",
        ]),
    "",
  ];
  if (check.status === "completed") {
    const over = (check.fraction_ai ?? 0) > threshold;
    lines.push(
      `• *AI-generated text:* Pangram classifies ${percent(check.fraction_ai)} of the main text as AI-written` +
        ` and ${percent(check.fraction_ai_assisted)} as AI-assisted (${check.words_scored ?? 0} words, before the references).` +
        (over
          ? ` That is over the ${percent(threshold)} alert threshold.`
          : ` That is under the ${percent(threshold)} alert threshold.`),
    );
  } else {
    lines.push(
      `• *AI-generated text:* not scored for this version (${check.error ?? check.status}).`,
    );
  }
  if (notFound.length) {
    lines.push(
      `• *Citations:* ${notFound.length} reference(s) matched nothing in Crossref, DBLP, Semantic Scholar, OpenAlex or arXiv:`,
      ...notFound
        .slice(0, MAX_LISTED_CITATIONS)
        .map(
          (citation) => `    – ${citation.length > 220 ? `${citation.slice(0, 220)}…` : citation}`,
        ),
      ...(notFound.length > MAX_LISTED_CITATIONS
        ? [
            `    …and ${notFound.length - MAX_LISTED_CITATIONS} more, listed under General Tools → PDF Reference Checker.`,
          ]
        : []),
    );
  } else {
    lines.push(
      "• *Citations:* no reference is missing from every database (or the check has not finished yet).",
    );
  }
  lines.push(
    "",
    "These are automated signals for a person to look at, not a finding about anyone's writing. Fabricated references are grounds for desk rejection, so please check the flagged parts and upload a corrected PDF before the deadline. AdminBot re-checks every new upload within the hour.",
  );
  return lines.join("\n");
}

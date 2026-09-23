// Checks the citations of every paper the lab's OpenReview account has submitted, once per
// uploaded version, so a fabricated or garbled reference is caught before a desk rejection.
//
// Read-only against the outside world: the PDF is downloaded and parsed on this host, and only
// the extracted citation strings are looked up in public scholarly databases. The one outbound
// act -- telling someone a paper has flagged citations -- is an `email.send` proposal that an
// admin approves like any other, never a send from here.
//
// The sweep runs in the background of the service process, not inside the request that starts
// it: a first pass over a PI's history is hundreds of papers at several minutes each, far past
// any HTTP or cron timeout. The submission list is re-read after every paper, so a version
// uploaded mid-backfill is checked next rather than after the backlog.

import { createHash } from "node:crypto";
import {
  ReferenceCheckError,
  type PdfReferenceChecker,
  type ReferenceFinding,
} from "../../connectors/reference-check.js";
import type {
  OpenReviewCitationCheck,
  OpenReviewCitationSweepSummary,
  OpenReviewSubmission,
  OpenReviewSubmissionReader,
} from "../../contracts/openreview-citation-checks.js";
import type { AdminBotService, AdminBotServiceStore } from "../../kernel/service.js";

// A transient failure (download, timeout, every database down) is retried by later sweeps, but
// not forever: a PDF that keeps failing is an operator's problem, not an hourly retry loop's.
export const MAX_CITATION_CHECK_ATTEMPTS = 3;
const DEFAULT_CHECK_TIMEOUT_MS = 60 * 60_000;
// More unchecked references than this and the version is retried rather than reported.
const MAX_UNCHECKED_SHARE = 0.2;
// Bounds the email, not the check: every finding stays on the stored record and in the UI.
const MAX_EMAILED_FINDINGS = 40;

export type OpenReviewCitationWatchDeps = {
  store: AdminBotServiceStore;
  service: AdminBotService;
  reader: OpenReviewSubmissionReader;
  check: PdfReferenceChecker;
  /** Who the flagged-citation email proposal is addressed to. Absent: results are stored only. */
  notifyEmail?: string;
  now?: () => Date;
  checkTimeoutMs?: number;
};

export type OpenReviewCitationSweepStart = {
  started: boolean;
  submissions: number;
  pending: number;
  last_sweep?: OpenReviewCitationSweepSummary;
};

export function isFlagged(finding: { status: string }): boolean {
  return finding.status === "not_found" || finding.status === "review";
}

export class OpenReviewCitationWatch {
  private running?: Promise<void>;
  private starting = false;
  private current?: OpenReviewCitationSweepSummary;
  private last?: OpenReviewCitationSweepSummary;

  constructor(private readonly deps: OpenReviewCitationWatchDeps) {}

  status() {
    return {
      running: Boolean(this.running || this.starting),
      ...(this.current ? { current_sweep: { ...this.current } } : {}),
      ...(this.last ? { last_sweep: { ...this.last } } : {}),
      notify_email: this.deps.notifyEmail ?? null,
    };
  }

  /** Resolves when the background sweep (if any) has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    await this.running;
  }

  /**
   * Lists the account's submissions (so a credential failure surfaces to the caller) and starts
   * a background sweep over the ones whose current version has not been checked.
   */
  async start(): Promise<OpenReviewCitationSweepStart> {
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
      submissions = await this.deps.reader.listSubmissions();
    } finally {
      this.starting = false;
    }
    const pending = submissions.filter((submission) => this.needsCheck(submission)).length;
    const previous = this.last;
    const summary: OpenReviewCitationSweepSummary = {
      started_at: this.now().toISOString(),
      checked: 0,
      flagged: 0,
      failed: 0,
      reused: 0,
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

  private needsCheck(submission: OpenReviewSubmission): boolean {
    const existing = this.deps.store.getOpenReviewCitationCheck(submission.id, submission.pdf_path);
    return (
      !existing || (existing.status === "failed" && existing.attempts < MAX_CITATION_CHECK_ATTEMPTS)
    );
  }

  private async sweep(initial: OpenReviewSubmission[], summary: OpenReviewCitationSweepSummary) {
    let submissions = initial;
    // Within one sweep a version is tried once; a transient failure waits for the next sweep.
    const attempted = new Set<string>();
    for (;;) {
      const next = submissions
        .filter(
          (submission) => !attempted.has(versionKey(submission)) && this.needsCheck(submission),
        )
        .toSorted((a, b) => b.modified_at - a.modified_at)[0];
      if (!next) {
        return;
      }
      attempted.add(versionKey(next));
      await this.checkVersion(next, summary);
      // A failed re-read keeps the last list rather than ending a backfill early.
      submissions = await this.deps.reader.listSubmissions().catch(() => submissions);
    }
  }

  private async checkVersion(
    submission: OpenReviewSubmission,
    summary: OpenReviewCitationSweepSummary,
  ) {
    const { store } = this.deps;
    const prior = store.getOpenReviewCitationCheck(submission.id, submission.pdf_path);
    const base = {
      submission_id: submission.id,
      pdf_path: submission.pdf_path,
      title: submission.title,
      venue_id: submission.venue_id,
      attempts: (prior?.attempts ?? 0) + 1,
      checked_at: this.now().toISOString(),
    };
    let bytes: Uint8Array;
    try {
      bytes = await this.deps.reader.readPdf(submission.id);
    } catch {
      summary.failed++;
      store.saveOpenReviewCitationCheck({
        ...base,
        status: "failed",
        error: "The PDF could not be downloaded from OpenReview.",
      });
      return;
    }
    const pdfSha256 = createHash("sha256").update(bytes).digest("hex");
    // The same bytes uploaded again (or a metadata-only edit that re-stored the file): one check
    // per distinct PDF, and no second email about findings already raised.
    const identical = store
      .listOpenReviewCitationChecks(submission.id)
      .find((check) => check.pdf_sha256 === pdfSha256 && check.status !== "failed");
    if (identical) {
      summary.reused++;
      store.saveOpenReviewCitationCheck({
        ...base,
        pdf_sha256: pdfSha256,
        status: identical.status,
        ...(identical.findings ? { findings: identical.findings } : {}),
        ...(identical.error ? { error: identical.error } : {}),
        ...(identical.notification_proposal_id
          ? { notification_proposal_id: identical.notification_proposal_id }
          : {}),
      });
      return;
    }
    const signal = AbortSignal.timeout(this.deps.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS);
    let findings: ReferenceFinding[];
    try {
      findings = (await this.deps.check(bytes, signal)).findings;
    } catch (error) {
      if (error instanceof ReferenceCheckError) {
        // Deterministic for these bytes; its messages are fixed strings, safe to store and show.
        summary.checked++;
        store.saveOpenReviewCitationCheck({
          ...base,
          pdf_sha256: pdfSha256,
          status: "unreadable",
          error: error.message,
        });
        return;
      }
      summary.failed++;
      store.saveOpenReviewCitationCheck({
        ...base,
        pdf_sha256: pdfSha256,
        status: "failed",
        error: signal.aborted
          ? "The check did not finish in time."
          : "The reference check could not be completed.",
      });
      return;
    }
    const unchecked = findings.filter((finding) => finding.status === "unavailable").length;
    if (unchecked > findings.length * MAX_UNCHECKED_SHARE) {
      // Too little was actually checked; recording this as complete would read as a clean paper.
      // A later sweep retries, by which time a rate-limited database has usually recovered.
      summary.failed++;
      store.saveOpenReviewCitationCheck({
        ...base,
        pdf_sha256: pdfSha256,
        status: "failed",
        error:
          unchecked === findings.length
            ? "No reference database could be reached."
            : `${unchecked} of ${findings.length} references could not be checked against every database.`,
      });
      return;
    }
    const check: OpenReviewCitationCheck = {
      ...base,
      pdf_sha256: pdfSha256,
      status: "completed",
      findings,
    };
    // Stored before the proposal, so a proposal failure never costs the result.
    store.saveOpenReviewCitationCheck(check);
    summary.checked++;
    const flagged = findings.filter(isFlagged);
    if (!flagged.length) {
      return;
    }
    summary.flagged++;
    const proposalId = this.proposeNotification(check, flagged);
    if (proposalId) {
      store.saveOpenReviewCitationCheck({ ...check, notification_proposal_id: proposalId });
    }
  }

  private proposeNotification(check: OpenReviewCitationCheck, flagged: ReferenceFinding[]) {
    const to = this.deps.notifyEmail;
    if (!to) {
      return undefined;
    }
    const notFound = flagged.filter((finding) => finding.status === "not_found").length;
    const listed = flagged
      .toSorted((a, b) => Number(b.status === "not_found") - Number(a.status === "not_found"))
      .slice(0, MAX_EMAILED_FINDINGS);
    const result = this.deps.service.createProposal({
      type: "email.send",
      summary: `Review ${flagged.length} flagged citation(s) in OpenReview submission “${check.title}”`,
      target: { service: "google", channel: "email", target: to },
      proposed_payload: {
        to,
        subject: `Citation check: ${flagged.length} reference(s) to review in “${check.title}”`,
        body: [
          `AdminBot checked the references of the latest uploaded version of “${check.title}” (${check.venue_id || "OpenReview"}).`,
          `${notFound} reference(s) had no match in Crossref, Semantic Scholar, OpenAlex, DBLP or arXiv, and ${flagged.length - notFound} matched a record whose details differ.`,
          "These are automated findings for human review, not proof of fabrication. Please correct any real errors and upload a new version; it will be checked again automatically.",
          `https://openreview.net/forum?id=${check.submission_id}`,
          ...listed.map(
            (finding) =>
              `${finding.status === "not_found" ? "Not found" : "Check details"}: ${finding.citation}\n${finding.explanation}`,
          ),
          ...(flagged.length > listed.length
            ? [
                `…and ${flagged.length - listed.length} more, listed under General Tools → PDF Reference Checker.`,
              ]
            : []),
        ].join("\n\n"),
        openreview_citation_check: {
          submission_id: check.submission_id,
          pdf_path: check.pdf_path,
        },
      },
      undo_plan: "Email cannot be recalled; review the findings before approving delivery.",
    });
    return result.ok ? result.payload.id : undefined;
  }
}

function versionKey(submission: OpenReviewSubmission) {
  return JSON.stringify([submission.id, submission.pdf_path]);
}

import { createHash } from "node:crypto";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import type { ReferenceScan, ReferenceScanDependencies } from "../contracts/reference-scans.js";
import type { AdminBotActionExecutor, AdminBotService, AdminBotServiceStore } from "./service.js";

export function referenceScanId(submissionId: string, pdfHash: string): string {
  return `gptzero-v1:${submissionId}:${pdfHash}`;
}

export class ReferenceScans {
  constructor(
    private readonly store: AdminBotServiceStore,
    private readonly service: AdminBotService,
    private readonly dependencies: ReferenceScanDependencies,
  ) {}

  get(submissionId: string, pdfHash: string) {
    return this.store.getReferenceScan(submissionId, pdfHash);
  }

  async propose(submissionId: string, notifyEmail: string) {
    if (!this.dependencies.scanPdf) {
      throw new Error("Set GPTZERO_API_KEY in the AdminBot service environment");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(notifyEmail)) {
      throw new Error("A notification email is required");
    }
    const pdf = await this.dependencies.readPdf(submissionId);
    const hash = createHash("sha256").update(pdf.bytes).digest("hex");
    const id = referenceScanId(submissionId, hash);
    const scan = this.store.getReferenceScan(submissionId, hash);
    if (scan?.status === "completed") {
      return { scan, cached: true };
    }
    const existing = this.store.listProposalsByType("reference.scan").find((proposal) => {
      const payload = (proposal.proposed_payload ?? {}) as Record<string, unknown>;
      return (
        payload.scan_id === id &&
        payload.notify_email === notifyEmail &&
        proposal.status !== "rejected"
      );
    });
    if (existing) {
      return { proposal: existing, cached: false };
    }
    const result = this.service.createProposal({
      type: "reference.scan",
      summary: `Upload public OpenReview paper “${pdf.title}” to GPTZero for a bibliography scan`,
      target: { service: "gptzero", target: submissionId },
      proposed_payload: {
        scan_id: id,
        submission_id: submissionId,
        pdf_sha256: hash,
        title: pdf.title,
        notify_email: notifyEmail,
      },
      undo_plan:
        "The upload cannot be undone. Findings only create a separate email proposal for review.",
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return { proposal: result.payload, cached: false };
  }

  executor(inner?: AdminBotActionExecutor): AdminBotActionExecutor {
    return {
      execute: (proposal) =>
        proposal.type === "reference.scan"
          ? this.execute(proposal)
          : inner
            ? inner.execute(proposal)
            : Promise.resolve({ handled: false }),
    };
  }

  private async execute(proposal: AdminBotStoredProposal) {
    const payload = (proposal.proposed_payload ?? {}) as Record<string, unknown>;
    const submissionId = typeof payload.submission_id === "string" ? payload.submission_id : "";
    const hash = typeof payload.pdf_sha256 === "string" ? payload.pdf_sha256 : "";
    const email = typeof payload.notify_email === "string" ? payload.notify_email : "";
    const id = referenceScanId(submissionId, hash);
    if (
      !/^[A-Za-z0-9_-]{4,128}$/u.test(submissionId) ||
      !/^[a-f0-9]{64}$/u.test(hash) ||
      payload.scan_id !== id ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
    ) {
      throw new Error("Invalid reference scan payload");
    }
    if (!this.dependencies.scanPdf) {
      throw new Error("GPTZERO_API_KEY is not configured");
    }
    let scan = this.store.getReferenceScan(submissionId, hash);
    if (scan?.status === "running") {
      // Do not resubmit a potentially billed upload after a crash without operator review.
      throw new Error(
        "This scan is already running or was interrupted; inspect it before retrying",
      );
    }
    if (scan?.status !== "completed") {
      const pdf = await this.dependencies.readPdf(submissionId);
      if (createHash("sha256").update(pdf.bytes).digest("hex") !== hash) {
        throw new Error("The PDF changed since approval; propose a scan of the new version");
      }
      // A different approved proposal can finish downloading the same PDF concurrently.
      const latest = this.store.getReferenceScan(submissionId, hash);
      if (latest?.status === "running") {
        throw new Error("This PDF is already being scanned");
      }
      if (latest?.status === "completed") {
        this.proposeNotification(
          latest,
          email,
          typeof payload.title === "string" ? payload.title : submissionId,
        );
        return { handled: true, delivered: true, artifacts: { scan_id: id } };
      }
      scan = {
        submission_id: submissionId,
        pdf_sha256: hash,
        status: "running",
      };
      this.store.saveReferenceScan(scan);
      try {
        const result = await this.dependencies.scanPdf(pdf.bytes);
        scan = { ...scan, result, status: "completed" };
        this.store.saveReferenceScan(scan);
      } catch {
        this.store.saveReferenceScan({
          ...scan,
          status: "failed",
        });
        throw new Error("GPTZero scan failed; retrying may incur another provider charge");
      }
    }
    this.proposeNotification(
      scan,
      email,
      typeof payload.title === "string" ? payload.title : submissionId,
    );
    return { handled: true, delivered: true, artifacts: { scan_id: id } };
  }

  private proposeNotification(scan: ReferenceScan, email: string, title: string) {
    if (!scan.result?.findings.length) {
      return;
    }
    // The proposal ledger owns notification tracking, including retries after a crash.
    const existing = this.store
      .listProposalsByType("email.send")
      .find(
        (proposal) =>
          ((proposal.proposed_payload ?? {}) as Record<string, unknown>).reference_scan_id ===
          referenceScanId(scan.submission_id, scan.pdf_sha256),
      );
    if (!existing) {
      const result = this.service.createProposal({
        type: "email.send",
        summary: `Review ${scan.result.findings.length} possible citation issues in “${title}”`,
        target: { service: "google", channel: "email", target: email },
        proposed_payload: {
          to: email,
          subject: `Reference check: ${title}`,
          body: [
            "GPTZero flagged possible citation issues. These are automated findings for human review, not confirmed fabrication.",
            `https://openreview.net/forum?id=${scan.submission_id}`,
            `PDF SHA-256: ${scan.pdf_sha256}`,
            ...scan.result.findings.map(
              (finding) => `${finding.status}: ${finding.citation}\n${finding.explanation}`,
            ),
          ].join("\n\n"),
          reference_scan_id: referenceScanId(scan.submission_id, scan.pdf_sha256),
        },
        undo_plan: "Email cannot be recalled; review the findings before approving delivery.",
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    }
  }
}

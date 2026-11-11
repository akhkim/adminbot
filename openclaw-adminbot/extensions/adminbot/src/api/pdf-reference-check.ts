import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PaperMentorReferenceCheck } from "../connectors/papermentor-uploads.js";
import {
  createPdfReferenceChecker,
  createReferenceListChecker,
  ReferenceCheckError,
  referenceCitation,
  type PdfReferenceChecker,
  type ReferenceListChecker,
  type ReferenceReport,
} from "../connectors/reference-check.js";
import { GptZeroScanError } from "../connectors/reference-scan.js";
import type {
  ReferenceScanDependencies,
  ReferenceScanResult,
} from "../contracts/reference-scans.js";
import { AdminBotService } from "../kernel/service.js";
import { AdminBotMemoryStore } from "../persistence/memory.js";

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_CONCURRENT_CHECKS = 5;

function createCheckLimiter() {
  const activeUsers = new Set<string>();
  return (userId: string) => {
    if (activeUsers.has(userId)) {
      return { error: "You already have a PDF check running. Wait for it to finish." };
    }
    if (activeUsers.size >= MAX_CONCURRENT_CHECKS) {
      return { error: "All five PDF checking slots are busy. Try again shortly." };
    }
    // No await between checking and reserving: acquisition is atomic within this process.
    activeUsers.add(userId);
    let released = false;
    return {
      release() {
        if (!released) {
          released = true;
          activeUsers.delete(userId);
        }
      },
    };
  };
}

/**
 * One reference check through the approval gate, with nothing persisted.
 *
 * Sending citations to scholarly databases (or a PDF to GPTZero) is an external effect, so it is a
 * `reference.scan` proposal like any other -- but proposed, approved and executed in a throwaway
 * store, so no manuscript, citation or result ever enters SQLite. The approval is the requester's
 * own explicit consent (the Submit click, or the box ticked on a PaperMentor upload), bound to the
 * hash of exactly the content being checked. The caller audits the fact of the check.
 */
export async function runApprovedReferenceScan<T>(params: {
  actorId: string;
  checker: "references-validation" | "gptzero";
  /** sha256 of what is sent: the PDF's bytes, or the reference list read from a paper's .bib. */
  contentSha256: string;
  target: "uploaded-pdf" | "papermentor-upload";
  run: () => Promise<T>;
}): Promise<T> {
  let result: { value: T } | undefined;
  const service = new AdminBotService(new AdminBotMemoryStore(), {
    executor: {
      async execute(proposal) {
        const payload = proposal.proposed_payload as { pdf_sha256?: string; checker?: string };
        if (
          proposal.type !== "reference.scan" ||
          payload.pdf_sha256 !== params.contentSha256 ||
          payload.checker !== params.checker
        ) {
          return { handled: false };
        }
        result = { value: await params.run() };
        return { handled: true, delivered: true };
      },
    },
  });
  const proposed = service.createProposal({
    type: "reference.scan",
    summary:
      params.checker === "gptzero"
        ? "Check PDF references with GPTZero"
        : "Check extracted references against scholarly databases",
    target: { service: params.checker, target: params.target },
    proposed_payload: { pdf_sha256: params.contentSha256, checker: params.checker },
    undo_plan: "Data sent to the selected checker cannot be recalled.",
  });
  if (!proposed.ok) {
    throw new Error("Could not propose scan");
  }
  const approved = service.approve(proposed.payload.id, {
    approver_id: params.actorId,
    approver_role: "admin",
    payload_hash: proposed.payload.payload_hash,
  });
  if (!approved.ok) {
    throw new Error("Could not approve scan");
  }
  const executed = await service.execute(proposed.payload.id, { dry_run: false });
  if (!executed.ok || !result) {
    throw new Error("Could not execute scan");
  }
  return result.value;
}

/** What the durable audit ledger keeps of one check: who sent what where, never the PDF. */
export type PdfReferenceCheckAudit = {
  actor: string;
  checker: "references-validation" | "gptzero";
  /**
   * sha256 of what was sent: the PDF, or (from a PaperMentor review) the citations of the source
   * bibliography's entries, one per line.
   */
  pdf_sha256: string;
  outcome: "completed" | "failed";
  /**
   * Set for the check a PaperMentor review ran. Always "bib" (the paper's source bibliography) now;
   * older ledger rows may say "pdf", from before the PDF fallback was dropped.
   */
  papermentor?: { input: "bib" };
};

/**
 * The reference half of a PaperMentor review: the same lookups as the PDF checker, behind the same
 * approval gate, audited the same way.
 *
 * Tighter than the interactive page in one respect and looser in another. A "not found" is claimed
 * only once Crossref and a broad index have answered (`requireAllDatabases`), since nobody is
 * watching to retry -- otherwise a rate-limited afternoon would mark half a bibliography missing.
 * And it allows 200 references rather than 100, since the check runs in the background rather than
 * holding a browser request open.
 */
export function createPaperMentorReferenceCheck(
  options: {
    listChecker?: ReferenceListChecker;
    audit?: (event: PdfReferenceCheckAudit) => void;
  } = {},
): PaperMentorReferenceCheck {
  const listChecker =
    options.listChecker ??
    createReferenceListChecker({ maxReferences: 200, requireAllDatabases: true });
  return async ({ memberId, references, signal }) => {
    const hash = createHash("sha256")
      .update(references.map(referenceCitation).join("\n"))
      .digest("hex");
    const audit = (outcome: PdfReferenceCheckAudit["outcome"]) => {
      try {
        options.audit?.({
          actor: memberId,
          checker: "references-validation",
          pdf_sha256: hash,
          outcome,
          papermentor: { input: "bib" },
        });
      } catch {
        // As for the page: the check happened; the ledger hiccup must not change its outcome.
      }
    };
    try {
      const report = await runApprovedReferenceScan({
        actorId: memberId,
        checker: "references-validation",
        contentSha256: hash,
        target: "papermentor-upload",
        run: () => listChecker(references, signal),
      });
      audit("completed");
      return report;
    } catch (error) {
      audit("failed");
      throw error;
    }
  };
}

/**
 * Request-scoped approval/execution: no PDF, proposal or result enters SQLite.
 *
 * One thing does. The approval and execution run in a throwaway store so a manuscript never
 * persists, but that also kept the fact of the check out of the ledger -- including a paid upload
 * of a possibly unpublished paper to GPTZero. `audit` records it: the checker, the PDF's hash, the
 * admin and the outcome, once the bytes have actually left for the provider.
 */
export function createPdfReferenceCheckHandler(
  scanPdf: PdfReferenceChecker = createPdfReferenceChecker(),
  scanGptZero?: ReferenceScanDependencies["scanPdf"],
  audit?: (event: PdfReferenceCheckAudit) => void,
) {
  const tryAcquire = createCheckLimiter();
  return async (req: IncomingMessage, res: ServerResponse, adminId: string) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const stream = req.headers.accept?.includes("application/x-ndjson") ?? false;
    const sendEvent = (event: unknown) => {
      if (res.destroyed || res.writableEnded) {
        throw new Error("Client disconnected");
      }
      if (!res.headersSent) {
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("X-Accel-Buffering", "no");
        res.setHeader("Cache-Control", "no-store, no-transform");
        res.flushHeaders();
      }
      res.write(JSON.stringify(event) + "\n");
    };
    const reply = (status: number, body: unknown) => {
      if (res.headersSent) {
        sendEvent({ type: "error", ...(body as object) });
        res.end();
        return;
      }
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const checker = params.get("checker") ?? "references-validation";
    if (checker !== "references-validation" && checker !== "gptzero") {
      reply(400, { error: { message: "Unknown reference checker." } });
      return;
    }
    const consent = checker === "gptzero" ? "upload-to-gptzero" : "query-reference-databases";
    if (params.get("consent") !== consent) {
      reply(400, {
        error: {
          message:
            checker === "gptzero"
              ? "Approval to upload the PDF to GPTZero is required."
              : "Approval to query scholarly databases with the extracted citations is required.",
        },
      });
      return;
    }
    if (checker === "gptzero" && !scanGptZero) {
      reply(503, {
        error: {
          message: "GPTZero is not configured. Set GPTZERO_API_KEY on the AdminBot service.",
        },
      });
      return;
    }
    if (req.headers["content-type"]?.split(";")[0].trim() !== "application/pdf") {
      reply(415, { error: { message: "Choose a PDF file." } });
      return;
    }
    if (Number(req.headers["content-length"]) > MAX_PDF_BYTES) {
      reply(413, { error: { message: "PDFs must be 20 MB or smaller." } });
      return;
    }
    const permit = tryAcquire(adminId);
    if (permit.error !== undefined) {
      reply(429, { error: { message: permit.error } });
      return;
    }
    let scanFailure: ReferenceCheckError | GptZeroScanError | undefined;
    // Set when the executor hands the PDF to the provider; only then is there something to audit.
    let sent: { pdf_sha256: string; completed: boolean } | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on("close", abort);
    const deadline = setTimeout(abort, 10 * 60_000);
    const timeout = setTimeout(() => {
      abort();
      req.destroy();
    }, 30_000);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_PDF_BYTES) {
          reply(413, { error: { message: "PDFs must be 20 MB or smaller." } });
          return;
        }
        chunks.push(bytes);
      }
      clearTimeout(timeout);
      const pdf = Buffer.concat(chunks);
      if (pdf.subarray(0, 5).toString() !== "%PDF-") {
        reply(415, { error: { message: "The uploaded file is not a PDF." } });
        return;
      }
      const hash = createHash("sha256").update(pdf).digest("hex");
      const result = await runApprovedReferenceScan({
        actorId: adminId,
        checker,
        contentSha256: hash,
        target: "uploaded-pdf",
        run: async (): Promise<ReferenceReport | ReferenceScanResult> => {
          sent = { pdf_sha256: hash, completed: false };
          try {
            return checker === "gptzero"
              ? await scanGptZero!(pdf)
              : await scanPdf(
                  pdf,
                  controller.signal,
                  stream ? (progress) => sendEvent({ type: "progress", ...progress }) : undefined,
                );
          } catch (error) {
            if (error instanceof ReferenceCheckError || error instanceof GptZeroScanError) {
              scanFailure = error;
            }
            throw error;
          }
        },
      });
      if (sent) {
        sent.completed = true;
      }
      if (stream) {
        sendEvent({ type: "complete", result: { ...result, checker } });
        res.end();
      } else {
        reply(200, { ...result, checker });
      }
    } catch {
      // Provider errors can contain manuscript text or credentials; never relay them.
      if (!res.destroyed && !res.writableEnded) {
        reply(
          controller.signal.aborted ? 504 : scanFailure instanceof ReferenceCheckError ? 422 : 502,
          {
            error: {
              message:
                (controller.signal.aborted
                  ? "The check timed out or was cancelled. Try a smaller PDF."
                  : scanFailure?.message) ??
                (checker === "gptzero"
                  ? "GPTZero could not complete this check. Retrying may incur another charge."
                  : "The reference check could not be completed."),
            },
          },
        );
      }
    } finally {
      if (sent) {
        try {
          audit?.({
            actor: adminId,
            checker,
            pdf_sha256: sent.pdf_sha256,
            outcome: sent.completed ? "completed" : "failed",
          });
        } catch {
          // The check itself already happened; a ledger hiccup must not turn it into an error.
        }
      }
      clearTimeout(timeout);
      clearTimeout(deadline);
      res.off("close", abort);
      permit.release();
    }
  };
}

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createPdfReferenceChecker,
  ReferenceCheckError,
  type PdfReferenceChecker,
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

/** What the durable audit ledger keeps of one check: who sent what where, never the PDF. */
export type PdfReferenceCheckAudit = {
  actor: string;
  checker: "references-validation" | "gptzero";
  pdf_sha256: string;
  outcome: "completed" | "failed";
};

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
  let busy = false;
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
    if (busy) {
      reply(429, { error: { message: "Another PDF check is running. Try again shortly." } });
      return;
    }
    busy = true;
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
      let result: ReferenceReport | ReferenceScanResult | undefined;
      const service = new AdminBotService(new AdminBotMemoryStore(), {
        executor: {
          async execute(proposal) {
            const payload = proposal.proposed_payload as { pdf_sha256?: string; checker?: string };
            if (
              proposal.type !== "reference.scan" ||
              payload.pdf_sha256 !== hash ||
              payload.checker !== checker
            ) {
              return { handled: false };
            }
            sent = { pdf_sha256: hash, completed: false };
            try {
              result =
                checker === "gptzero"
                  ? await scanGptZero!(pdf)
                  : await scanPdf(
                      pdf,
                      controller.signal,
                      stream
                        ? (progress) => sendEvent({ type: "progress", ...progress })
                        : undefined,
                    );
            } catch (error) {
              if (error instanceof ReferenceCheckError || error instanceof GptZeroScanError) {
                scanFailure = error;
              }
              throw error;
            }
            return { handled: true, delivered: true };
          },
        },
      });
      const proposed = service.createProposal({
        type: "reference.scan",
        summary:
          checker === "gptzero"
            ? "Check PDF references with GPTZero"
            : "Check extracted PDF references against scholarly databases",
        target: { service: checker, target: "uploaded-pdf" },
        proposed_payload: { pdf_sha256: hash, checker },
        undo_plan: "Data sent to the selected checker cannot be recalled.",
      });
      if (!proposed.ok) {
        throw new Error("Could not propose scan");
      }
      // The authenticated admin's Submit click approves these exact uploaded bytes.
      const approved = service.approve(proposed.payload.id, {
        approver_id: adminId,
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
      busy = false;
    }
  };
}

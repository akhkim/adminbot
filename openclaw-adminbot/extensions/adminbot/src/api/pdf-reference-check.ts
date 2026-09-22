import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GptZeroScanError } from "../connectors/reference-scan.js";
import type {
  ReferenceScanDependencies,
  ReferenceScanResult,
} from "../contracts/reference-scans.js";
import { AdminBotService } from "../kernel/service.js";
import { AdminBotMemoryStore } from "../persistence/memory.js";

const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** Request-scoped approval/execution: no PDF, proposal, audit, or result enters SQLite. */
export function createPdfReferenceCheckHandler(scanPdf: ReferenceScanDependencies["scanPdf"]) {
  let busy = false;
  return async (req: IncomingMessage, res: ServerResponse, adminId: string) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const reply = (status: number, body: unknown) => {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    if (!scanPdf) {
      reply(503, { error: { message: "GPTZero is not configured on this service." } });
      return;
    }
    if (
      new URL(req.url ?? "/", "http://localhost").searchParams.get("consent") !== "send-to-gptzero"
    ) {
      reply(400, { error: { message: "Approval to send this PDF to GPTZero is required." } });
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
    let scanFailure: GptZeroScanError | undefined;
    const timeout = setTimeout(() => req.destroy(), 30_000);
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
      let result: ReferenceScanResult | undefined;
      const service = new AdminBotService(new AdminBotMemoryStore(), {
        executor: {
          async execute(proposal) {
            const payload = proposal.proposed_payload as { pdf_sha256?: string };
            if (proposal.type !== "reference.scan" || payload.pdf_sha256 !== hash) {
              return { handled: false };
            }
            try {
              result = await scanPdf(pdf);
            } catch (error) {
              if (error instanceof GptZeroScanError) {
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
        summary: "Send the uploaded PDF to GPTZero for a reference check",
        target: { service: "gptzero", target: "uploaded-pdf" },
        proposed_payload: { pdf_sha256: hash },
        undo_plan: "The upload to GPTZero cannot be undone.",
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
      reply(200, result);
    } catch {
      // Provider errors can contain manuscript text or credentials; never relay them.
      if (!res.destroyed && !res.writableEnded) {
        reply(502, {
          error: {
            message:
              scanFailure?.message ??
              "GPTZero could not complete this check. Retrying may incur another charge.",
          },
        });
      }
    } finally {
      clearTimeout(timeout);
      busy = false;
    }
  };
}

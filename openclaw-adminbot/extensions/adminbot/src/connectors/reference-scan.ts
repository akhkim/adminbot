import type { PublicOpenReviewPdf, ReferenceScanResult } from "../contracts/reference-scans.js";

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;

async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) {
    throw new Error(`Reference provider returned HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.length;
      if (size > limit) {
        throw new Error("Reference provider response exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid reference provider response");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function field(value: unknown): string {
  return typeof value === "string" ? value : text(record(value).value);
}

/** No credentials or redirects: private submissions must never reach a remote scanner. */
export function createPublicOpenReviewPdfReader(fetchImpl = globalThis.fetch) {
  return async (submissionId: string): Promise<PublicOpenReviewPdf> => {
    if (!/^[A-Za-z0-9_-]{4,128}$/u.test(submissionId)) {
      throw new Error("Expected an OpenReview submission ID, not a URL");
    }
    const options = { redirect: "error" as const, signal: AbortSignal.timeout(60_000) };
    const response = await fetchImpl(
      `https://api2.openreview.net/notes?id=${encodeURIComponent(submissionId)}`,
      options,
    );
    const body = record(
      JSON.parse(Buffer.from(await boundedBody(response, MAX_JSON_BYTES)).toString()),
    );
    const notes = body.notes;
    if (!Array.isArray(notes) || notes.length !== 1) {
      throw new Error("OpenReview submission is not publicly readable");
    }
    const note = record(notes[0]);
    if (note.id !== submissionId) {
      throw new Error("OpenReview returned a different submission");
    }
    const content = record(note.content);
    const title = field(content.title);
    if (!title || !content.pdf) {
      throw new Error("Public submission has no title or PDF");
    }
    // Never fetch a URL supplied in a paper's metadata (SSRF and credential-leak boundary).
    const pdfResponse = await fetchImpl(
      `https://api2.openreview.net/pdf?id=${encodeURIComponent(submissionId)}`,
      { redirect: "error", signal: AbortSignal.timeout(60_000) },
    );
    const bytes = await boundedBody(pdfResponse, MAX_PDF_BYTES);
    if (Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") {
      throw new Error("OpenReview did not return a PDF");
    }
    return { submission_id: submissionId, title, bytes };
  };
}

/** Maps only documented citation-existence judgments, never AI-authorship scores. */
export function parseGptZeroBibliography(value: unknown): ReferenceScanResult {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Expected one GPTZero scan result");
  }
  const scan = record(value[0]);
  if (
    !text(scan.id) ||
    !Number.isInteger(scan.version) ||
    !Array.isArray(scan.bibliographic_citations)
  ) {
    throw new Error("Invalid GPTZero bibliography response");
  }
  const result: ReferenceScanResult = {
    provider_scan_id: text(scan.id),
    response_version: scan.version as number,
    citation_count: scan.bibliographic_citations.length,
    uncertain_count: 0,
    findings: [],
  };
  for (const entry of scan.bibliographic_citations) {
    const citation = record(entry);
    if (!text(citation.text)) {
      throw new Error("GPTZero citation is missing its text");
    }
    if (citation.citation_exists === null) {
      result.uncertain_count++;
      continue;
    }
    const assessment = record(citation.citation_exists);
    if (assessment.status === "fake" || assessment.status === "exist_with_issues") {
      result.findings.push({
        citation: text(citation.text),
        status: assessment.status,
        explanation: text(assessment.hallucination_explanation) || text(assessment.justification),
      });
    } else if (assessment.status === "unsure" || assessment.status === "unknown") {
      result.uncertain_count++;
    } else if (assessment.status !== "exist") {
      throw new Error("Unrecognized GPTZero citation status");
    }
  }
  return result;
}

export function createGptZeroBibliographyScanner(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl = globalThis.fetch,
) {
  const apiKey = env.GPTZERO_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }
  return async (bytes: Uint8Array): Promise<ReferenceScanResult> => {
    const form = new FormData();
    form.append(
      "files",
      new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
      "paper.pdf",
    );
    const response = await fetchImpl("https://api.gptzero.me/v2/bibliography-scan/files", {
      method: "POST",
      headers: { "x-api-key": apiKey, Accept: "application/json" },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(180_000),
    });
    return parseGptZeroBibliography(
      JSON.parse(Buffer.from(await boundedBody(response, MAX_JSON_BYTES)).toString()),
    );
  };
}

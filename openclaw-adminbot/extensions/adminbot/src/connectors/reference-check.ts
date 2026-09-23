import { createEngine } from "clawpdf";
import {
  findReferencesSection,
  splitIntoReferences,
} from "../third-party/references-validation/pdf-extract-service.js";
import { parseGeneric } from "../third-party/references-validation/plain-text-parser.js";
import { checkWithFallback } from "../third-party/references-validation/search-service.js";
import { lookupContext } from "./reference-check.http.js";

export type ReferenceFinding = {
  citation: string;
  status: "matched" | "review" | "not_found" | "unavailable";
  explanation: string;
  source?: string;
  title?: string;
  url?: string;
  /** Set on an unsplittable chunk: its length, from which the sweep estimates hidden entries. */
  oversized_chars?: number;
};
export type ReferenceReport = { findings: ReferenceFinding[] };
export type ReferenceProgress = { completed: number; total: number; finding?: ReferenceFinding };
export type PdfReferenceChecker = (
  pdf: Uint8Array,
  signal: AbortSignal,
  onProgress?: (progress: ReferenceProgress) => void,
) => Promise<ReferenceReport>;

export class ReferenceCheckError extends Error {}

/** An entry this long is several references the splitter could not separate. */
export const OVERSIZED_REFERENCE = 2000;

const REQUIRED_DATABASES = new Set(["api.crossref.org", "api.openalex.org", "dblp.org"]);

export async function extractPdfReferences(
  pdf: Uint8Array,
  limits: { maxReferences?: number; allowOversized?: boolean } = {},
): Promise<string[]> {
  const maxReferences = limits.maxReferences ?? 100;
  const engine = await createEngine();
  try {
    const document = await engine.open(pdf);
    try {
      if (document.pageCount > 200) {
        throw new ReferenceCheckError("Use a PDF with at most 200 pages.");
      }
      // clawpdf reads only the first 20 pages unless told otherwise, which silently dropped the
      // bibliography of any paper whose references run past page 20.
      const text = document.text({ maxChars: 600_001, maxPages: document.pageCount });
      if (text.length > 600_000) {
        throw new ReferenceCheckError("This PDF contains too much text to check.");
      }
      const section = findReferencesSection(text);
      // Never fall back to sending manuscript paragraphs as database search queries.
      if (!section.found) {
        throw new ReferenceCheckError(
          "No References or Bibliography heading was found. Use a text-based PDF with a reference section; scanned images are not supported.",
        );
      }
      const references = splitIntoReferences(section.sectionText);
      if (!references.length) {
        throw new ReferenceCheckError(
          "No references could be extracted. This PDF has not been verified.",
        );
      }
      if (
        !limits.allowOversized &&
        references.some((reference) => reference.length >= OVERSIZED_REFERENCE)
      ) {
        throw new ReferenceCheckError(
          "The bibliography could not be split reliably into individual references. This PDF has not been verified.",
        );
      }
      if (references.length > maxReferences) {
        throw new ReferenceCheckError(
          `This checker supports at most ${maxReferences} references per PDF.`,
        );
      }
      return references;
    } finally {
      document.destroy();
    }
  } catch (error) {
    if (error instanceof ReferenceCheckError) {
      throw error;
    }
    throw new ReferenceCheckError(
      "The PDF could not be read. Check that it is valid and not password protected.",
    );
  } finally {
    await engine.destroy();
  }
}

export function createPdfReferenceChecker(
  options: {
    extract?: typeof extractPdfReferences;
    requestIntervalMs?: number;
    fetch?: typeof globalThis.fetch;
    /** The interactive page keeps 100; the unattended OpenReview sweep allows long bibliographies. */
    maxReferences?: number;
    /** Report "not found" only when Crossref, OpenAlex and DBLP answered; else "unavailable". */
    requireAllDatabases?: boolean;
    /**
     * Check the entries that split cleanly and report an unsplittable chunk as unavailable, rather
     * than rejecting the paper. For the unattended sweep, which weighs how much went unchecked.
     */
    allowOversized?: boolean;
  } = {},
): PdfReferenceChecker {
  return async (pdf, signal, onProgress) => {
    const references = await (options.extract ?? extractPdfReferences)(pdf, {
      maxReferences: options.maxReferences,
      allowOversized: options.allowOversized,
    });
    signal.throwIfAborted();
    const findings: ReferenceFinding[] = [];
    onProgress?.({ completed: 0, total: references.length });
    const lastRequest = new Map<string, number>();
    for (const citation of references) {
      signal.throwIfAborted();
      if (citation.length >= OVERSIZED_REFERENCE) {
        // Never looked up: a query built from several run-together entries can only mislead.
        const finding: ReferenceFinding = {
          citation: `${citation.slice(0, 300)}…`,
          status: "unavailable",
          explanation:
            "This part of the bibliography could not be split into single references and was not checked.",
          oversized_chars: citation.length,
        };
        findings.push(finding);
        onProgress?.({ completed: findings.length, total: references.length, finding });
        continue;
      }
      const failures = new Set<string>();
      const available = new Set<string>();
      const parsed = parseGeneric(citation);
      const result = await lookupContext.run(
        {
          signal,
          failures,
          available,
          lastRequest,
          requestIntervalMs: options.requestIntervalMs,
          fetch: options.fetch ?? globalThis.fetch,
        },
        () =>
          checkWithFallback(parsed.title || citation, parsed.title ? parsed : undefined, citation),
      );
      signal.throwIfAborted();
      const matched =
        available.size > 0 &&
        result.exists &&
        result.matchConfidence >= 80 &&
        !result.retracted &&
        !result.issues.length;
      // A rate-limited database may hold the work; with requireAllDatabases, "not found" is only
      // claimed once the broad-coverage databases answered. Semantic Scholar and arXiv throttle
      // anonymous clients constantly, so requiring them would mean never reporting anything.
      const incomplete =
        options.requireAllDatabases === true &&
        [...failures].some((source) => REQUIRED_DATABASES.has(source));
      const status =
        !available.size || (incomplete && !matched && !result.exists)
          ? "unavailable"
          : matched
            ? "matched"
            : result.exists
              ? "review"
              : "not_found";
      const explanations = [
        matched
          ? "A matching record was found. This does not verify the paper’s claims."
          : status === "unavailable"
            ? available.size
              ? "No match in the databases that answered, but not every database could be reached, so this was not fully checked."
              : "No reference databases could be reached. Try again later or search Google Scholar."
            : status === "not_found"
              ? "No matching reference found in the available databases."
              : "The best matching record needs manual review.",
        ...(available.size && result.exists ? result.issues : []),
        ...(result.retracted ? ["The database marks this work as retracted."] : []),
      ];
      const safeUrl = result.url && /^https?:\/\//i.test(result.url) ? result.url : undefined;
      const finding: ReferenceFinding = {
        citation,
        status,
        explanation: explanations.join(" "),
        ...(available.size && result.source !== "NotFound"
          ? { source: result.source, title: result.title }
          : {}),
        ...(available.size && safeUrl ? { url: safeUrl } : {}),
      };
      findings.push(finding);
      onProgress?.({ completed: findings.length, total: references.length, finding });
    }
    return { findings };
  };
}

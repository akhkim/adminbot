import { createEngine } from "clawpdf";
import { resolveAdminBotDriveAccount } from "../contracts/actions.js";
import {
  condenseAuthorRuns,
  findReferencesSection,
  splitIntoReferences,
  stripLineNumbers,
} from "../third-party/references-validation/pdf-extract-service.js";
import { parseGeneric } from "../third-party/references-validation/plain-text-parser.js";
import { checkWithFallback } from "../third-party/references-validation/search-service.js";
import {
  BROAD_INDEX_SOURCES,
  lookupContext,
  referenceUserAgent,
  REQUIRED_SOURCE,
  sourceCooldownUntil,
} from "./reference-check.http.js";

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
export type PdfReferenceCheckOptions = {
  /**
   * Findings already settled for exact citation strings, used instead of a lookup. The sweep passes
   * what an earlier, partial try of the same PDF resolved, so each retry only asks about what is
   * still open: progress made against rate-limited databases is kept rather than redone.
   */
  known?: ReadonlyMap<string, ReferenceFinding>;
};
export type PdfReferenceChecker = (
  pdf: Uint8Array,
  signal: AbortSignal,
  onProgress?: (progress: ReferenceProgress) => void,
  options?: PdfReferenceCheckOptions,
) => Promise<ReferenceReport>;

export class ReferenceCheckError extends Error {}

/** Typically a placeholder upload before the full paper is due, or a scanned image. */
export const NO_TEXT_LAYER =
  "This PDF has no text to read: it is a placeholder or a scanned image.";

/** An entry this long is several references the splitter could not separate. */
export const OVERSIZED_REFERENCE = 2000;

// A "not found" needs Crossref (journals, the ACL Anthology) and at least one broad fuzzy-search
// index -- DBLP, OpenAlex or Semantic Scholar -- to have answered. Any one is enough because none is
// dependable alone: DBLP now walls off API clients entirely, OpenAlex allows an anonymous IP a tiny
// daily budget, and Semantic Scholar throttles constantly. arXiv is never required: it holds only
// preprints. DBLP's SPARQL endpoint never counts as answering "no" (see searchDblpViaSparql).
/** When the databases a "not found" depends on can next be asked; undefined if they can now. */
export function requiredDatabasesPausedUntil(
  cooldowns: Map<string, number>,
  now = Date.now(),
): number | undefined {
  // Per source, not per host: DBLP is paused only when every one of its hosts is. The broad
  // indexes are paused only when all of them are, since any one of them answering is enough.
  const until = Math.max(
    sourceCooldownUntil(cooldowns, REQUIRED_SOURCE),
    Math.min(...BROAD_INDEX_SOURCES.map((source) => sourceCooldownUntil(cooldowns, source))),
  );
  return until > now ? until : undefined;
}

/** Whether a lookup heard enough to stand behind a "not found" (see requiredDatabasesPausedUntil). */
export function enoughDatabasesAnswered(failures: Set<string>, available: Set<string>): boolean {
  return (
    !failures.has(REQUIRED_SOURCE) &&
    BROAD_INDEX_SOURCES.some((source) => available.has(source) && !failures.has(source))
  );
}

/** A finding that came from databases answering, as opposed to one left open. */
export function isSettledFinding(finding: ReferenceFinding): boolean {
  return finding.status !== "unavailable" && !finding.oversized_chars;
}

// Informational, not a discrepancy: ML papers are routinely cited from arXiv alone.
const INFORMATIONAL_ISSUE = /^Found in arXiv \(not indexed/;

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
      if (!text.trim()) {
        throw new ReferenceCheckError(NO_TEXT_LAYER);
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

/**
 * The paper's own prose: everything before the last References heading, with review-mode line
 * numbers stripped, capped at `maxChars`.
 *
 * A paper with no References heading is returned in full rather than refused: unlike a citation
 * lookup, a stray paragraph here cannot turn into a misleading database query.
 */
export async function extractPdfMainText(
  pdf: Uint8Array,
  limits: { maxChars?: number } = {},
): Promise<string> {
  return readPdfText(pdf, mainTextBeforeReferences, limits.maxChars ?? 60_000);
}

/**
 * The whole document -- bibliography and appendix included -- with review-mode line numbers
 * stripped, capped at `maxChars`. For the AI-text score: Pangram's website scores an uploaded
 * paper end to end, and a score of the main body alone missed what the website flags. Scored with
 * Pangram 4 this text matches the website (82% against 82% on one ICLR submission).
 */
export async function extractPdfFullText(
  pdf: Uint8Array,
  limits: { maxChars?: number } = {},
): Promise<string> {
  return readPdfText(pdf, wholeDocumentText, limits.maxChars ?? 600_000);
}

async function readPdfText(
  pdf: Uint8Array,
  shape: (text: string) => string,
  maxChars: number,
): Promise<string> {
  const engine = await createEngine();
  try {
    const document = await engine.open(pdf);
    try {
      if (document.pageCount > 200) {
        throw new ReferenceCheckError("Use a PDF with at most 200 pages.");
      }
      const text = document.text({ maxChars: 600_001, maxPages: document.pageCount });
      if (!text.trim()) {
        throw new ReferenceCheckError(NO_TEXT_LAYER);
      }
      return shape(text).slice(0, maxChars);
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

/** Exported for tests; see extractPdfFullText. */
export function wholeDocumentText(text: string): string {
  return stripLineNumbers(text.replace(/---\s*PAGE BREAK\s*---/g, "\n"))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Exported for tests; see extractPdfMainText. */
export function mainTextBeforeReferences(text: string): string {
  // The same cleaning findReferencesSection applies, so the heading it reports is found here.
  const clean = stripLineNumbers(text.replace(/---\s*PAGE BREAK\s*---/g, "\n"));
  const section = findReferencesSection(text);
  const lines = clean.split("\n");
  const heading = section.found
    ? lines.findLastIndex((line) => line.trim() === section.headingMatch)
    : -1;
  return (heading > 0 ? lines.slice(0, heading) : lines)
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Looks up references already split into single citation strings, one at a time, in order. */
export type ReferenceListChecker = (
  references: readonly string[],
  signal: AbortSignal,
  onProgress?: (progress: ReferenceProgress) => void,
  options?: PdfReferenceCheckOptions,
) => Promise<ReferenceReport>;

export type ReferenceCheckerOptions = {
  requestIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
  /** The interactive page keeps 100; the unattended OpenReview sweep allows long bibliographies. */
  maxReferences?: number;
  /** Report "not found" only when Crossref and DBLP answered; otherwise "unavailable". */
  requireAllDatabases?: boolean;
  /** See LookupContext.maxCooldownWaitMs: wait out a required database's short back-off. */
  maxCooldownWaitMs?: number;
  /** The contact in the User-Agent; defaults to the bot mailbox (ADMINBOT_BOT_EMAIL). */
  contactEmail?: string;
  /**
   * Check the entries that split cleanly and report an unsplittable chunk as unavailable, rather
   * than rejecting the paper. For the unattended sweep, which weighs how much went unchecked.
   */
  allowOversized?: boolean;
  openAlexApiKey?: string;
  /** Shared back-off state; see LookupContext.cooldowns. */
  cooldowns?: Map<string, number>;
};

/**
 * A checker for a PDF: its bibliography is read out of the PDF's text and split into references,
 * then each is looked up (createReferenceListChecker).
 */
export function createPdfReferenceChecker(
  options: ReferenceCheckerOptions & { extract?: typeof extractPdfReferences } = {},
): PdfReferenceChecker {
  const checkList = createReferenceListChecker(options);
  return async (pdf, signal, onProgress, checkOptions) => {
    const references = await (options.extract ?? extractPdfReferences)(pdf, {
      maxReferences: options.maxReferences,
      allowOversized: options.allowOversized,
    });
    signal.throwIfAborted();
    return checkList(references, signal, onProgress, checkOptions);
  };
}

/**
 * A checker for references that are already single entries -- rendered from a paper's own .bib, so
 * nothing had to be split out of PDF text. The same lookups and verdicts as a PDF's references.
 */
export function createReferenceListChecker(
  options: ReferenceCheckerOptions = {},
): ReferenceListChecker {
  const userAgent = referenceUserAgent(options.contactEmail ?? resolveAdminBotDriveAccount());
  return async (references, signal, onProgress, checkOptions) => {
    const maxReferences = options.maxReferences ?? 100;
    if (references.length > maxReferences) {
      throw new ReferenceCheckError(
        `This checker supports at most ${maxReferences} references per paper.`,
      );
    }
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
          // Sized by entries, not names: a 300-author team report is one entry.
          oversized_chars: condenseAuthorRuns(citation).length,
        };
        findings.push(finding);
        onProgress?.({ completed: findings.length, total: references.length, finding });
        continue;
      }
      const known = checkOptions?.known?.get(citation);
      if (known && known.citation === citation && isSettledFinding(known)) {
        const finding = { ...known };
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
          ...(options.openAlexApiKey ? { openAlexApiKey: options.openAlexApiKey } : {}),
          ...(options.cooldowns ? { cooldowns: options.cooldowns } : {}),
          ...(options.maxCooldownWaitMs ? { maxCooldownWaitMs: options.maxCooldownWaitMs } : {}),
          userAgent,
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
        !result.issues.some((issue) => !INFORMATIONAL_ISSUE.test(issue));
      // A rate-limited database may hold the work; with requireAllDatabases, "not found" is only
      // claimed once Crossref and at least one broad-coverage index answered.
      const incomplete =
        options.requireAllDatabases === true && !enoughDatabasesAnswered(failures, available);
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

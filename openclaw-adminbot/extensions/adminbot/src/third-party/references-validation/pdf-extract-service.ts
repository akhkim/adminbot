// Adapted from References-Validation; see NOTICE.md and LICENSE.
/**
 * PDF/DOCX Text Extraction & Reference Section Detection Service
 *
 * Extracts text from uploaded PDF/DOCX files, finds the References section,
 * and returns individual reference strings ready for batch checking.
 */

// ===== REFERENCE SECTION HEADINGS =====
// Matches headings in multiple languages and formats
const REFERENCE_HEADINGS = [
  // English
  "references",
  "bibliography",
  "literature",
  "works cited",
  "cited literature",
  "literature cited",
  "citations",
  "reference list",
  "works referenced",
  // Italian
  "riferimenti",
  "riferimenti bibliografici",
  "bibliografia",
  // Spanish
  "bibliografía",
  "referencias",
  "referencias bibliográficas",
  // Portuguese
  "referências",
  "referências bibliográficas",
  // French
  "bibliographie",
  "références",
  "références bibliographiques",
  // German
  "literaturverzeichnis",
  "literatur",
  "quellenverzeichnis",
  "quellen",
  // Chinese/Japanese (romanized for regex)
  "cankao wenxian", // 参考文献
];

// Build a regex that matches any of these headings as a line heading
// Handles: "References", "REFERENCES", "8. References", "VIII. References", "References:", etc.
const buildHeadingRegex = (): RegExp => {
  const headingAlts = REFERENCE_HEADINGS.join("|");
  // Match optional numbering (1., VIII., etc.) + heading + optional punctuation and trailing page numbers
  return new RegExp(`^\\s*(?:[0-9IVXLC]+[.\\s)]+)?\\s*(${headingAlts})\\s*[:\\s\\d.\\-]*$`, "im");
};

const HEADING_REGEX = buildHeadingRegex();

// Headings that signal the END of the references section
const END_SECTION_HEADINGS = [
  "appendix",
  "appendices",
  "supplementary",
  "supplementary material",
  "supplementary materials",
  "supporting information",
  "acknowledgment",
  "acknowledgments",
  "acknowledgement",
  "acknowledgements",
  "about the author",
  "about the authors",
  "author contributions",
  "author biography",
  "biographies",
  "vita",
  "curriculum vitae",
  "conflict of interest",
  "conflicts of interest",
  "declaration",
  "funding",
  "data availability",
  "ethics statement",
  "annexe",
  "annexes",
  "anhang",
  "ringraziamenti",
  "agradecimientos",
];

const buildEndSectionRegex = (): RegExp => {
  const alts = END_SECTION_HEADINGS.join("|");
  return new RegExp(`^\\s*(?:[0-9A-Z]+[.\\s)]+)?\\s*(${alts})(?=\\s|:|$)`, "im");
};

const END_SECTION_REGEX = buildEndSectionRegex();

/**
 * Find the References section in extracted text
 * Returns the text of just the references section, or null if not found
 */
export const findReferencesSection = (
  text: string,
): { found: boolean; sectionText: string; headingMatch: string } => {
  // Remove page break markers for section detection
  const cleanText = text.replace(/---\s*PAGE BREAK\s*---/g, "\n");

  // Find ALL occurrences of reference headings, take the LAST one
  // (papers often mention "References" in the introduction/body too)
  const lines = cleanText.split("\n");
  let lastHeadingIdx = -1;
  let lastHeadingMatch = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (HEADING_REGEX.test(line)) {
      lastHeadingIdx = i;
      lastHeadingMatch = line;
    }
  }

  if (lastHeadingIdx === -1) {
    // No heading found — return all text as fallback
    // (user will see a warning and can review)
    return {
      found: false,
      sectionText: cleanText,
      headingMatch: "",
    };
  }

  // Take everything after the heading
  const afterHeading = lines.slice(lastHeadingIdx + 1);

  // Find where the references section ends (next major heading)
  let endIdx = afterHeading.length;
  for (let i = 0; i < afterHeading.length; i++) {
    const line = afterHeading[i].trim();
    if (END_SECTION_REGEX.test(line)) {
      endIdx = i;
      break;
    }
  }

  const sectionLines = afterHeading.slice(0, endIdx);

  return {
    found: true,
    sectionText: sectionLines.join("\n"),
    headingMatch: lastHeadingMatch,
  };
};

/**
 * Clean extracted reference text from PDF artifacts
 * - Remove page numbers, headers/footers
 * - Join broken lines within a single reference
 * - Remove empty lines between parts of the same reference
 */
export const cleanExtractedText = (text: string): string => {
  const cleaned = text
    // Remove standalone page numbers
    .replace(/^\s*\d{1,4}\s*$/gm, "")
    // Remove common header/footer patterns
    .replace(
      /^\s*(Downloaded from|Copyright ©|All rights reserved|Published by|doi:|DOI:).+$/gim,
      "",
    )
    // Remove URLs that are standalone (not part of a reference)
    .replace(/^\s*https?:\/\/\S+\s*$/gm, "")
    .replace(/^Under review as a conference paper.*$/gim, "")
    // Collapse multiple blank lines into one
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned;
};

/**
 * Split reference section text into individual references
 * Handles numbered ([1], 1., (1)) and unnumbered (APA paragraph) styles
 */
export const splitIntoReferences = (sectionText: string): string[] => {
  const cleaned = cleanExtractedText(sectionText);
  if (!cleaned) {
    return [];
  }

  const lines = cleaned.split("\n");
  const refs: string[] = [];

  // Detect if references are numbered
  // A year on its own line or a volume number is not a citation label.
  const numberedPattern = /^\s*(?:\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}[.)])\s+\S/;
  const hasNumbering = lines.filter((l) => numberedPattern.test(l)).length >= 2;

  if (hasNumbering) {
    // Numbered references: split on number markers
    let currentRef = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      if (numberedPattern.test(trimmed)) {
        // New reference starts
        if (currentRef.trim()) {
          refs.push(currentRef.trim());
        }
        currentRef = trimmed;
      } else {
        // Continuation of current reference
        currentRef += " " + trimmed;
      }
    }
    if (currentRef.trim()) {
      refs.push(currentRef.trim());
    }
  } else {
    // Unnumbered (APA/paragraph style): split on blank lines or detect
    // references by looking for year patterns at line starts
    let currentRef = "";
    let prevLineEmpty = true;

    // Pattern: Capital letter, up to 250 characters, then (YYYY) or (YYYYa)
    const apaStartPattern = /^[A-Z\u00C0-\u024F].{0,250}?\(\d{4}[a-z]?\)/;

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        // Blank line — might separate references
        if (currentRef.trim()) {
          refs.push(currentRef.trim());
          currentRef = "";
        }
        prevLineEmpty = true;
        continue;
      }

      // Heuristic 1: After a blank line, starting with a capital letter
      const looksLikeNewRefAfterBlank = prevLineEmpty && /^[A-Z\u00C0-\u024F]/.test(trimmed);

      // Heuristic 2: Line starts with typical APA author+year pattern AND previous line ended with punctuation
      const endsWithPunctuation = /[.\d)\]>]$/.test(currentRef.trim());
      const looksLikeNewRefPattern = endsWithPunctuation && apaStartPattern.test(trimmed);

      // Conference bibliographies commonly place the year at the end without parentheses.
      const previousEndsInYear = /\b(?:19|20)\d{2}[a-z]?[.)]?\s*$/.test(currentRef);
      const startsWithAuthor =
        /^[\p{Lu}][\p{L}'’-]+(?:,\s*|\s+)[\p{Lu}][\p{L}'’.-]*(?:\s|,|\.)/u.test(trimmed);
      const looksLikeYearEndReference = previousEndsInYear && startsWithAuthor;
      if (
        (looksLikeNewRefAfterBlank || looksLikeNewRefPattern || looksLikeYearEndReference) &&
        currentRef.trim()
      ) {
        refs.push(currentRef.trim());
        currentRef = trimmed;
      } else {
        currentRef += (currentRef ? " " : "") + trimmed;
      }

      prevLineEmpty = false;
    }
    if (currentRef.trim()) {
      refs.push(currentRef.trim());
    }
  }

  // Keep oversized entries so the caller can reject extraction instead of silently omitting them.
  return refs.filter((r) => r.length > 15);
};

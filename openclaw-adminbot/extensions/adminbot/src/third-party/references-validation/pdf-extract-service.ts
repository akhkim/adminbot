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
  "ethical considerations",
  "limitations",
  "broader impact",
  "broader impacts",
  "impact statement",
  "checklist",
  "paper checklist",
  "neurips paper checklist",
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

// A lettered appendix heading ("A Additional Results", "C.2 REACT OBTAINS…", "A Multi-armed
// bandit problem"): a letter, then up to ten words with no sentence punctuation.
const APPENDIX_HEADING = /^[A-H](?:\.\d{1,2})*\.?\s+[\p{Lu}\d][^.?!;]{2,90}$/u;
// "Wei Chen, Ann" / "Wei Chen and Ann" / "[AB+21] Name," -- how a bibliography entry, not appendix
// prose, begins.
const REFERENCE_START =
  /^(?:\[[^\]]{1,20}\]\s*)?[\p{Lu}][\p{L}'’.-]*(?:\s[\p{Lu}][\p{L}'’.-]*){0,3}(?:,\s*|\sand\s)[\p{Lu}]/u;
// A wrapped reference title can look like a heading ("A Survey of Large"); a real appendix is
// followed by prose, not by more bibliography entries.
const endsReferences = (lines: string[], i: number): boolean => {
  const line = lines[i].trim();
  if (END_SECTION_REGEX.test(line) || (line.split(/\s+/).length <= 8 && /checklist$/i.test(line))) {
    return true;
  }
  if (i <= 10 || line.split(/\s+/).length > 11 || !APPENDIX_HEADING.test(line)) {
    return false;
  }
  const following = lines.slice(i + 1, i + 41).map((next) => next.trim());
  return following.filter((next) => REFERENCE_START.test(next)).length < 3;
};

/**
 * Review-mode submissions (ARR, NeurIPS, ICML) number every line in the margin, and PDFium emits
 * the number at the start or end of the line -- or right after a hyphenation mark. Left in, it
 * breaks every entry boundary. Stripped only when most lines carry one, so a camera-ready paper
 * whose lines happen to end in page ranges is left alone.
 */
export const stripLineNumbers = (text: string): string => {
  const lines = text.replace(/\r/g, "").split("\n");
  const filled = lines.filter((line) => line.trim());
  const leading = filled.filter((line) => /^\s*\d{1,4}\s+\S/.test(line)).length;
  const trailing = filled.filter((line) => /\S\s+\d{1,4}\s*$/.test(line)).length;
  // ARR numbers the left column on the left and the right column on the right.
  if (leading + trailing < filled.length * 0.4) {
    return text;
  }
  const stripLeading = leading >= filled.length * 0.15;
  const stripTrailing = trailing >= filled.length * 0.15;
  return lines
    .map((line) => (stripLeading ? line.replace(/^\s*\d{1,4}\s+/, "") : line))
    .map((line) => (stripTrailing ? line.replace(/\s+\d{1,4}\s*$/, "") : line))
    .join("\n")
    .replace(/\uFFFE\s*\d{1,4}\s+/g, "\uFFFE");
};

/**
 * Find the References section in extracted text
 * Returns the text of just the references section, or null if not found
 */
export const findReferencesSection = (
  text: string,
): { found: boolean; sectionText: string; headingMatch: string } => {
  // Remove page break markers for section detection
  const cleanText = stripLineNumbers(text.replace(/---\s*PAGE BREAK\s*---/g, "\n"));

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
    if (endsReferences(afterHeading, i)) {
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
  // PDFium marks a line-break hyphen with U+FFFE ("lan\uFFFEguage") and ends lines with \r\n.
  // A plain hyphen at a line end followed by lowercase is a word or name broken across lines
  // ("Kris-\ntina"); left split, the name no longer reads as a name.
  const cleaned = cleanExtractedText(
    sectionText
      .replace(/\r/g, "")
      .replace(/\uFFFE\s*/g, "")
      .replace(/-[ \t]*\n[ \t]*(?=\p{Ll})/gu, "-"),
  );
  if (!cleaned) {
    return [];
  }

  const ALPHA_LABEL = /\[\p{L}[\p{L}+\-. ]{0,15}\d{2,4}[a-z]?\]/u;
  // PDFium wraps alphabetic labels ("[CCE+\n18]") and runs entries together ("2019. [CCE+ 18]").
  const lines = (
    ALPHA_LABEL.test(cleaned.trimStart().slice(0, 25))
      ? cleaned
          .replace(/(\[\p{L}[\p{L}+\-. ]{0,15})\n(\d{2,4}[a-z]?\])/gu, "$1 $2")
          .replace(/([.\d]\s+)(\[\p{L}[\p{L}+\-. ]{0,15}\d{2,4}[a-z]?\]\s)/gu, "$1\n$2")
      : cleaned
  ).split("\n");
  const refs: string[] = [];

  // Detect if references are numbered
  // A year on its own line or a volume number is not a citation label.
  // Alphabetic labels ("[AON+ 21]", "[Vas17a]") number a bibliography just as well.
  const numberedPattern =
    /^\s*(?:(?:\[\d{1,3}\]|\[\p{L}[\p{L}+\-. ]{0,15}\d{2,4}[a-z]?\]|\(\d{1,3}\))\s*|\d{1,3}[.)]\s+)\S/u;
  // A bibliography that is numbered starts with its first label; numbered lists in trailing text
  // (an appendix, a checklist) must not switch an author-year bibliography to label splitting.
  const firstLine = lines.find((l) => l.trim()) ?? "";
  const hasNumbering =
    numberedPattern.test(firstLine) && lines.filter((l) => numberedPattern.test(l)).length >= 2;

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
    // ACL/NeurIPS author-year bibliographies have neither labels nor blank lines, and the year
    // follows the authors, so the heuristics above ran whole pages together.
    const authorYear = splitAuthorYear(lines);
    if (authorYear.length > refs.length) {
      refs.splice(0, refs.length, ...authorYear);
    }
  }

  // Keep oversized entries so the caller can reject extraction instead of silently omitting them.
  return capTrailingReference(refs.filter((r) => r.length > 15).map(condenseAuthors));
};

// An author between commas: short, and without the run of lowercase words a title fragment has.
// Deliberately loose -- PDFium splits accented capitals ("´ Aaaaaa"), and lists hold particles and
// organizations -- because a false run only shortens the author list, never the title.
const isAuthorToken = (token: string): boolean =>
  token.length <= 40 && !/\p{Ll}{4,}\s+\p{Ll}{2,}/u.test(token.replace(/^and\s+/, ""));

const condenseAuthors = (ref: string): string => {
  const tokens = ref.split(", ");
  let run = 0;
  while (run < tokens.length && isAuthorToken(tokens[run].replace(/^\[[^\]]{1,20}\]\s*/, ""))) {
    run++;
  }
  if (run <= 12) {
    return ref;
  }
  // "Last, F., …, and Omega, O. Title" leaves the last author's initials on the title.
  const rest = tokens
    .slice(run)
    .join(", ")
    .replace(/^(?:and\s+)?(?:\p{Lu}\.[\s-]?)+\s*/u, "");
  return `${tokens.slice(0, 3).join(", ")}, et al. ${rest}`;
};

const YEAR = /\b(?:19|20)\d{2}[a-z]?\b/;
const NAME_PARTICLE = /^(?:van|von|der|den|de|del|della|di|da|dos|du|la|le|al|bin|ibn|et|al\.)$/;

/** "Jacob Devlin, Ming-Wei Chang, and Kristina Toutanova" -- nothing but capitalized names. */
const isNameList = (text: string): boolean => {
  const parts = text
    .replace(/\bet al\.?/g, "")
    .replace(/[.(]\s*$/, "")
    .split(/,|;|&|\band\b/)
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    parts.length > 0 &&
    text.length <= 2000 &&
    parts.every((part) =>
      part
        .split(/\s+/)
        .every((word) => /^[\p{Lu}][\p{L}'’.-]*$/u.test(word) || NAME_PARTICLE.test(word)),
    )
  );
};

/**
 * Starts a reference at a line only when the reference so far already has a year followed by a
 * title, the previous line ended a sentence, and the text from this line to its own first year
 * is a list of names. Continuation lines ("In EMNLP. Association for…", "The fifth PASCAL…")
 * fail the last test because venues and titles carry lowercase words.
 */
const splitAuthorYear = (lines: string[]): string[] => {
  const trimmed = lines.map((line) => line.trim()).filter(Boolean);
  const refs: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i++) {
    const line = trimmed[i];
    const year = YEAR.exec(current);
    // An entry ends in a period, a URL, or ICLR/NeurIPS back-references to citing pages ("… 2022. 1, 6").
    // A trailing initial ("Andrew N.") is a wrapped author list, not the end of an entry.
    const endsEntry =
      // "URL"/"doi:" whose link line the cleaner removed also end one.
      /(?:[.)\]]|\.\s*\d{1,3}(?:,\s*\d{1,3})*|https?:\S+|\bURL|\bdoi:)$/.test(current) &&
      !/(?:^|[\s,])\p{Lu}\.$/u.test(current);
    if (current && year && current.length > 40 && endsEntry) {
      // Twenty-author lists run eight lines before their year.
      const ahead = trimmed.slice(i, i + 12).join(" ");
      // ACL: "Names. 2019. Title." -- the names run up to the next year.
      const hasTitle = current.slice(year.index + year[0].length).trim().length > 10;
      const nextYear = YEAR.exec(ahead);
      const actStyle =
        hasTitle &&
        nextYear !== null &&
        nextYear.index > 1 &&
        isNameList(ahead.slice(0, nextYear.index));
      // NeurIPS/ICLR/ICML: "M. G. Bellemare and J. Veness. Title." or "Bellemare, M. G. and
      // Veness, J. Title." -- some sentence end leaves nothing but a list of names before it.
      const titleFirstStyle = [...ahead.slice(0, 2000).matchAll(/\.\s/g)].some((end) => {
        const names = ahead.slice(0, end.index + 1);
        return /,|\band\b/.test(names) && isNameList(names);
      });
      // Still inside an author list at the end of the window: nothing but names so far.
      const longAuthorList =
        (ahead.match(/,/g)?.length ?? 0) >= 6 && isNameList(ahead.slice(0, ahead.lastIndexOf(",")));
      if (actStyle || titleFirstStyle || longAuthorList) {
        refs.push(current);
        current = line;
        continue;
      }
    }
    current += (current ? " " : "") + line;
  }
  if (current) {
    refs.push(current);
  }
  return refs;
};

/**
 * Nothing reliably marks where a bibliography stops when an unlabeled appendix follows it, so the
 * last entry swallowed the appendix and failed the whole paper. It is cut back to the first
 * sentence end past three-quarters of a typical entry, and never beyond twice the longest other.
 */
const capTrailingReference = (refs: string[]): string[] => {
  if (refs.length < 5) {
    return refs;
  }
  const others = refs.slice(0, -1).map((ref) => ref.length);
  const last = refs[refs.length - 1];
  const longest = Math.max(...others);
  if (last.length <= longest * 1.5 || longest >= 2000) {
    return refs;
  }
  const typical = others.toSorted((a, b) => a - b)[Math.floor(others.length / 2)];
  const limit = Math.min(last.length, longest * 2);
  const end = last.indexOf(". ", Math.floor(typical * 0.75));
  const cut = end > 0 && end < limit ? end + 1 : limit;
  return [...refs.slice(0, -1), last.slice(0, cut).trim()];
};

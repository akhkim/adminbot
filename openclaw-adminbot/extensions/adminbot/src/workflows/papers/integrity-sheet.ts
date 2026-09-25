// Writes each ICLR submission's Pangram score into the lab's paper-tracking sheet.
//
// The sheet is the lab's own list, typed by people: its titles are often working titles ("When
// scaling interaction at test time breaks llm cooperation" is the submission "Fool Me Once:
// Scaling Interaction Reveals How LLMs Adapt to and Exploit One Another"), and its author lists
// are however somebody wrote them. So a row is matched on its title first and, only for the
// submissions a title could not settle, on who wrote it. A submission that neither settles
// unambiguously is left unwritten and named in the digest -- a score in the wrong paper's row is
// worse than an empty cell.

import type { OpenReviewSubmission } from "../../contracts/openreview-citation-checks.js";
import type { PaperAiTextCheck } from "../../contracts/paper-integrity-checks.js";

export type SheetPaperRow = {
  /** 1-based sheet row number. */
  row: number;
  title: string;
  authors: string;
  /** What the score column holds now. */
  current: string;
  /** What the citation column holds now. */
  currentCitations: string;
};

export type SheetColumns = { title: number; authors: number; score: number; citations: number };

/** Title, Authors, score and citation columns by header, falling back to A, C, H and I. */
export function sheetColumns(header: string[]): SheetColumns {
  const find = (pattern: RegExp) => header.findIndex((cell) => pattern.test(cell.trim()));
  const title = find(/^title$/iu);
  const authors = find(/^authors?$/iu);
  const score = find(/^pangram( score)?$/iu);
  const citations = find(/^(hallucinated|fabricated|flagged) (citations?|references?)$/iu);
  return {
    title: title >= 0 ? title : 0,
    authors: authors >= 0 ? authors : 2,
    score: score >= 0 ? score : 7,
    citations: citations >= 0 ? citations : 8,
  };
}

export function sheetPaperRows(rows: string[][], columns: SheetColumns): SheetPaperRow[] {
  return rows
    .map((cells, index) => ({
      row: index + 1,
      title: (cells[columns.title] ?? "").trim(),
      authors: (cells[columns.authors] ?? "").trim(),
      current: (cells[columns.score] ?? "").trim(),
      currentCitations: (cells[columns.citations] ?? "").trim(),
    }))
    .filter((row) => row.row > 1 && row.title);
}

function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((word) => word.length > 2),
  );
}

function titleMatches(sheetTitle: string, paperTitle: string): boolean {
  const a = normalize(sheetTitle);
  const b = normalize(paperTitle);
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  // The sheet often carries just the part before the colon ("Riemannian Manifold Steering").
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.split(" ").length >= 3 && longer.startsWith(`${shorter} `)) {
    return true;
  }
  const x = tokens(sheetTitle);
  const y = tokens(paperTitle);
  const shared = [...x].filter((word) => y.has(word)).length;
  return shared / new Set([...x, ...y]).size >= 0.7;
}

/** "Yen-Shan (Lily) Chen" and "~Yen_Shan_Chen1" both become lowercase word lists. */
function nameWords(name: string): string[] {
  return normalize(name.replace(/\([^)]*\)/gu, " "))
    .split(" ")
    .filter(Boolean);
}

/**
 * The same person under two spellings: same surname, and either the same first name or every
 * word of the shorter name inside the longer ("Sekai Tully Carr" and "Ulysses Sekai Tully Carr",
 * which is how the sheet and OpenReview wrote one author).
 */
function sameName(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) {
    return false;
  }
  if (a.join(" ") === b.join(" ")) {
    return true;
  }
  if (a.length < 2 || b.length < 2 || a[a.length - 1] !== b[b.length - 1]) {
    return false;
  }
  if (a[0] === b[0]) {
    return true;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.every((word) => longer.includes(word));
}

/** The submission's author names: OpenReview's `authors`, or names read off the profile ids. */
export function submissionAuthorNames(submission: OpenReviewSubmission): string[] {
  if (submission.author_names?.length) {
    return submission.author_names;
  }
  return (submission.author_ids ?? [])
    .filter((id) => id.startsWith("~"))
    .map((id) => id.slice(1).replace(/\d+$/u, "").replace(/_/gu, " "));
}

function listedAuthors(sheetAuthors: string): string[][] {
  return sheetAuthors
    .split(/,|;|\band\b/iu)
    .map(nameWords)
    .filter((words) => words.length);
}

function sharedAuthors(listed: string[][], names: string[]): number {
  return names.filter((name) => listed.some((entry) => sameName(entry, nameWords(name)))).length;
}

/**
 * Authors on so many rows that sharing them says nothing: in the lab's sheet the PI is on 23 of 36
 * papers and one lead on 14. Counted as evidence, they matched "Where Does Reasoning Fail?" to
 * GT-HarmBench. A name on a quarter or more of the rows (and at least three) is left out.
 */
function commonAuthors(rows: SheetPaperRow[]): string[][] {
  const lists = rows.map((row) => listedAuthors(row.authors));
  const common: string[][] = [];
  for (const person of lists.flat()) {
    if (common.some((known) => sameName(known, person))) {
      continue;
    }
    const count = lists.filter((list) => list.some((entry) => sameName(entry, person))).length;
    if (count >= 3 && count >= rows.length * 0.25) {
      common.push(person);
    }
  }
  return common;
}

export type SheetMatch = {
  matched: Map<string, SheetPaperRow>;
  /** Submissions that no row, or more than one, could claim. */
  unmatched: OpenReviewSubmission[];
};

export function matchSheetRows(
  rows: SheetPaperRow[],
  submissions: OpenReviewSubmission[],
): SheetMatch {
  const matched = new Map<string, SheetPaperRow>();
  const claimed = new Set<number>();
  const pending: OpenReviewSubmission[] = [];

  // Titles first. A row two submissions both claim settles neither: that is two papers the lab
  // titled alike, and the authors decide below.
  const byTitle = new Map<string, SheetPaperRow[]>();
  for (const submission of submissions) {
    byTitle.set(
      submission.id,
      rows.filter((row) => titleMatches(row.title, submission.title)),
    );
  }
  const rowClaims = new Map<number, number>();
  for (const candidates of byTitle.values()) {
    for (const row of candidates) {
      rowClaims.set(row.row, (rowClaims.get(row.row) ?? 0) + 1);
    }
  }
  for (const submission of submissions) {
    const candidates = byTitle.get(submission.id) ?? [];
    if (candidates.length === 1 && rowClaims.get(candidates[0].row) === 1) {
      matched.set(submission.id, candidates[0]);
      claimed.add(candidates[0].row);
    } else {
      pending.push(submission);
    }
  }

  // Then authors, among the rows no title claimed, counting only the distinctive ones: at least two
  // shared (or every one, for a paper with fewer), and one row clearly ahead of the rest.
  const common = commonAuthors(rows);
  const unmatched: OpenReviewSubmission[] = [];
  for (const submission of pending) {
    const names = submissionAuthorNames(submission).filter(
      (name) => !common.some((person) => sameName(person, nameWords(name))),
    );
    const needed = Math.min(2, names.length);
    if (needed === 0) {
      unmatched.push(submission);
      continue;
    }
    const scored = rows
      .filter((row) => !claimed.has(row.row))
      .map((row) => ({ row, shared: sharedAuthors(listedAuthors(row.authors), names) }))
      .filter((entry) => entry.shared >= needed)
      .toSorted((a, b) => b.shared - a.shared);
    if (scored.length && (scored.length === 1 || scored[0].shared > scored[1].shared)) {
      matched.set(submission.id, scored[0].row);
      claimed.add(scored[0].row.row);
    } else {
      unmatched.push(submission);
    }
  }
  return { matched, unmatched };
}

/** The cell text for a score, or undefined when there is nothing to write yet. */
export function scoreCellText(check: PaperAiTextCheck | undefined): string | undefined {
  if (!check) {
    return undefined;
  }
  if (check.status === "unreadable") {
    return "No text in the PDF (placeholder?)";
  }
  if (check.status !== "completed") {
    return undefined;
  }
  const percent = (value: number | undefined) => `${Math.round((value ?? 0) * 100)}%`;
  const model =
    check.scored_from === "full_text"
      ? `Pangram ${check.model_version ?? "4"}`
      : check.scored_from === "pdf"
        ? "Pangram 3.3.2"
        : "main text only";
  return `${percent(check.fraction_ai)} AI, ${percent(check.fraction_ai_assisted)} AI-assisted (${model})`;
}

/**
 * The exact references no scholarly database has, one per line -- only from a completed check.
 * A check that could not reach enough databases ("failed") says nothing about any reference, so it
 * writes nothing; neither does a clean one, so a human note in the cell is never cleared.
 */
export function citationCellText(references: string[]): string | undefined {
  return references.length ? references.join("\n") : undefined;
}

/** A1 column letter for a 0-based index. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** A1 range for one cell of a tab, quoted so a tab name with spaces or dashes is one token. */
export function cellRange(tab: string, column: number, row: number): string {
  return `'${tab.replace(/'/gu, "''")}'!${columnLetter(column)}${row}`;
}

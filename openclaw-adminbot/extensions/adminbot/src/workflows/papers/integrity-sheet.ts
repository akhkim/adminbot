// Keeps the lab's paper sheet in step with every ICLR submission the lab has on OpenReview.
//
// One row per submission, identified by its OpenReview link in the "OpenReview" column. A
// submission with no such row gets a new entry -- title, authors, link -- written into the first
// row that is empty from end to end, so nothing a person typed is ever overwritten. Its row then
// carries the Pangram score, the references confirmed missing from every database, and the
// references the check could not confirm either way.
//
// This replaced matching sheet rows by title and then by authors. The lab keeps working titles
// that differ from what was submitted, and that matching had to guess; the lab then made room for
// one entry per submission, so a submission's row is now simply the one with its link.

import type {
  OpenReviewCitationCheck,
  OpenReviewSubmission,
} from "../../contracts/openreview-citation-checks.js";
import type { PaperAiTextCheck } from "../../contracts/paper-integrity-checks.js";

export type SheetColumns = {
  title: number;
  authors: number;
  score: number;
  citations: number;
  unconfirmed: number;
  openreview: number;
};

/** The header text written for a column the sheet does not have yet. */
export const SHEET_HEADERS = {
  score: "Pangram Score",
  citations: "Hallucinated citations",
  unconfirmed: "Unconfirmed references",
  openreview: "OpenReview",
} as const;

/**
 * Columns by header. The four the integrity sweep owns fall back to H, I, J and K; `missing`
 * names the ones whose header cell is empty, so the plan writes their headers.
 */
export function sheetColumns(header: string[]): {
  columns: SheetColumns;
  missing: Array<keyof typeof SHEET_HEADERS>;
} {
  const find = (pattern: RegExp) => header.findIndex((cell) => pattern.test((cell ?? "").trim()));
  const at = (pattern: RegExp, fallback: number) => {
    const index = find(pattern);
    return index >= 0 ? index : fallback;
  };
  const columns: SheetColumns = {
    title: at(/^title$/iu, 0),
    authors: at(/^authors?$/iu, 2),
    score: at(/^pangram( score)?$/iu, 7),
    citations: at(/^(hallucinated|fabricated|flagged) (citations?|references?)$/iu, 8),
    unconfirmed: at(/^unconfirmed (references?|citations?)$/iu, 9),
    openreview: at(/^openreview( url| link)?$/iu, 10),
  };
  const missing = (Object.keys(SHEET_HEADERS) as Array<keyof typeof SHEET_HEADERS>).filter(
    (key) => !(header[columns[key]] ?? "").trim(),
  );
  return { columns, missing };
}

export function openReviewUrl(submissionId: string): string {
  return `https://openreview.net/forum?id=${submissionId}`;
}

/** The submission id in an OpenReview link, or undefined. */
export function openReviewIdIn(cell: string): string | undefined {
  const match = /openreview\.net\/(?:forum|pdf)\?(?:[^#\s]*&)?id=([A-Za-z0-9_-]+)/u.exec(cell);
  return match?.[1];
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
 * A partial check says nothing about any single reference being fabricated, so it writes nothing.
 */
export function citationCellText(check: OpenReviewCitationCheck | undefined): string | undefined {
  if (check?.status !== "completed") {
    return undefined;
  }
  const missing = (check.findings ?? [])
    .filter((finding) => finding.status === "not_found")
    .map((finding) => finding.citation);
  return missing.length ? missing.join("\n") : undefined;
}

/**
 * Every reference the check could not confirm, by name, one per line: those no database could be
 * asked about ("could not check") and those whose closest record needs a person ("needs review").
 * From a completed or a partial check alike -- a partial one is exactly where these pile up.
 * "None" once a check has confirmed everything, so an empty cell always means "not checked yet".
 */
export function unconfirmedCellText(
  check: OpenReviewCitationCheck | undefined,
): string | undefined {
  if (!check?.findings || (check.status !== "completed" && check.status !== "failed")) {
    return undefined;
  }
  const lines = check.findings.flatMap((finding) =>
    finding.status === "unavailable"
      ? [`could not check: ${finding.citation}`]
      : finding.status === "review"
        ? [`needs review: ${finding.citation}`]
        : [],
  );
  if (lines.length) {
    return lines.join("\n");
  }
  return check.status === "completed" ? "None" : undefined;
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

export type SheetEntry = {
  submission: OpenReviewSubmission;
  score?: string;
  citations?: string;
  unconfirmed?: string;
};

export type SheetPlan = {
  updates: Array<{ range: string; values: string[][] }>;
  /** Column letters the updates touch, for the executor's allow-list. */
  columns: string[];
  added: string[];
};

/**
 * Every cell write that brings the sheet in step with `entries`: missing headers, a new entry for
 * each submission without a row, and the three result columns wherever they changed.
 */
export function planSheet(grid: string[][], tab: string, entries: SheetEntry[]): SheetPlan {
  const { columns, missing } = sheetColumns(grid[0] ?? []);
  const updates: SheetPlan["updates"] = [];
  const touched = new Set<number>();
  const write = (column: number, row: number, value: string) => {
    updates.push({ range: cellRange(tab, column, row), values: [[value]] });
    touched.add(column);
  };
  for (const key of missing) {
    write(columns[key], 1, SHEET_HEADERS[key]);
  }

  const rowById = new Map<string, number>();
  grid.forEach((cells, index) => {
    const id = index > 0 ? openReviewIdIn(cells[columns.openreview] ?? "") : undefined;
    if (id && !rowById.has(id)) {
      rowById.set(id, index + 1);
    }
  });
  // Rows empty in every cell, top first, then the rows after the last one in use.
  const emptyRows = grid
    .map((cells, index) => ({ cells, row: index + 1 }))
    .filter(({ cells, row }) => row > 1 && cells.every((cell) => !(cell ?? "").trim()))
    .map(({ row }) => row);
  let nextAppend = Math.max(grid.length, 1) + 1;
  const takeRow = () => emptyRows.shift() ?? nextAppend++;

  const added: string[] = [];
  for (const entry of entries) {
    const { submission } = entry;
    let row = rowById.get(submission.id);
    const cells = row ? (grid[row - 1] ?? []) : [];
    if (!row) {
      row = takeRow();
      rowById.set(submission.id, row);
      added.push(submission.title);
      write(columns.title, row, submission.title);
      write(columns.authors, row, (submission.author_names ?? []).join(", "));
      write(columns.openreview, row, openReviewUrl(submission.id));
    }
    const current = (column: number) => (cells[column] ?? "").trim();
    for (const [column, value] of [
      [columns.score, entry.score],
      [columns.citations, entry.citations],
      [columns.unconfirmed, entry.unconfirmed],
    ] as const) {
      if (value && value !== current(column)) {
        write(column, row, value);
      }
    }
  }
  return { updates, columns: [...touched].map(columnLetter), added };
}

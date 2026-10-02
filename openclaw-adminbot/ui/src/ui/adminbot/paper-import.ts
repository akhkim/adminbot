// Reading somebody else's spreadsheet into the papers grid.
//
// The lab tracked papers in a sheet long before this tab existed, and several people still do.
// Pasting one block at a time (see applyPaste in paper-grid.ts) assumes the columns already line
// up; a real sheet has its own headers, its own order, and columns this grid has never heard of.
// This module answers the two questions that stand between the two: which of their columns is
// which of ours, and which of their rows is which of our papers.
//
// Deterministic first, model second. A header called "Overleaf (edit)" or a cell reading
// `https://arxiv.org/abs/2401.00001` is not a judgement call, and answering it locally means the
// import works with the model tunnel down, runs instantly, and can be tested. The model is asked
// only about what is left -- see mapColumnsWithModel on the service side -- and its answer is
// merged in as a suggestion, never as an override of a confident local match.
//
// Nothing here writes. The plan it produces is applied into the grid's own `edits` map, which
// means an import is reviewed, corrected and saved through exactly the path a typed cell already
// takes: one row per paper through `PUT /papers/:id`. An import that could write directly would be
// a second way into the record, and the two would drift.

import type { AdminBotPaperRecord } from "./controllers/admin.ts";
// paper-grid imports this module back, for the panel. The pair is safe because nothing here
// reaches into the grid at module-evaluation time -- `gridColumns()` and `cellError` are only ever
// called from inside a function, so the column registry is always built by the time it is read.
import { cellError, gridColumns, type Column } from "./paper-grid.ts";

/** Header text and cell values, as they came out of the other sheet. */
export type ParsedSheet = {
  headers: string[];
  rows: string[][];
};

/**
 * Splits a pasted block into a header row and body.
 *
 * Tab-separated is what a spreadsheet puts on the clipboard; a CSV export pasted as text is the
 * other common case. The header row decides which, because it is the row that says how wide the
 * sheet is -- and a comma inside a *value* must never be read as a column break.
 */
export function parseSheet(text: string): ParsedSheet {
  const lines = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }
  // The header row defines the shape, so it decides the delimiter. Sniffing the whole block
  // instead let a comma inside a *value* split a single-column sheet in two: "causal abstraction,
  // for agents" became two cells and then matched no paper at all.
  const headerLine = lines[0] ?? "";
  const delimiter = headerLine.includes("\t") ? "\t" : headerLine.includes(",") ? "," : "\t";
  const split = (line: string) => (delimiter === "\t" ? line.split("\t") : splitCsvLine(line));
  const bodyLines = lines.slice(1);
  return {
    headers: split(headerLine).map((cell) => cell.trim()),
    rows: bodyLines.map((line) => split(line).map((cell) => cell.trim())),
  };
}

/** Quoted CSV, because a paper title routinely has a comma in it and Sheets quotes those. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      out.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  out.push(cell);
  return out;
}

/** Lowercased and stripped of everything that is not a letter or a digit. */
export function normalizeKey(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "");
}

/**
 * The other names a column goes by.
 *
 * Taken from what the lab's own sheets actually spell, not invented: "project doc", "gdoc",
 * "short name", "codename". A synonym is cheaper than a model call and it never changes its mind.
 */
const SYNONYMS: Record<string, string[]> = {
  title: ["title", "paper", "papertitle", "name", "papername"],
  alias: ["alias", "shortname", "short", "codename", "nickname", "slug", "channel"],
  started_on: ["startedon", "start", "startdate", "began", "kickoff"],
  current_step: ["currentstep", "step", "stage", "status", "phase"],
  authors: ["authors", "author", "authorlist", "people", "who"],
  author_roles: ["authorroles", "roles", "contributions", "whodoeswhat"],
  feedback_givers: ["feedbackgivers", "feedback", "readers", "reviewers", "commenters"],
  venue: ["venue", "targetvenue", "conference", "target", "aimedat"],
  venue_targets: ["venuetargets", "targets", "odds", "confidence", "bets"],
  topic: ["topic", "area", "safetyarea", "theme"],
  brainstorming_doc_url: ["projectdoc", "doc", "gdoc", "googledoc", "brainstorming", "folder"],
  overleaf_view_url: ["overleafview", "overleafread", "readlink", "overleafreadonly"],
  overleaf_edit_url: ["overleaf", "overleafedit", "overleafproject", "latex"],
  submission_url: ["submission", "openreview", "submissionlink"],
  google_drive_pdf_url: ["drivepdf", "pdf", "drivelink"],
  arxiv_url: ["arxiv", "arxivlink", "preprint"],
  arxiv_paper_password: ["arxivpassword", "arxivpw", "paperpassword"],
  google_slides_url: ["slides", "deck", "presentation", "googleslides"],
  poster_url: ["poster"],
};

/** Value-shape tells, for a column whose header said nothing useful. */
const SNIFFERS: Array<{ key: string; test: (value: string) => boolean }> = [
  { key: "arxiv_url", test: (v) => /^https?:\/\/(www\.)?arxiv\.org\/abs\//iu.test(v) },
  { key: "overleaf_view_url", test: (v) => /^https?:\/\/(www\.)?overleaf\.com\/read\//iu.test(v) },
  {
    key: "overleaf_edit_url",
    test: (v) => /^https?:\/\/(www\.)?overleaf\.com\/project\//iu.test(v),
  },
  { key: "submission_url", test: (v) => /^https?:\/\/openreview\.net\//iu.test(v) },
  {
    key: "google_slides_url",
    test: (v) => /^https?:\/\/docs\.google\.com\/presentation\//iu.test(v),
  },
  {
    key: "brainstorming_doc_url",
    test: (v) => /^https?:\/\/(docs|drive)\.google\.com\/(document|drive)\//iu.test(v),
  },
  { key: "google_drive_pdf_url", test: (v) => /^https?:\/\/drive\.google\.com\/file\//iu.test(v) },
  { key: "started_on", test: (v) => /^\d{4}-\d{2}-\d{2}$/u.test(v) },
];

export type ColumnMatch = {
  /** Index into the imported sheet's own columns. */
  sourceIndex: number;
  header: string;
  /** Grid column key, or undefined when nothing claimed it. */
  target?: string;
  how: "header" | "value" | "model" | "none";
};

/** Only a column the grid can actually write is worth mapping onto. */
function writableColumns(): Column[] {
  return gridColumns().filter((column) => Boolean(column.save || column.apply));
}

/**
 * Which of their columns is which of ours.
 *
 * A header match wins outright. Failing that, a column whose values all look like one particular
 * kind of link is claimed by shape. Anything still unclaimed is left for the model, and left
 * visible in the preview either way -- a column silently dropped is how an import loses a field
 * nobody notices for a month.
 */
export function matchColumns(sheet: ParsedSheet): ColumnMatch[] {
  const targets = writableColumns();
  const byNormalized = new Map<string, string>();
  for (const column of targets) {
    const key = String(column.key);
    byNormalized.set(normalizeKey(key), key);
    byNormalized.set(normalizeKey(column.label), key);
    byNormalized.set(normalizeKey(column.short), key);
    for (const synonym of SYNONYMS[key] ?? []) {
      byNormalized.set(synonym, key);
    }
  }
  const claimed = new Set<string>();
  const matches: ColumnMatch[] = sheet.headers.map((header, sourceIndex) => ({
    sourceIndex,
    header,
    how: "none" as const,
  }));

  for (const match of matches) {
    const target = byNormalized.get(normalizeKey(match.header));
    // First claim wins: two source columns that normalize the same way would otherwise both write
    // the same field, and the second would silently beat the first.
    if (target && !claimed.has(target)) {
      match.target = target;
      match.how = "header";
      claimed.add(target);
    }
  }

  for (const match of matches) {
    if (match.target) {
      continue;
    }
    const values = sheet.rows
      .map((row) => (row[match.sourceIndex] ?? "").trim())
      .filter(Boolean)
      .slice(0, 20);
    if (values.length === 0) {
      continue;
    }
    const sniffed = SNIFFERS.find(
      (sniffer) => !claimed.has(sniffer.key) && values.every((value) => sniffer.test(value)),
    );
    if (sniffed) {
      match.target = sniffed.key;
      match.how = "value";
      claimed.add(sniffed.key);
    }
  }
  return matches;
}

/**
 * Folds the model's answer in, without letting it overrule a confident local match.
 *
 * The model is asked about leftovers only, so a suggestion for a column already claimed is a
 * disagreement about something the header or the values had already settled -- and the local
 * answer is the one that can be explained.
 */
export function applyModelSuggestions(
  matches: ColumnMatch[],
  suggestions: Record<string, string>,
): ColumnMatch[] {
  const writable = new Set(writableColumns().map((column) => String(column.key)));
  const claimed = new Set(matches.flatMap((match) => (match.target ? [match.target] : [])));
  return matches.map((match) => {
    if (match.target) {
      return match;
    }
    const suggested = suggestions[match.header];
    if (!suggested || !writable.has(suggested) || claimed.has(suggested)) {
      return match;
    }
    claimed.add(suggested);
    return { ...match, target: suggested, how: "model" as const };
  });
}

export type RowMatch = {
  rowIndex: number;
  paperId?: string;
  how: "title" | "alias" | "link" | "none";
};

/** Punctuation and spacing are how the same title differs between two sheets. */
function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();
}

/**
 * Which of their rows is which of our papers.
 *
 * Title first, because that is what a person would match on. Then the short name, which is what a
 * lab sheet often keys by. Then any link that is already on a record, which catches a row whose
 * title was rewritten since the sheet was last touched -- an Overleaf URL is a strong identifier
 * and a retitled paper is exactly the case a title match misses.
 */
export function matchRows(
  sheet: ParsedSheet,
  columns: ColumnMatch[],
  papers: AdminBotPaperRecord[],
): RowMatch[] {
  const indexOf = (key: string) =>
    columns.find((column) => column.target === key)?.sourceIndex ?? -1;
  const titleAt = indexOf("title");
  const aliasAt = indexOf("alias");
  const linkColumns = columns.filter(
    (column) => column.target?.endsWith("_url") && column.sourceIndex >= 0,
  );

  const byTitle = new Map<string, string>();
  const byAlias = new Map<string, string>();
  const byLink = new Map<string, string>();
  for (const paper of papers) {
    if (paper.title) {
      byTitle.set(normalizeTitle(paper.title), paper.id);
    }
    if (paper.alias) {
      byAlias.set(paper.alias.trim().toLowerCase(), paper.id);
    }
    for (const value of Object.values(paper.artifacts ?? {})) {
      if (typeof value === "string" && /^https?:\/\//iu.test(value)) {
        byLink.set(value.trim().toLowerCase(), paper.id);
      }
    }
  }

  const taken = new Set<string>();
  return sheet.rows.map((row, rowIndex) => {
    const claim = (paperId: string | undefined, how: RowMatch["how"]): RowMatch | undefined => {
      // One paper per row. Two rows claiming the same paper would have the second silently
      // overwrite the first's fills, which is worse than reporting the second as unmatched.
      if (!paperId || taken.has(paperId)) {
        return undefined;
      }
      taken.add(paperId);
      return { rowIndex, paperId, how };
    };
    const title = titleAt >= 0 ? normalizeTitle(row[titleAt] ?? "") : "";
    const byTitleHit = title ? claim(byTitle.get(title), "title") : undefined;
    if (byTitleHit) {
      return byTitleHit;
    }
    const alias = aliasAt >= 0 ? (row[aliasAt] ?? "").trim().toLowerCase() : "";
    const byAliasHit = alias ? claim(byAlias.get(alias), "alias") : undefined;
    if (byAliasHit) {
      return byAliasHit;
    }
    for (const column of linkColumns) {
      const value = (row[column.sourceIndex] ?? "").trim().toLowerCase();
      const hit = value ? claim(byLink.get(value), "link") : undefined;
      if (hit) {
        return hit;
      }
    }
    return { rowIndex, how: "none" };
  });
}

export type ImportPlan = {
  columns: ColumnMatch[];
  rows: RowMatch[];
  /** paper id -> column key -> value. Exactly the shape the grid's own edits map holds. */
  fills: Map<string, Map<string, string>>;
  /** Cells the plan refuses to fill, with the reason the grid would have given. */
  rejected: Array<{ rowIndex: number; column: string; value: string; reason: string }>;
  /** Rows that matched no paper. Candidates for the create step, never filled into one. */
  unmatched: number[];
  /** Their columns nothing claimed, so the preview can say what is being ignored. */
  unmappedHeaders: string[];
};

/**
 * What the import would do, without doing any of it.
 *
 * A cell that the grid itself would mark bad is left out and reported rather than written: an
 * import is dozens of rows at once, and one malformed URL should not make the whole sheet
 * unsaveable or, worse, ride into the record because nobody scrolled to row 34.
 */
export function buildImportPlan(
  sheet: ParsedSheet,
  columns: ColumnMatch[],
  rows: RowMatch[],
): ImportPlan {
  const byKey = new Map(gridColumns().map((column) => [String(column.key), column]));
  const fills = new Map<string, Map<string, string>>();
  const rejected: ImportPlan["rejected"] = [];

  for (const rowMatch of rows) {
    if (!rowMatch.paperId) {
      continue;
    }
    const row = sheet.rows[rowMatch.rowIndex] ?? [];
    for (const columnMatch of columns) {
      if (!columnMatch.target) {
        continue;
      }
      const column = byKey.get(columnMatch.target);
      const value = (row[columnMatch.sourceIndex] ?? "").trim();
      if (!column || !value) {
        continue; // an empty cell in their sheet is not an instruction to clear ours
      }
      const reason = cellError(column, value);
      if (reason) {
        rejected.push({
          rowIndex: rowMatch.rowIndex,
          column: columnMatch.target,
          value,
          reason,
        });
        continue;
      }
      const target = fills.get(rowMatch.paperId) ?? new Map<string, string>();
      target.set(columnMatch.target, value);
      fills.set(rowMatch.paperId, target);
    }
  }

  return {
    columns,
    rows,
    fills,
    rejected,
    unmatched: rows.filter((row) => !row.paperId).map((row) => row.rowIndex),
    unmappedHeaders: columns.filter((column) => !column.target).map((column) => column.header),
  };
}

/** Everything an import decides, from a pasted block. The model step is layered on separately. */
export function planImport(text: string, papers: AdminBotPaperRecord[]): ImportPlan {
  const sheet = parseSheet(text);
  const columns = matchColumns(sheet);
  return buildImportPlan(sheet, columns, matchRows(sheet, columns, papers));
}

/** What the create step would file, and what each row is still missing before it can. */
export type CreateCandidate = {
  rowIndex: number;
  values: Record<string, string>;
  /** Fields the create form insists on that this row does not supply. */
  missing: string[];
};

/**
 * The second step, offered only after the fills are in.
 *
 * Creating a paper needs the three answers the create form insists on -- a title, a short name
 * that can be a Slack channel, and a start date -- and a foreign sheet routinely has one of the
 * three. Reporting what is missing per row is the whole point: a bulk create that guessed an alias
 * would name somebody's Slack channel after a typo.
 */
export const CREATE_REQUIRED = ["title", "alias", "started_on"] as const;

export function createCandidates(sheet: ParsedSheet, plan: ImportPlan): CreateCandidate[] {
  const byKey = new Map(gridColumns().map((column) => [String(column.key), column]));
  return plan.unmatched.map((rowIndex) => {
    const row = sheet.rows[rowIndex] ?? [];
    const values: Record<string, string> = {};
    for (const columnMatch of plan.columns) {
      if (!columnMatch.target) {
        continue;
      }
      const value = (row[columnMatch.sourceIndex] ?? "").trim();
      const column = byKey.get(columnMatch.target);
      if (!value || !column || cellError(column, value)) {
        continue;
      }
      values[columnMatch.target] = value;
    }
    return {
      rowIndex,
      values,
      missing: CREATE_REQUIRED.filter((key) => !values[key]),
    };
  });
}

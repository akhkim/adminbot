// Bulk link entry for people who own a lot of papers.
//
// Ten cards is ten expand-type-save cycles for what is, in the end, a table of URLs. Past that
// the per-paper card stops being the better surface, so this replaces it with a grid: one row
// per paper, one column per link slot, one Save.
//
// It is deliberately NOT a Google Sheet embed. The Control UI's CSP is `default-src 'self'`
// with no frame-src (src/gateway/control/control-ui-csp.ts), so a docs.google.com iframe is
// blocked outright -- and even unblocked it would be a silo, since nothing typed into Google's
// frame can reach adminbot_papers. What people actually want from "a spreadsheet" is the
// paste: keep your real sheet, select a block, Ctrl+V here. That is the feature below.
//
// Validation is per cell and advisory: a bad URL in row 7 marks row 7 and still lets the other
// fourteen rows save. Refusing the whole batch over one typo is how people learn to avoid the
// bulk tool.

import { html, nothing, type TemplateResult } from "lit";
import {
  adminBotNormalizePaperAlias,
  adminBotPaperSteps,
  type AdminBotPaperStep,
} from "../../../../extensions/adminbot/src/contracts/actions.js";
import { blockerLog } from "./blockers.ts";
import type { AdminBotPaperRecord, AdminBotPaperSaveInput } from "./controllers/admin.ts";
import {
  applyModelSuggestions,
  buildImportPlan,
  createCandidates,
  matchColumns,
  matchRows,
  parseSheet,
} from "./paper-import.ts";
import {
  canonicalVenueId,
  effectiveVenueTargets,
  formatVenueTargets,
  serializeVenueTargets,
  type VenueTarget,
} from "./venue-targets.ts";

/**
 * Above this many papers the grid is offered. Below it, the cards are the better surface.
 *
 * Two, so the sheet appears from the third paper on.
 *
 * Ten made it an admin-only feature by accident: almost nobody in the lab carries eleven papers,
 * so the one surface built for pasting a column out of Sheets was unreachable for the people
 * doing the pasting. Three was the first correction and it was still one too high -- somebody
 * with exactly three papers, which is a normal number to have, still saw nothing. Pasting beats
 * three separate forms; below three there is nothing to paste.
 */
export const PAPER_GRID_THRESHOLD = 2;

type ArtifactKey = NonNullable<AdminBotPaperRecord["artifacts"]>;

/**
 * How a cell behaves.
 *
 * The grid began as eight columns of URLs, so "a cell" and "a URL input" were the same thing.
 * Carrying every field the card carries means that is no longer true: a step is a closed list, a
 * start date is a date, an accepted year is a number, and a blocker log is a structure no cell
 * should let anyone retype by hand.
 */
type ColumnKind = "url" | "text" | "date" | "number" | "select" | "readonly";

export type Column = {
  /** Identity of the column: the `artifacts` key by default, otherwise just a stable name. */
  key: keyof ArtifactKey | string;
  /** Key on the save input. Absent means `apply` writes it, or that nothing does. */
  save?: keyof AdminBotPaperSaveInput;
  label: string;
  short: string;
  kind?: ColumnKind;
  /** Choices for `kind: "select"`. */
  options?: ReadonlyArray<{ value: string; label: string }>;
  /**
   * How the stored value is read off the record.
   *
   * Defaults to `artifacts[key]`, which is where the link slots live. The fields that arrived with
   * "the grid should carry what the card carries" mostly do not: title, alias, the step and the
   * acceptance answers are columns on the record itself.
   */
  read?: (paper: AdminBotPaperRecord) => string;
  /**
   * How a cell is written back onto the save input.
   *
   * Defaults to `input[save] = value`. Supplied for anything that is not a plain string on the
   * input -- an author list, a set of venue targets -- so the structure is rebuilt rather than
   * flattened.
   */
  apply?: (input: AdminBotPaperSaveInput, value: string, paper: AdminBotPaperRecord) => void;
  /** Overrides the built-in URL checking. Returns a reason, or undefined when the value is fine. */
  validate?: (value: string) => string | undefined;
  hosts?: string[];
  path?: RegExp;
  /** Not a URL — validated by pattern instead. */
  pattern?: RegExp;
  hint?: string;
  /**
   * The shape of an acceptable value, as a prefix.
   *
   * Deliberately not a complete link. A full example with a plausible document id reads as real
   * and invites being pasted -- which is how a sheet ends up with thirty rows pointing at the
   * same fictional document. A prefix answers "what goes here" and cannot be mistaken for an
   * answer to "what goes in this row".
   */
  format: string;
};

/**
 * Names are joined with semicolons, not commas.
 *
 * "Yook, Joeun" is how a BibTeX paste spells one person. Splitting that list on commas turns one
 * author into two, and the second one is a first name nobody on the roster answers to.
 */
const NAME_SEPARATOR = "; ";

function splitNames(value: string): string[] {
  return value
    .split(";")
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * Rebuilds the author list from retyped names, keeping who each one is.
 *
 * `author_links` is the answer somebody recorded when they picked an author off the roster, and it
 * is what decides whose My Projects page a paper appears on. A grid cell holds names and nothing
 * else, so writing one back naively would replace every link with a bare name and quietly detach
 * the paper from its authors.
 *
 * A name that survives the edit keeps its link. A name that does not is a new, unlinked author --
 * which is the honest result, and the card's own picker is where it gets linked to a member.
 */
export function mergeAuthorLinks(
  paper: AdminBotPaperRecord,
  typedNames: string[],
): Array<{ name: string; member_id?: string; email?: string }> {
  const priorByName = new Map(
    (paper.author_links ?? []).map((link) => [link.name.trim().toLowerCase(), link]),
  );
  return typedNames.map((name) => {
    const prior = priorByName.get(name.toLowerCase());
    return prior ? { ...prior, name } : { name };
  });
}

/** "80% ICLR 2027 · 50% ARR October" back into the rows the record stores. */
export function parseVenueTargets(value: string): VenueTarget[] | undefined {
  const parts = value
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);
  const targets: VenueTarget[] = [];
  for (const part of parts) {
    const match = /^(\d{1,3})%\s*(.+)$/u.exec(part);
    if (!match) {
      return undefined;
    }
    const confidence = Number(match[1]);
    const label = (match[2] ?? "").trim();
    if (!label || confidence < 0 || confidence > 100) {
      return undefined;
    }
    targets.push({ venue_id: canonicalVenueId(label), label, confidence });
  }
  return targets;
}

// Columns follow the slot registry in fields_update.md. `arxiv_paper_password` is listed
// because the layout is part of the design being reviewed, but it has no field on the record
// yet, so it is rendered disabled rather than accepting text this UI would then drop.
const STEP_OPTIONS = adminBotPaperSteps.map((step) => ({
  value: step,
  label: step.replaceAll("_", " "),
}));

const DECISION_OPTIONS = [
  { value: "pending", label: "Not heard yet" },
  { value: "accept", label: "Accepted" },
  { value: "reject", label: "Rejected" },
];

const ARCHIVAL_OPTIONS = [
  { value: "", label: "Not said" },
  { value: "true", label: "Archival" },
  { value: "false", label: "Non-archival" },
];

const PRESENTATION_OPTIONS = [
  { value: "", label: "Not said" },
  ...["poster", "findings", "main", "spotlight", "oral", "award"].map((type) => ({
    value: type,
    label: `${type[0]?.toUpperCase() ?? ""}${type.slice(1)}`,
  })),
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Every field the card can edit, in the order a person reads a paper: what it is, who wrote it,
 * where it is going, what the venue said, then the links.
 *
 * The grid and the card now carry the same set and write it to the same place -- one row in
 * `adminbot_papers` through `PUT /papers/:id`, whichever surface typed it.
 *
 * Three fields are deliberately read-only rather than absent. A blocker log is a structure with
 * an author and a timestamp per entry, the slot checklist lives in its own table, and neither
 * survives being retyped as text in a cell; showing them keeps the grid honest about what a paper
 * holds without offering an edit that would lose the rest of the record.
 */
const COLUMNS: Column[] = [
  {
    key: "title",
    kind: "text",
    save: "title",
    read: (paper) => paper.title ?? "",
    validate: (value) => (value.trim() ? undefined : "a paper needs a title"),
    label: "Title",
    short: "Title",
    format: "The paper's title",
    hint: "Renaming here renames it everywhere",
  },
  {
    key: "alias",
    kind: "text",
    save: "alias",
    read: (paper) => paper.alias ?? "",
    // Same rule the card and the create form apply: it becomes a Slack channel either way.
    validate: (value) =>
      !value.trim() || adminBotNormalizePaperAlias(value)
        ? undefined
        : "letters, digits and hyphens only",
    label: "Short name",
    short: "Short name",
    format: "cais",
    hint: "Names the project's Slack channel",
  },
  {
    key: "started_on",
    kind: "date",
    save: "startedOn",
    read: (paper) => paper.started_on ?? "",
    validate: (value) => (!value.trim() || ISO_DATE.test(value.trim()) ? undefined : "YYYY-MM-DD"),
    label: "Started on",
    short: "Started",
    format: "2026-09-01",
  },
  {
    key: "current_step",
    kind: "select",
    options: STEP_OPTIONS,
    save: "currentStep",
    read: (paper) => paper.current_step ?? "",
    label: "Current step",
    short: "Step",
    format: "One of the pipeline steps",
  },
  {
    key: "authors",
    kind: "text",
    read: (paper) =>
      (paper.author_links ?? []).length
        ? (paper.author_links ?? []).map((link) => link.name).join(NAME_SEPARATOR)
        : (paper.authors ?? []).join(NAME_SEPARATOR),
    apply: (input, value, paper) => {
      const names = splitNames(value);
      input.authors = names;
      // Rebuilt rather than replaced, so an author who was already matched to a roster member
      // stays matched. See mergeAuthorLinks.
      input.authorLinks = mergeAuthorLinks(paper, names);
    },
    validate: (value) =>
      !value.trim() || splitNames(value).length ? undefined : "separate names with ;",
    label: "Authors",
    short: "Authors",
    format: "Ada Lovelace; Yook, Joeun",
    hint: "Semicolons, because a BibTeX name already has a comma in it",
  },
  {
    key: "author_roles",
    kind: "text",
    save: "authorRoles",
    read: (paper) => paper.author_roles ?? "",
    label: "Author roles",
    short: "Roles",
    format: "Who does what on the paper",
  },
  {
    key: "feedback_givers",
    kind: "text",
    read: (paper) => (paper.feedback_givers ?? []).join(NAME_SEPARATOR),
    apply: (input, value) => {
      input.feedbackGivers = splitNames(value);
    },
    label: "Feedback givers",
    short: "Feedback",
    format: "Ada Lovelace; Rahul Shrestha",
    hint: "People asked to read the draft",
  },
  {
    key: "venue",
    kind: "text",
    save: "venue",
    read: (paper) => paper.venue ?? "",
    label: "Target venue",
    short: "Venue",
    format: "ICLR 2027",
    hint: "What the stage nudges quote and the deadline board matches on",
  },
  {
    key: "venue_targets",
    kind: "text",
    read: (paper) => formatVenueTargets(effectiveVenueTargets(paper)),
    apply: (input, value) => {
      input.venueTargets = serializeVenueTargets(parseVenueTargets(value) ?? []);
    },
    validate: (value) =>
      !value.trim() || parseVenueTargets(value) ? undefined : "use 80% ICLR 2027 · 50% ARR October",
    label: "Target venues, with odds",
    short: "Targets",
    format: "80% ICLR 2027 · 50% ARR October",
    hint: "Highest bet first, separated by ·",
  },
  {
    key: "topic",
    kind: "text",
    save: "topic",
    label: "Topic",
    short: "Topic",
    format: "The safety area this sits in",
  },
  {
    key: "venue_decision",
    // Read-only, because the member write path will not take these. `upsertOwnPaper` refuses
    // `venue_decision` outright (400 -- for an admin as much as an author) and silently drops the
    // four details beside it, which are absent from OWN_PAPER_EDITABLE_FIELDS. An editable cell
    // would fail the whole row's save and take every other column in it down too. Shown rather
    // than hidden so the grid still says what the paper holds.
    kind: "readonly",
    options: DECISION_OPTIONS,
    read: (paper) => paper.venue_decision ?? "pending",
    label: "Venue decision",
    short: "Decision",
    format: "Whether the venue has answered",
  },
  {
    key: "accepted_venue",
    kind: "readonly",
    read: (paper) => paper.accepted_venue ?? "",
    label: "Accepted venue",
    short: "Accepted at",
    format: "ICLR 2027",
  },
  {
    key: "accepted_year",
    kind: "readonly",
    read: (paper) => (paper.accepted_year === undefined ? "" : String(paper.accepted_year)),
    validate: (value) =>
      !value.trim() || /^\d{4}$/u.test(value.trim()) ? undefined : "a four-digit year",
    label: "Accepted year",
    short: "Year",
    format: "2027",
  },
  {
    key: "is_archival",
    kind: "readonly",
    options: ARCHIVAL_OPTIONS,
    read: (paper) => (paper.is_archival === undefined ? "" : String(paper.is_archival)),
    label: "Archival?",
    short: "Archival",
    format: "Whether it counts as a publication",
  },
  {
    key: "presentation_type",
    kind: "readonly",
    options: PRESENTATION_OPTIONS,
    read: (paper) => paper.presentation_type ?? "",
    label: "Presentation",
    short: "Presented as",
    format: "Poster, oral, and so on",
  },
  {
    key: "blocker_log",
    kind: "readonly",
    // Shown, not editable. Each entry carries who raised it and when, and the card's form is what
    // keeps that true -- a cell holding the JSON would let one paste erase the history.
    read: (paper) => {
      const open = blockerLog(paper).filter((entry) => !entry.resolved_at);
      return open.length ? open.map((entry) => entry.title).join(NAME_SEPARATOR) : "";
    },
    label: "Open blockers",
    short: "Blockers",
    format: "Raised on the card",
    hint: "Read-only here — filed and resolved on the paper's card",
  },
  {
    key: "brainstorming_doc_url",
    format: "https://docs.google.com/document/… or https://drive.google.com/drive/folders/…",
    save: "brainstormingDocUrl",
    label: "Project doc / folder",
    short: "Project",
    hosts: ["docs.google.com", "drive.google.com"],
    hint: "A doc or a Drive folder",
  },
  {
    key: "overleaf_view_url",
    format: "https://www.overleaf.com/read/…",
    save: "overleafViewUrl",
    label: "Overleaf (view)",
    short: "Overleaf view",
    hosts: ["overleaf.com", "www.overleaf.com"],
    hint: "The read-only share link",
  },
  {
    key: "overleaf_edit_url",
    format: "https://www.overleaf.com/project/…",
    save: "overleafEditUrl",
    label: "Overleaf (edit)",
    short: "Overleaf edit",
    hosts: ["overleaf.com", "www.overleaf.com"],
    hint: "The project link coauthors can write in",
  },
  {
    key: "submission_url",
    format: "https://openreview.net/forum?id=… or the venue's own site",
    save: "submissionUrl",
    label: "Submission",
    short: "Submission",
    hint: "Where the submission itself lives",
  },
  {
    key: "google_drive_pdf_url",
    format: "https://drive.google.com/file/…",
    save: "googleDrivePdfUrl",
    label: "Drive PDF (arXiv version)",
    short: "Drive PDF",
    hosts: ["drive.google.com", "docs.google.com"],
    hint: "The PDF as posted to arXiv",
  },
  {
    key: "arxiv_url",
    format: "https://arxiv.org/abs/…",
    save: "arxivUrl",
    label: "arXiv",
    short: "arXiv",
    hosts: ["arxiv.org", "www.arxiv.org"],
    path: /^\/abs\//u,
    hint: "The /abs/ page, not the PDF",
  },
  {
    key: "arxiv_paper_password",
    kind: "text",
    format: "Six letters or digits",
    save: "arxivPaperPassword",
    label: "arXiv paper password",
    short: "arXiv pw",
    pattern: /^[A-Za-z0-9]{6}$/u,
    hint: "Six characters — stored in plain text on the record every coauthor can read",
  },
  {
    key: "google_slides_url",
    format: "https://docs.google.com/presentation/…",
    save: "googleSlidesUrl",
    label: "Slides",
    short: "Slides",
    hosts: ["docs.google.com"],
    path: /^\/presentation\//u,
    hint: "A Google Slides deck",
  },
  {
    key: "poster_url",
    format: "https://… (any site)",
    save: "posterUrl",
    label: "Poster",
    short: "Poster",
    hint: "Any https link — Drive, Overleaf, wherever it lives",
  },
];

/**
 * Where a column sits, by name.
 *
 * Exported for the tests, which used to address columns by literal index -- so removing the
 * Submission column silently repointed every one of them at its neighbour and six assertions
 * started testing the wrong field. A name survives the next column being added or dropped.
 */
export function gridColumns(): readonly Column[] {
  return COLUMNS;
}

export function columnIndexOf(key: string): number {
  return COLUMNS.findIndex((column) => String(column.key) === key);
}

export type PaperGridEdits = Map<string, Map<string, string>>;

// ── column widths ──────────────────────────────────────────────────────────────────────
//
// The sheet was unusable before this existed, and the reason was one missing declaration.
// Without `table-layout: fixed` a table sizes each column to its longest content, so `width` on
// a header is a suggestion the browser is free to ignore -- and it did. One 104-character title
// set the Paper column to about 1,300px, pushed every link column past the right edge, and the
// ellipsis never fired because the column never had to clip anything. The sheet scrolled, but
// only a column and a half of it was ever reachable.
//
// Fixed layout needs somewhere to read the widths from, which is what the <colgroup> below is
// for -- and once widths live in state rather than in CSS, making them draggable is the same
// mechanism rather than a second one.

const WIDTH_STORAGE_KEY = "adminbot.paper-grid.widths";

/** Key for the pinned title column, which is resizable like any other. */
export const TITLE_COLUMN = "__title";

const DEFAULT_WIDTHS: Record<string, number> = { [TITLE_COLUMN]: 320 };
/** The row-number gutter. Fixed, and counted into the table width like every other column. */
export const ROWNUM_WIDTH = 40;
const DEFAULT_LINK_WIDTH = 200;
/** Narrow enough to be useless, wide enough to hide the rest of the sheet. */
const MIN_WIDTH = 64;
const MAX_WIDTH = 900;

export function columnWidth(state: PaperGridState, key: string): number {
  return state.widths.get(key) ?? DEFAULT_WIDTHS[key] ?? DEFAULT_LINK_WIDTH;
}

/**
 * The table's own width, in pixels.
 *
 * Required, not cosmetic. `table-layout: fixed` only honours the <colgroup> when the table has a
 * definite width -- under `width: max-content` the browser goes back to measuring cells, which is
 * why the Paper column sized itself to a 104-character title and why dragging its edge did
 * nothing at all.
 */
export function tableWidth(state: PaperGridState): number {
  return (
    ROWNUM_WIDTH +
    columnWidth(state, TITLE_COLUMN) +
    COLUMNS.reduce((total, column) => total + columnWidth(state, String(column.key)), 0)
  );
}

export function clampWidth(px: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));
}

/**
 * Widths are per person and local.
 *
 * How wide someone wants the Paper column is a fact about their screen and their eyes, not about
 * the lab, so it does not belong on the record and does not need the backend. Same store as the
 * grid's edit history, and the same failure mode: a browser refusing storage costs a preference,
 * never data.
 */
export function loadWidths(): Map<string, number> {
  try {
    const raw = globalThis.localStorage?.getItem(WIDTH_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return new Map();
    }
    return new Map(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
        .map(([key, value]) => [key, clampWidth(value as number)]),
    );
  } catch {
    return new Map();
  }
}

export function saveWidths(widths: Map<string, number>): void {
  try {
    globalThis.localStorage?.setItem(WIDTH_STORAGE_KEY, JSON.stringify(Object.fromEntries(widths)));
  } catch {
    // Storage denied or full. A forgotten column width is not worth interrupting anyone over.
  }
}

export type PaperGridState = {
  /** The pasted sheet, its plan, and whether the panel is open. Nothing here is written. */
  importOpen?: boolean;
  importText?: string;
  importPlan?: import("./paper-import.ts").ImportPlan;
  importSheet?: import("./paper-import.ts").ParsedSheet;
  importBusy?: boolean;
  /** paperId -> column key -> typed value. Only what the user actually changed. */
  edits: PaperGridEdits;
  saving: boolean;
  notice: string;
  showHistory: boolean;
  history: PaperGridHistoryEntry[];
  /** Column key -> pixels. Read by the <colgroup>; written by the drag handles. */
  widths: Map<string, number>;
  /** Key of the column whose help bubble is open, or null. One at a time. */
  helpFor: string | null;
};

export function emptyPaperGridState(): PaperGridState {
  return {
    edits: new Map(),
    saving: false,
    notice: "",
    showHistory: false,
    history: loadHistory(),
    widths: loadWidths(),
    helpFor: null,
  };
}

/** What is currently in a cell: the pending edit if there is one, else what is stored. */
export function cellValue(
  state: PaperGridState,
  paper: AdminBotPaperRecord,
  column: Column,
): string {
  const edited = state.edits.get(paper.id)?.get(String(column.key));
  if (edited !== undefined) {
    return edited;
  }
  if (column.read) {
    return column.read(paper);
  }
  const artifacts = paper.artifacts as Record<string, string | undefined> | undefined;
  return artifacts?.[String(column.key)] ?? "";
}

/**
 * Why a cell is not acceptable, or undefined when it is.
 *
 * Shape only, never a liveness check — the same rule the service applies to member profile
 * links, and for the same reason: verifying a URL resolves means an outbound fetch driven by
 * whatever someone pasted.
 */
export function cellError(column: Column, raw: string): string | undefined {
  const value = raw.trim();
  // A column with its own rule owns the whole answer, empty included: a title may not be blank,
  // where a link may.
  if (column.validate) {
    return column.validate(raw);
  }
  if (!value) {
    return undefined; // empty clears the link; nothing is required here
  }
  // Only a URL column is held to URL rules. Everything the card contributed is text, a date, a
  // number or a closed list, and running `new URL()` over those would call every one of them bad.
  if (column.kind && column.kind !== "url") {
    if (column.pattern) {
      return column.pattern.test(value) ? undefined : (column.hint ?? "wrong shape");
    }
    if (column.kind === "select" && column.options) {
      return column.options.some((option) => option.value === value)
        ? undefined
        : "not one of the choices";
    }
    return undefined;
  }
  if (column.pattern) {
    return column.pattern.test(value) ? undefined : "must be 6 letters/digits";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "https:") {
    return "must be https";
  }
  if (column.hosts && !column.hosts.includes(url.hostname)) {
    return `expected ${column.hosts[0]}`;
  }
  if (column.path && !column.path.test(url.pathname)) {
    return column.hint ?? "wrong kind of link";
  }
  return undefined;
}

function setEdit(state: PaperGridState, paperId: string, key: string, value: string): void {
  const row = state.edits.get(paperId) ?? new Map<string, string>();
  row.set(key, value);
  state.edits.set(paperId, row);
}

/**
 * Copy one cell down the column, into the empty cells only.
 *
 * Deliberately not the spreadsheet behaviour, which overwrites whatever it passes over. This runs
 * across a sheet of links somebody else filled in, one drag can cover thirty rows, and there is no
 * undo -- so an overwrite here quietly replaces real work with a duplicate. Filling only the
 * blanks makes the gesture safe to try, which is what makes it usable at all: the worst outcome
 * is that nothing happens.
 *
 * Returns how many cells it actually filled, so the notice can say something true.
 */
export function fillDown(
  state: PaperGridState,
  papers: AdminBotPaperRecord[],
  column: Column,
  fromRow: number,
  toRow: number,
): number {
  const source = cellValue(state, papers[fromRow] as AdminBotPaperRecord, column).trim();
  if (!source || !column.save) {
    return 0;
  }
  let filled = 0;
  for (let row = fromRow + 1; row <= Math.min(toRow, papers.length - 1); row += 1) {
    const paper = papers[row];
    if (!paper) {
      continue;
    }
    if (cellValue(state, paper, column).trim()) {
      continue; // already has something; leave it alone
    }
    setEdit(state, paper.id, String(column.key), source);
    filled += 1;
  }
  return filled;
}

/**
 * Spread a clipboard block across the grid, starting at the pasted cell.
 *
 * Google Sheets, Excel and Numbers all put tab-separated rows on the clipboard, so one parser
 * covers every source someone is likely to be copying from.
 */
export function applyPaste(
  state: PaperGridState,
  papers: AdminBotPaperRecord[],
  startRow: number,
  startColumn: number,
  clipboard: string,
): number {
  const rows = clipboard.replace(/\r\n?/gu, "\n").replace(/\n$/u, "").split("\n");
  let filled = 0;
  rows.forEach((line, rowOffset) => {
    const paper = papers[startRow + rowOffset];
    if (!paper) {
      return; // pasted more rows than there are papers; the extra rows are dropped
    }
    line.split("\t").forEach((cell, columnOffset) => {
      const column = COLUMNS[startColumn + columnOffset];
      if (!column || !column.save) {
        return; // past the last column, or a column the backend cannot store yet
      }
      setEdit(state, paper.id, String(column.key), cell.trim());
      filled += 1;
    });
  });
  return filled;
}

/** The rows that actually changed, as save inputs. Unchanged papers are not re-sent. */
export function pendingSaves(
  state: PaperGridState,
  papers: AdminBotPaperRecord[],
): AdminBotPaperSaveInput[] {
  const out: AdminBotPaperSaveInput[] = [];
  for (const paper of papers) {
    const row = state.edits.get(paper.id);
    if (!row || row.size === 0) {
      continue;
    }
    const input: AdminBotPaperSaveInput = {
      id: paper.id,
      title: paper.title,
      authors: paper.authors ?? [],
      currentStep: paper.current_step as AdminBotPaperStep,
    };
    let touched = false;
    for (const column of COLUMNS) {
      // `readonly` columns have neither, which is what makes them read-only.
      if (!column.save && !column.apply) {
        continue;
      }
      const value = row.get(String(column.key));
      if (value === undefined || cellError(column, value)) {
        continue; // a cell that fails validation is left behind, not saved as garbage
      }
      if (column.apply) {
        // Structure is rebuilt rather than flattened -- an author list keeps its roster links.
        column.apply(input, value.trim(), paper);
      } else if (column.save) {
        (input as Record<string, unknown>)[column.save] = value.trim();
      }
      touched = true;
    }
    if (touched) {
      out.push(input);
    }
  }
  return out;
}

// ── change history ───────────────────────────────────────────────────────────────────────
//
// Kept in localStorage rather than on the record, because there is no audit surface for paper
// artifacts yet -- the service stores the current value and nothing about how it got there.
// That makes this a per-browser log, not a lab-wide one, and it is labelled as such in the UI
// so nobody mistakes it for the audit trail. When the backend grows a slot history (see
// `provided_by_member_id` / `provided_at` in fields_update.md) this should read from there.

const HISTORY_KEY = "openclaw.adminbot.papergrid.history.v1";
const HISTORY_LIMIT = 30;

export type PaperGridHistoryEntry = {
  at: string;
  paperTitle: string;
  column: string;
  from: string;
  to: string;
  kind: "added" | "changed" | "cleared";
};

function safeStorage(): Storage | null {
  try {
    // Presence is not enough: test environments and some embedded browsers expose a
    // `localStorage` object whose methods are missing, so the methods are checked too.
    const storage = typeof localStorage === "undefined" ? null : localStorage;
    return typeof storage?.setItem === "function" && typeof storage.getItem === "function"
      ? storage
      : null;
  } catch {
    return null; // Safari private mode throws on access rather than returning null
  }
}

export function loadHistory(): PaperGridHistoryEntry[] {
  try {
    const raw = safeStorage()?.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as PaperGridHistoryEntry[]).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Newest first, capped. Returns the stored list so the caller can render without re-reading. */
export function recordHistory(entries: PaperGridHistoryEntry[]): PaperGridHistoryEntry[] {
  const merged = [...entries, ...loadHistory()].slice(0, HISTORY_LIMIT);
  try {
    safeStorage()?.setItem(HISTORY_KEY, JSON.stringify(merged));
  } catch {
    // A full or unavailable storage must not cost the user their save.
  }
  return merged;
}

export function clearHistory(): void {
  try {
    safeStorage()?.removeItem(HISTORY_KEY);
  } catch {
    // ignore
  }
}

/**
 * What changed, comparing each pending edit against what is stored.
 *
 * Computed before the save is sent, because afterwards the record holds the new value and the
 * old one is gone.
 */
export function diffForHistory(
  state: PaperGridState,
  papers: AdminBotPaperRecord[],
): PaperGridHistoryEntry[] {
  const at = new Date().toISOString();
  const out: PaperGridHistoryEntry[] = [];
  for (const paper of papers) {
    const row = state.edits.get(paper.id);
    if (!row) {
      continue;
    }
    for (const column of COLUMNS) {
      if (!column.save) {
        continue;
      }
      const typed = row.get(String(column.key));
      if (typed === undefined || cellError(column, typed)) {
        continue;
      }
      const artifacts = paper.artifacts as Record<string, string | undefined> | undefined;
      const before = (artifacts?.[String(column.key)] ?? "").trim();
      const after = typed.trim();
      if (before === after) {
        continue;
      }
      out.push({
        at,
        paperTitle: paper.title,
        column: column.label,
        from: before,
        to: after,
        kind: !before ? "added" : !after ? "cleared" : "changed",
      });
    }
  }
  return out;
}

/** One line of plain English per entry. */
export function describeHistory(entry: PaperGridHistoryEntry): string {
  if (entry.kind === "added") {
    return `You added ${entry.column}: ${entry.to}`;
  }
  if (entry.kind === "cleared") {
    return `You cleared ${entry.column} (was ${entry.from})`;
  }
  return `You changed ${entry.column} from ${entry.from} to ${entry.to}`;
}

function formatWhen(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return "";
  }
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(then).toLocaleDateString();
}

export type PaperGridProps = {
  state: PaperGridState;
  papers: AdminBotPaperRecord[];
  onChange: () => void;
  onSaveAll: (inputs: AdminBotPaperSaveInput[]) => void;
  onExit: () => void;
  /**
   * Asks the service to place the columns the local pass could not.
   *
   * Optional: without it the import still works, with those columns left for the member to map by
   * hand. The model is an assist, never the thing the feature stands on.
   */
  onMapColumnsWithModel?: (
    unmapped: Array<{ header: string; samples: string[] }>,
    available: string[],
  ) => Promise<Record<string, string>>;
  /** Files the rows that matched no paper, as the second, confirmed step. */
  onCreatePapers?: (candidates: import("./paper-import.ts").CreateCandidate[]) => void;
};

/**
 * Drag the right edge of a header to resize that column.
 *
 * The <col> element's style is written directly while the pointer moves, rather than going
 * through state and a re-render. Thirty-three rows of nine inputs is three hundred elements Lit
 * would rebuild on every pointermove, which turns a drag into a slideshow. State is updated once,
 * on release, which is also the only moment worth writing to storage.
 */
function startResize(
  event: PointerEvent,
  state: PaperGridState,
  key: string,
  onChange: () => void,
): void {
  event.preventDefault();
  const handle = event.currentTarget as HTMLElement;
  const table = handle.closest("table");
  const col = table?.querySelector<HTMLElement>(`col[data-key="${key}"]`);
  if (!col) {
    return;
  }
  const startX = event.clientX;
  const startWidth = columnWidth(state, key);
  const startTable = tableWidth(state);
  let latest = startWidth;

  const move = (moveEvent: PointerEvent) => {
    latest = clampWidth(startWidth + (moveEvent.clientX - startX));
    col.style.width = `${latest}px`;
    // The table has to move with the column, or shrinking one just hands the space to another.
    if (table) {
      table.style.width = `${startTable + (latest - startWidth)}px`;
    }
  };
  const done = () => {
    globalThis.removeEventListener("pointermove", move);
    globalThis.removeEventListener("pointerup", done);
    state.widths.set(key, latest);
    saveWidths(state.widths);
    onChange();
  };
  globalThis.addEventListener("pointermove", move);
  globalThis.addEventListener("pointerup", done);
}

/**
 * Drag the fill handle down the column to copy a value into the blank cells it covers.
 *
 * The row under the pointer is read off the DOM rather than computed from a row height, because
 * a row is only a fixed height until someone's browser zooms or a title wraps. Releasing outside
 * the table keeps the last row the pointer was actually over.
 */
function startFill(
  event: PointerEvent,
  props: PaperGridProps,
  column: Column,
  fromRow: number,
): void {
  event.preventDefault();
  const { state, papers } = props;
  let toRow = fromRow;

  const rowUnder = (clientX: number, clientY: number): number | undefined => {
    const row = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("tr[data-row]");
    const index = Number(row?.dataset.row);
    return Number.isInteger(index) ? index : undefined;
  };

  const move = (moveEvent: PointerEvent) => {
    const row = rowUnder(moveEvent.clientX, moveEvent.clientY);
    if (row !== undefined && row > fromRow) {
      toRow = row;
    }
  };
  const done = () => {
    globalThis.removeEventListener("pointermove", move);
    globalThis.removeEventListener("pointerup", done);
    // A click with no drag means "all the way down", which is what double-clicking a fill handle
    // does in Sheets. Here a plain click is enough, because there is nothing else it could mean.
    const target = toRow > fromRow ? toRow : papers.length - 1;
    const filled = fillDown(state, papers, column, fromRow, target);
    state.notice = filled
      ? `Filled ${filled} empty cell(s) in ${column.short}. Nothing is saved until you press Update.`
      : `Nothing to fill — the cells below already have values.`;
    props.onChange();
  };
  globalThis.addEventListener("pointermove", move);
  globalThis.addEventListener("pointerup", done);
}

/**
 * The question mark on a column heading, and the bubble it opens.
 *
 * On the heading rather than in the cells: the rule is a fact about the column, so stating it
 * once where the column is named beats repeating it down thirty rows -- and a cell that says
 * something when it is empty is a cell the reader has to check before trusting it is empty.
 */
function renderColumnHelp(state: PaperGridState, column: Column, onChange: () => void) {
  const key = String(column.key);
  const open = state.helpFor === key;
  return html`<span class="paper-grid__help-wrap">
    <button
      type="button"
      class="paper-grid__help"
      aria-expanded=${open ? "true" : "false"}
      aria-label=${`What goes in ${column.label}?`}
      data-testid=${`grid-help-${key}`}
      @click=${(event: Event) => {
        event.stopPropagation();
        state.helpFor = open ? null : key;
        onChange();
      }}
    >
      ?
    </button>
    ${open
      ? html`<span class="paper-grid__help-pop" role="note">
          <strong>${column.label}</strong>
          ${column.hint ? html`<span class="paper-grid__help-hint">${column.hint}</span>` : nothing}
          <code>${column.format}</code>
        </span>`
      : nothing}
  </span>`;
}

/**
 * The import panel: paste a sheet, see what it would do, then fill.
 *
 * Two steps on purpose. The plan is shown before anything moves -- how many cells would be filled,
 * which of their columns nothing claimed, which rows matched no paper, and which cells were
 * refused and why. Filling writes into the grid's own `edits` map, so an import lands exactly where
 * a typed cell lands and is saved by the same Update button through the same endpoint.
 */
function renderImportPanel(props: PaperGridProps): TemplateResult {
  const { state, papers } = props;
  const plan = state.importPlan;
  const sheet = state.importSheet;
  const filledCells = plan
    ? [...plan.fills.values()].reduce((total, row) => total + row.size, 0)
    : 0;
  const candidates = plan && sheet ? createCandidates(sheet, plan) : [];
  const creatable = candidates.filter((candidate) => candidate.missing.length === 0);

  const analyse = async (): Promise<void> => {
    const text = state.importText ?? "";
    if (!text.trim()) {
      return;
    }
    const parsed = parseSheet(text);
    let columns = matchColumns(parsed);
    // The model only ever sees what the local pass could not place.
    const leftovers = columns.filter((column) => !column.target);
    if (leftovers.length > 0 && props.onMapColumnsWithModel) {
      const claimed = new Set(columns.flatMap((column) => (column.target ? [column.target] : [])));
      const available = gridColumns()
        .filter((column) => (column.save || column.apply) && !claimed.has(String(column.key)))
        .map((column) => String(column.key));
      state.importBusy = true;
      props.onChange();
      try {
        const suggestions = await props.onMapColumnsWithModel(
          leftovers.map((column) => ({
            header: column.header,
            samples: parsed.rows
              .map((row) => (row[column.sourceIndex] ?? "").trim())
              .filter(Boolean)
              .slice(0, 3),
          })),
          available,
        );
        columns = applyModelSuggestions(columns, suggestions);
      } catch {
        // A dead tunnel costs the leftovers and nothing else.
      } finally {
        state.importBusy = false;
      }
    }
    state.importSheet = parsed;
    state.importPlan = buildImportPlan(parsed, columns, matchRows(parsed, columns, papers));
    props.onChange();
  };

  return html`
    <div class="paper-grid__import">
      <div class="paper-grid__history-head">
        <strong>Import a sheet</strong>
        <span class="paper-grid__muted">
          Paste it with its header row — the columns do not have to be in our order
        </span>
      </div>
      <textarea
        class="paper-grid__import-text"
        rows="4"
        data-testid="paper-grid-import-text"
        placeholder="Title&#9;Overleaf&#9;arXiv&#10;Causal abstraction&#9;https://…&#9;https://…"
        .value=${state.importText ?? ""}
        @input=${(event: Event) => {
          state.importText = (event.target as HTMLTextAreaElement).value;
          // The old plan describes the old paste; keeping it on screen would be a lie.
          state.importPlan = undefined;
          state.importSheet = undefined;
          props.onChange();
        }}
      ></textarea>
      <div class="paper-grid__tools">
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${state.importBusy || !(state.importText ?? "").trim()}
          data-testid="paper-grid-import-analyse"
          @click=${() => void analyse()}
        >
          ${state.importBusy ? "Matching…" : "Match it up"}
        </button>
        ${plan
          ? html`<button
              type="button"
              class="btn primary"
              ?disabled=${filledCells === 0}
              data-testid="paper-grid-import-fill"
              @click=${() => {
                for (const [paperId, cells] of plan.fills) {
                  const row = state.edits.get(paperId) ?? new Map<string, string>();
                  for (const [key, value] of cells) {
                    row.set(key, value);
                  }
                  state.edits.set(paperId, row);
                }
                state.notice = `Filled ${filledCells} cell(s) from the sheet. Nothing is saved until you press Update.`;
                state.importPlan = undefined;
                state.importSheet = undefined;
                state.importText = "";
                state.importOpen = false;
                props.onChange();
              }}
            >
              Fill ${filledCells} cell(s)
            </button>`
          : nothing}
      </div>

      ${plan
        ? html`
            <ul class="paper-grid__import-summary" data-testid="paper-grid-import-summary">
              <li>
                ${plan.rows.filter((row) => row.paperId).length} of ${plan.rows.length} row(s)
                matched a paper you already have
              </li>
              <li>
                ${plan.columns.filter((column) => column.target).length} of ${plan.columns.length}
                column(s)
                placed${plan.unmappedHeaders.length
                  ? html` — ignoring
                      <strong>${plan.unmappedHeaders.join(", ")}</strong>`
                  : nothing}
              </li>
              ${plan.rejected.length
                ? html`<li class="paper-grid__warn">
                    ${plan.rejected.length} cell(s) left behind:
                    ${plan.rejected
                      .slice(0, 3)
                      .map((entry) => `row ${entry.rowIndex + 1} ${entry.column} (${entry.reason})`)
                      .join("; ")}
                  </li>`
                : nothing}
              ${candidates.length
                ? html`<li>
                    ${candidates.length} row(s) matched nothing.
                    ${creatable.length
                      ? html`<button
                          type="button"
                          class="btn btn--sm"
                          data-testid="paper-grid-import-create"
                          @click=${() => {
                            props.onCreatePapers?.(creatable);
                            state.notice = `Filing ${creatable.length} new paper(s).`;
                            props.onChange();
                          }}
                        >
                          Also create ${creatable.length}
                        </button>`
                      : nothing}
                    ${candidates.length > creatable.length
                      ? html`<span class="paper-grid__muted">
                          ${candidates.length - creatable.length} cannot be created yet — a new
                          paper needs a title, a short name and a start date
                        </span>`
                      : nothing}
                  </li>`
                : nothing}
            </ul>
          `
        : nothing}
    </div>
  `;
}

export function renderPaperGrid(props: PaperGridProps): TemplateResult {
  const { state, papers } = props;
  const changedRows = new Set(
    [...state.edits.entries()].filter(([, row]) => row.size > 0).map(([id]) => id),
  ).size;
  const errorCount = papers.reduce(
    (total, paper) =>
      total + COLUMNS.filter((column) => cellError(column, cellValue(state, paper, column))).length,
    0,
  );

  return html`
    <div
      class="paper-grid"
      @click=${() => {
        if (state.helpFor !== null) {
          state.helpFor = null;
          props.onChange();
        }
      }}
    >
      <div class="paper-grid__bar">
        <div>
          <strong>Bulk link entry</strong>
          <span class="paper-grid__muted">
            ${papers.length} papers · ${changedRows}
            changed${errorCount
              ? html` · <span class="paper-grid__warn">${errorCount} cell(s) need a look</span>`
              : nothing}
          </span>
        </div>
        <div class="paper-grid__tools">
          <button
            type="button"
            class="btn primary"
            ?disabled=${state.saving || changedRows === 0}
            @click=${() => props.onSaveAll(pendingSaves(state, papers))}
          >
            ${state.saving ? "Saving…" : `Update ${changedRows || ""}`.trim()}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            @click=${() => {
              state.showHistory = !state.showHistory;
              state.history = loadHistory();
              props.onChange();
            }}
          >
            History${state.history.length ? ` (${state.history.length})` : ""}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            data-testid="paper-grid-import-toggle"
            @click=${() => {
              state.importOpen = !state.importOpen;
              props.onChange();
            }}
          >
            Import a sheet
          </button>
          <button type="button" class="btn btn--sm" @click=${props.onExit}>Back to cards</button>
        </div>
      </div>

      ${state.notice ? html`<p class="paper-grid__notice">${state.notice}</p>` : nothing}
      ${state.importOpen ? renderImportPanel(props) : nothing}
      ${state.showHistory
        ? html`<div class="paper-grid__history">
            <div class="paper-grid__history-head">
              <strong>Recent changes</strong>
              <span class="paper-grid__muted">last ${HISTORY_LIMIT}, this browser only</span>
              <button
                type="button"
                class="btn btn--sm"
                ?disabled=${state.history.length === 0}
                @click=${() => {
                  clearHistory();
                  state.history = [];
                  props.onChange();
                }}
              >
                Clear
              </button>
            </div>
            ${state.history.length
              ? html`<ol class="paper-grid__history-list">
                  ${state.history.map(
                    (entry) => html`<li>
                      <span class="paper-grid__history-when">${formatWhen(entry.at)}</span>
                      <span class="paper-grid__history-paper">${entry.paperTitle}</span>
                      <span>${describeHistory(entry)}</span>
                    </li>`,
                  )}
                </ol>`
              : html`<p class="paper-grid__hint">
                  Nothing yet — changes are logged when you press Update.
                </p>`}
          </div>`
        : nothing}

      <div class="paper-grid__scroll">
        <table class="paper-grid__table" style=${`width:${tableWidth(state)}px`}>
          <!-- Fixed layout reads every width from here. Without it the browser sizes columns to
               their content and the longest title takes the window. -->
          <colgroup>
            <col class="paper-grid__col-rownum" style=${`width:${ROWNUM_WIDTH}px`} />
            <col data-key=${TITLE_COLUMN} style=${`width:${columnWidth(state, TITLE_COLUMN)}px`} />
            ${COLUMNS.map(
              (column) => html`<col
                data-key=${String(column.key)}
                style=${`width:${columnWidth(state, String(column.key))}px`}
              />`,
            )}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" class="paper-grid__rownum"></th>
              <th scope="col" class="paper-grid__sticky">
                Paper
                <span
                  class="paper-grid__resize"
                  title="Drag to resize"
                  @pointerdown=${(event: PointerEvent) =>
                    startResize(event, state, TITLE_COLUMN, props.onChange)}
                ></span>
              </th>
              ${COLUMNS.map(
                (column) => html`
                  <th scope="col">
                    ${column.save || column.apply
                      ? column.short
                      : html`${column.short}<span
                            class="paper-grid__pending"
                            title="Shown here, edited on the card"
                            >◦</span
                          >`}
                    ${renderColumnHelp(state, column, props.onChange)}
                    <span
                      class="paper-grid__resize"
                      title="Drag to resize"
                      @pointerdown=${(event: PointerEvent) =>
                        startResize(event, state, String(column.key), props.onChange)}
                    ></span>
                  </th>
                `,
              )}
            </tr>
          </thead>
          <tbody>
            ${papers.map(
              (paper, rowIndex) => html`
                <tr data-row=${rowIndex}>
                  <td class="paper-grid__rownum">${rowIndex + 1}</td>
                  <th scope="row" class="paper-grid__sticky" tabindex="0" title=${paper.title}>
                    <span class="paper-grid__title">${paper.title}</span>
                  </th>
                  ${COLUMNS.map((column, columnIndex) => {
                    const value = cellValue(state, paper, column);
                    const error = cellError(column, value);
                    return html`
                      <td class=${error ? "paper-grid__cell--bad" : ""}>
                        <div class="paper-grid__cell">
                          ${column.kind === "select"
                            ? html`<select
                                .value=${value}
                                title=${error ?? column.label}
                                data-row=${rowIndex}
                                data-col=${columnIndex}
                                @change=${(event: Event) => {
                                  setEdit(
                                    state,
                                    paper.id,
                                    String(column.key),
                                    (event.target as HTMLSelectElement).value,
                                  );
                                  props.onChange();
                                }}
                              >
                                ${(column.options ?? []).map(
                                  (option) => html`<option
                                    value=${option.value}
                                    ?selected=${option.value === value}
                                  >
                                    ${option.label}
                                  </option>`,
                                )}
                              </select>`
                            : html`<input
                                type=${column.kind === "date"
                                  ? "date"
                                  : column.kind === "number"
                                    ? "number"
                                    : "text"}
                                .value=${value}
                                ?disabled=${!column.save && !column.apply}
                                ?readonly=${column.kind === "readonly"}
                                title=${error ?? column.label}
                                data-row=${rowIndex}
                                data-col=${columnIndex}
                                @input=${(event: Event) => {
                                  setEdit(
                                    state,
                                    paper.id,
                                    String(column.key),
                                    (event.target as HTMLInputElement).value,
                                  );
                                }}
                                @blur=${() => props.onChange()}
                                @paste=${(event: ClipboardEvent) => {
                                  const text = event.clipboardData?.getData("text/plain") ?? "";
                                  // A single cell with no tabs or newlines is an ordinary paste; let
                                  // the browser handle it so undo keeps working.
                                  if (!text.includes("\t") && !text.includes("\n")) {
                                    return;
                                  }
                                  event.preventDefault();
                                  const filled = applyPaste(
                                    state,
                                    papers,
                                    rowIndex,
                                    columnIndex,
                                    text,
                                  );
                                  state.notice = `Pasted ${filled} cell(s). Nothing is saved until you press Update.`;
                                  props.onChange();
                                }}
                              />`}
                          ${column.save || column.apply
                            ? html`<span
                                class="paper-grid__fill"
                                title="Drag down to copy into the empty cells below — click to fill the whole column"
                                @pointerdown=${(event: PointerEvent) =>
                                  startFill(event, props, column, rowIndex)}
                              ></span>`
                            : nothing}
                        </div>
                      </td>
                    `;
                  })}
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

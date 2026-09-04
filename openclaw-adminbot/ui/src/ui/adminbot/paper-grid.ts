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
import type { AdminBotPaperStep } from "../../../../extensions/adminbot/src/contracts/actions.js";
import {
  adminBotPaperSlotRegistry,
  validateAdminBotPaperSlotUrl,
  type AdminBotPaperSlot,
} from "../../../../extensions/adminbot/src/contracts/paper-slots.js";
import type { AdminBotPaperRecord, AdminBotPaperSaveInput } from "./controllers/admin.ts";
import {
  columnIndexOf,
  COLUMN_GROUPS,
  COLUMNS,
  gridColumns,
  setBlockerAuthor,
  type Column,
  type ColumnGroup,
} from "./paper-columns.ts";
import {
  applyModelSuggestions,
  buildImportPlan,
  createCandidates,
  matchColumns,
  matchRows,
  parseSheet,
} from "./paper-import.ts";

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

// The registry moved to `paper-columns.ts`; the sheet stays its front door, so nothing that
// imports a column from here has to know that.
export {
  columnIndexOf,
  COLUMN_GROUPS,
  gridColumns,
  mergeAuthorLinks,
  parseVenueTargets,
  type Column,
  type ColumnGroup,
} from "./paper-columns.ts";

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

/**
 * How wide a column starts, by what it holds.
 *
 * One width for everything was right when every column was a URL. A date in a 200px box, next to
 * a yes/no in another 200px box, is most of why the sheet reads as emptier than it is -- and with
 * sixty columns the wasted pixels are the difference between four visible columns and seven.
 */
function defaultWidthFor(column: Column): number {
  switch (column.kind) {
    case "date":
      return 140;
    case "number":
      return 110;
    case "select":
      return 160;
    case "readonly":
      return 180;
    case "text":
      return 220;
    default:
      return DEFAULT_LINK_WIDTH;
  }
}

const DEFAULT_COLUMN_WIDTHS = new Map(
  COLUMNS.map((column) => [String(column.key), defaultWidthFor(column)] as const),
);

export function columnWidth(state: PaperGridState, key: string): number {
  return (
    state.widths.get(key) ??
    DEFAULT_WIDTHS[key] ??
    DEFAULT_COLUMN_WIDTHS.get(key) ??
    DEFAULT_LINK_WIDTH
  );
}

/**
 * The columns currently drawn: the ones whose band is switched on.
 *
 * Everything that measures, draws or addresses a cell by index goes through this rather than
 * `COLUMNS`, so a hidden band cannot leave the paste target pointing one column to the left.
 */
export function visibleColumns(state: PaperGridState): Column[] {
  return COLUMNS.filter((column) => state.groups.includes(column.group));
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
    visibleColumns(state).reduce(
      (total, column) => total + columnWidth(state, String(column.key)),
      0,
    )
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

/**
 * One evidence row, as much of it as the sheet reads.
 *
 * Declared structurally rather than imported from `auth/session.ts`: the grid draws slots, it does
 * not fetch them, and a type-only shape keeps this module a leaf on the wire layer.
 */
export type GridSlotRow = {
  slot: string;
  status: "missing" | "provided" | "invalid" | "waived";
  url?: string;
  value_text?: string;
  value_note?: string;
  invalid_reason?: string;
  waived_reason?: string;
};

/** Evidence by paper id, as the host has it loaded. Missing means "not fetched yet". */
export type GridCycles = Record<string, { slots: GridSlotRow[] }>;

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
  /** Which bands are switched on. Persisted, because it is a preference about a screen. */
  groups: ColumnGroup[];
  /**
   * The evidence rows currently on screen, copied off the props at the top of each render.
   *
   * A copy rather than a parameter on `cellValue`, because every reader of a cell -- the paste
   * path, the validator, the history diff, the tests -- would otherwise have to be handed the
   * same map to answer a question about one cell. It is refreshed on every render, so it is never
   * older than what the host holds.
   */
  cycles: GridCycles;
  /** Papers whose evidence has already been asked for, so a render cannot re-ask on every frame. */
  slotsRequested: Set<string>;
};

/**
 * Which bands are on when somebody opens the sheet for the first time.
 *
 * Everything except Evidence. The evidence columns are the only ones that cost a request per
 * paper to fill in -- they live in `paper_slots`, one fetch per row -- so a member who came to
 * paste Overleaf links should not pay thirty of those to see the sheet at all. The chip that
 * turns them on is in the toolbar, next to a count, so nothing is hidden about being hidden.
 */
const DEFAULT_GROUPS: ColumnGroup[] = ["project", "people", "venue", "decision", "links"];

const GROUPS_STORAGE_KEY = "adminbot.paper-grid.groups";

export function loadGroups(): ColumnGroup[] {
  try {
    const raw = globalThis.localStorage?.getItem(GROUPS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_GROUPS];
    }
    const known = COLUMN_GROUPS.map((group) => group.id);
    // Filtered against the registry and re-sorted into band order: a stored list from an older
    // build can name a band that no longer exists, and the order columns appear in is the
    // registry's, never the order somebody happened to tick them.
    return known.filter((id) => parsed.includes(id));
  } catch {
    return [...DEFAULT_GROUPS];
  }
}

export function saveGroups(groups: readonly ColumnGroup[]): void {
  try {
    globalThis.localStorage?.setItem(GROUPS_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // Storage denied or full. A forgotten band is not worth interrupting anyone over.
  }
}

export function emptyPaperGridState(): PaperGridState {
  return {
    edits: new Map(),
    saving: false,
    notice: "",
    showHistory: false,
    history: loadHistory(),
    widths: loadWidths(),
    helpFor: null,
    groups: loadGroups(),
    cycles: {},
    slotsRequested: new Set(),
  };
}

/** The stored evidence row behind a column, when the host has this paper's cycle loaded. */
export function slotRow(
  state: PaperGridState,
  paperId: string,
  column: Column,
): GridSlotRow | undefined {
  return column.slot
    ? state.cycles[paperId]?.slots.find((row) => row.slot === column.slot)
    : undefined;
}

/**
 * What a stored evidence row reads as in a cell.
 *
 * A `bool` gate is "yes" or blank, which is the same two answers its checkbox on the card gives.
 * Everything else is the value it holds.
 */
export function slotCellValue(column: Column, row: GridSlotRow | undefined): string {
  if (!row) {
    return "";
  }
  const definition = column.slot ? adminBotPaperSlotRegistry[column.slot] : undefined;
  if (definition?.kind === "bool") {
    return row.status === "provided" || row.status === "waived" ? "yes" : "";
  }
  if (definition?.kind === "link") {
    return row.url ?? "";
  }
  return row.value_text ?? "";
}

/**
 * What the record holds for a column, ignoring anything typed but unsaved.
 *
 * The other half of `cellValue`, and the one the history diff needs: "what was there before" has
 * to be answered from storage, never from the edit map.
 */
export function storedValue(
  state: PaperGridState,
  paper: AdminBotPaperRecord,
  column: Column,
): string {
  const stored = slotCellValue(column, slotRow(state, paper.id, column));
  if (stored) {
    return stored;
  }
  if (column.read) {
    return column.read(paper);
  }
  const artifacts = paper.artifacts as Record<string, string | undefined> | undefined;
  return artifacts?.[String(column.key)] ?? "";
}

/** What is currently in a cell: the pending edit if there is one, else what is stored. */
export function cellValue(
  state: PaperGridState,
  paper: AdminBotPaperRecord,
  column: Column,
): string {
  const edited = state.edits.get(paper.id)?.get(String(column.key));
  return edited === undefined ? storedValue(state, paper, column) : edited;
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
  // An evidence link is held to the registry's own rule, which is the same function the service
  // will apply on write. Checking it here means a bad host is marked in the cell rather than
  // coming back as one failed request out of forty.
  if (column.slot && adminBotPaperSlotRegistry[column.slot].kind === "link") {
    const checked = validateAdminBotPaperSlotUrl(column.slot, value);
    return checked.ok ? undefined : checked.reason;
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
  if (!source || !isWritable(column)) {
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
  // Indices are into what is on screen, not into the registry: with a band hidden the two differ,
  // and pasting into the registry's order would land every value one or more columns off.
  const columns = visibleColumns(state);
  const rows = clipboard.replace(/\r\n?/gu, "\n").replace(/\n$/u, "").split("\n");
  let filled = 0;
  rows.forEach((line, rowOffset) => {
    const paper = papers[startRow + rowOffset];
    if (!paper) {
      return; // pasted more rows than there are papers; the extra rows are dropped
    }
    line.split("\t").forEach((cell, columnOffset) => {
      const column = columns[startColumn + columnOffset];
      if (!column || !isWritable(column)) {
        return; // past the last column, or one that is shown but not editable here
      }
      setEdit(state, paper.id, String(column.key), cell.trim());
      filled += 1;
    });
  });
  return filled;
}

/**
 * Whether a cell can be typed in at all.
 *
 * Three ways a column earns it: it names a field on the save input, it rewrites the input itself,
 * or it is an evidence slot written through its own endpoint. `readonly` is the opposite of all
 * three and is what the two derived social gates and the blocker log are.
 */
export function isWritable(column: Column): boolean {
  if (column.kind === "readonly") {
    return false;
  }
  return Boolean(column.save || column.apply || column.slot);
}

/** One evidence write: the endpoint takes a slot at a time, so this is what a cell becomes. */
export type SlotWrite = {
  paperId: string;
  paperTitle: string;
  slot: AdminBotPaperSlot;
  column: Column;
  input: { url?: string; value_text?: string; done?: boolean };
  /** What is stored now, for the change log. */
  from: string;
  to: string;
};

/**
 * The evidence cells that changed, as one write each.
 *
 * Separate from `pendingSaves` because the destination is: a slot is a row in `paper_slots` and
 * goes through `PUT /papers/:id/slots/:slot`, which derives the status from the value rather than
 * accepting one. Both lists come off the same edit map and are sent by the same button, so a
 * person filling in a row does not have to know which half of the database a column lands in.
 *
 * A cell whose stored value already matches is dropped: re-sending it would restamp
 * `provided_by`/`provided_at` on evidence somebody else filed.
 */
export function pendingSlotWrites(
  state: PaperGridState,
  papers: AdminBotPaperRecord[],
): SlotWrite[] {
  const out: SlotWrite[] = [];
  for (const paper of papers) {
    const row = state.edits.get(paper.id);
    if (!row || row.size === 0) {
      continue;
    }
    for (const column of COLUMNS) {
      if (!column.slot || column.kind === "readonly") {
        continue;
      }
      const typed = row.get(String(column.key));
      if (typed === undefined || cellError(column, typed)) {
        continue;
      }
      const value = typed.trim();
      // A paper whose cycle has not loaded is skipped: without the stored row there is no way to
      // tell a change from a re-send, and re-sending restamps evidence somebody else filed. The
      // link columns still write their artifact half through `pendingSaves`, so nothing typed is
      // lost, and `unsentSlotEdits` below is what tells the person about the rest.
      if (!state.cycles[paper.id]) {
        continue;
      }
      const stored = slotRow(state, paper.id, column);
      if (slotCellValue(column, stored) === value) {
        continue;
      }
      const kind = adminBotPaperSlotRegistry[column.slot].kind;
      out.push({
        paperId: paper.id,
        paperTitle: paper.title,
        slot: column.slot,
        column,
        input:
          kind === "bool"
            ? { done: value === "yes" }
            : kind === "link"
              ? { url: value }
              : { value_text: value },
        from: slotCellValue(column, stored),
        to: value,
      });
    }
  }
  return out;
}

/**
 * Evidence typed against a paper whose slots never loaded.
 *
 * Counted rather than guessed at: these are the cells `pendingSlotWrites` had to leave behind, and
 * saying so is the difference between "the sheet dropped my ticks" and "those four papers have not
 * loaded yet".
 */
export function unsentSlotEdits(state: PaperGridState, papers: AdminBotPaperRecord[]): number {
  let count = 0;
  for (const paper of papers) {
    if (state.cycles[paper.id]) {
      continue;
    }
    const row = state.edits.get(paper.id);
    if (!row) {
      continue;
    }
    for (const column of COLUMNS) {
      // Only the evidence-only columns. A link column's typed value still reaches the record
      // through `pendingSaves`, so counting it here would report a loss that did not happen.
      if (!column.slot || column.save || column.kind === "readonly") {
        continue;
      }
      if (row.get(String(column.key)) !== undefined) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Empties the edit map, keeping only what could not be sent.
 *
 * Everything typed has just gone to one of the two endpoints, except the evidence cells
 * `pendingSlotWrites` had to leave behind: those are held so the next press sends them, once the
 * paper's slots have arrived. Clearing them along with the rest is what would make
 * "press Update again" a lie.
 */
export function clearSavedEdits(state: PaperGridState, papers: AdminBotPaperRecord[]): void {
  const kept: PaperGridEdits = new Map();
  for (const paper of papers) {
    const row = state.edits.get(paper.id);
    if (!row || state.cycles[paper.id]) {
      continue;
    }
    const stranded = new Map(
      [...row.entries()].filter(([key]) => {
        const column = COLUMNS.find((entry) => String(entry.key) === key);
        return column?.slot && !column.save && column.kind !== "readonly";
      }),
    );
    if (stranded.size > 0) {
      kept.set(paper.id, stranded);
    }
  }
  state.edits = kept;
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
      if (!isWritable(column)) {
        continue;
      }
      const typed = row.get(String(column.key));
      if (typed === undefined || cellError(column, typed)) {
        continue;
      }
      // Read the same way the cell does, minus the pending edit. Reading `artifacts[key]` was
      // right when every column was an artifact link; a title, a step or an evidence tick lives
      // somewhere else and would have logged every edit as "added", from blank.
      const before = storedValue(state, paper, column).trim();
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
  /**
   * The evidence rows the host has loaded, by paper id.
   *
   * Absent is not empty: it means this surface has no cycle wiring, and the evidence band says so
   * rather than showing twenty-five columns that would silently accept ticks and drop them.
   */
  slots?: GridCycles;
  /** Asks the host to fetch one paper's evidence. Called once per paper, when the band is open. */
  onLoadSlots?: (paperId: string) => void;
  /** Sends the evidence half of a save. One request per cell, which is what the endpoint takes. */
  onSaveSlots?: (writes: SlotWrite[]) => void;
  /** The signed-in member's name, for a blocker filed from a cell. */
  viewerName?: string;
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

/**
 * How many columns each band contributes, for the chips.
 *
 * Computed once: the registry does not change at runtime, and "Evidence (15)" is the fact that
 * makes a hidden band legible rather than a mystery.
 */
const GROUP_COUNTS = new Map(
  COLUMN_GROUPS.map(
    (group) => [group.id, COLUMNS.filter((column) => column.group === group.id).length] as const,
  ),
);

/** The bands, with the columns they draw and where they start, for the header's top row. */
function bandsOf(
  columns: readonly Column[],
): Array<{ id: ColumnGroup; label: string; span: number }> {
  const bands: Array<{ id: ColumnGroup; label: string; span: number }> = [];
  for (const column of columns) {
    const last = bands.at(-1);
    if (last?.id === column.group) {
      last.span += 1;
      continue;
    }
    bands.push({
      id: column.group,
      label: COLUMN_GROUPS.find((group) => group.id === column.group)?.label ?? column.group,
      span: 1,
    });
  }
  return bands;
}

/**
 * Asks the host for the evidence of every paper on screen, once each.
 *
 * Only while the band is open, and only for a paper whose cycle is not already loaded: the
 * endpoint is one request per paper, so a member who never opens Evidence sends none of them and
 * one who does sends each exactly once. Deferred out of the render pass, because a fetch that
 * resolves synchronously in a test would otherwise re-enter Lit mid-template.
 */
function requestEvidence(props: PaperGridProps): void {
  const { state, papers } = props;
  if (!props.onLoadSlots || !state.groups.includes("evidence")) {
    return;
  }
  const wanted = papers
    .filter((paper) => !state.cycles[paper.id] && !state.slotsRequested.has(paper.id))
    .map((paper) => paper.id);
  if (wanted.length === 0) {
    return;
  }
  for (const id of wanted) {
    state.slotsRequested.add(id);
  }
  queueMicrotask(() => {
    for (const id of wanted) {
      props.onLoadSlots?.(id);
    }
  });
}

export function renderPaperGrid(props: PaperGridProps): TemplateResult {
  const { state, papers } = props;
  // Refreshed every render: the host owns the evidence, the sheet only draws it. See the note on
  // `PaperGridState.cycles` for why it is copied rather than passed to every reader.
  state.cycles = props.slots ?? {};
  setBlockerAuthor(props.viewerName ?? "");
  requestEvidence(props);
  const columns = visibleColumns(state);
  const changedRows = new Set(
    [...state.edits.entries()].filter(([, row]) => row.size > 0).map(([id]) => id),
  ).size;
  const errorCount = papers.reduce(
    (total, paper) =>
      total + columns.filter((column) => cellError(column, cellValue(state, paper, column))).length,
    0,
  );
  const evidenceOn = state.groups.includes("evidence");
  const evidenceLoading =
    evidenceOn && papers.some((paper) => !state.cycles[paper.id]) && Boolean(props.onLoadSlots);

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
        <div class="paper-grid__heading">
          <strong>Every field, one row per paper</strong>
          <span class="paper-grid__muted">
            ${papers.length} papers · ${changedRows}
            changed${errorCount
              ? html` ·
                  <span class="paper-grid__warn">${errorCount} cell(s) need a look</span>`
              : nothing}
          </span>
        </div>
        <div class="paper-grid__tools">
          <button
            type="button"
            class="btn primary"
            ?disabled=${state.saving || changedRows === 0}
            @click=${() => {
              // Both halves of the row, from one press. The record fields go as one request per
              // paper; the evidence goes as one per cell, because that is what each endpoint
              // takes. Which half a column lands in is not the typist's problem.
              props.onSaveSlots?.(pendingSlotWrites(state, papers));
              props.onSaveAll(pendingSaves(state, papers));
            }}
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

      <div class="paper-grid__bands" role="group" aria-label="Which columns to show">
        ${COLUMN_GROUPS.map((group) => {
          const on = state.groups.includes(group.id);
          const unavailable = group.id === "evidence" && !props.onLoadSlots;
          return html`<button
            type="button"
            class=${`paper-grid__band ${on ? "is-on" : ""}`}
            data-band=${group.id}
            data-testid=${`paper-grid-band-${group.id}`}
            aria-pressed=${on ? "true" : "false"}
            ?disabled=${unavailable}
            title=${unavailable
              ? "This surface does not load evidence rows"
              : `Show or hide the ${group.label} columns`}
            @click=${(event: Event) => {
              event.stopPropagation();
              state.groups = on
                ? state.groups.filter((id) => id !== group.id)
                : COLUMN_GROUPS.map((entry) => entry.id).filter(
                    (id) => id === group.id || state.groups.includes(id),
                  );
              // Turning a band back on retries anything that failed to load while it was off.
              if (group.id === "evidence" && !on) {
                state.slotsRequested = new Set();
              }
              saveGroups(state.groups);
              props.onChange();
            }}
          >
            ${group.label}
            <span class="paper-grid__band-count">${GROUP_COUNTS.get(group.id) ?? 0}</span>
          </button>`;
        })}
        ${evidenceLoading
          ? html`<span class="paper-grid__muted" data-testid="paper-grid-evidence-loading"
              >loading evidence…</span
            >`
          : nothing}
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
                    (entry) =>
                      html`<li>
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
            ${columns.map(
              (column) =>
                html`<col
                  data-key=${String(column.key)}
                  style=${`width:${columnWidth(state, String(column.key))}px`}
                />`,
            )}
          </colgroup>
          <thead>
            <!-- The band row. Two header rows rather than one, because "Decision" over five
                 columns is what tells somebody they have left the venue's answer and arrived at
                 what it accepted -- a colour alone says they differ, not how. -->
            <tr class="paper-grid__band-row">
              <th scope="col" class="paper-grid__rownum"></th>
              <th scope="col" class="paper-grid__sticky"></th>
              ${bandsOf(columns).map(
                (band) =>
                  html`<th
                    scope="colgroup"
                    colspan=${band.span}
                    class="paper-grid__band-head"
                    data-band=${band.id}
                  >
                    ${band.label}
                  </th>`,
              )}
            </tr>
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
              ${columns.map(
                (column) => html`
                  <th scope="col" data-band=${column.group}>
                    ${isWritable(column)
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
                  ${columns.map((column, columnIndex) => {
                    const value = cellValue(state, paper, column);
                    const error = cellError(column, value);
                    const edited = state.edits.get(paper.id)?.has(String(column.key)) ?? false;
                    // An evidence column with no cycle loaded is not empty, it is unknown --
                    // and typing into it would look saved and then be dropped. See
                    // `pendingSlotWrites`.
                    const unloaded =
                      Boolean(column.slot) && !column.save && !state.cycles[paper.id];
                    const cellClass = [
                      error ? "paper-grid__cell--bad" : "",
                      edited ? "paper-grid__cell--edited" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return html`
                      <td class=${cellClass} data-band=${column.group}>
                        <div class="paper-grid__cell">
                          ${column.kind === "select"
                            ? html`<select
                                .value=${value}
                                ?disabled=${!isWritable(column) || unloaded}
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
                                  (option) =>
                                    html`<option
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
                                ?disabled=${!isWritable(column) || unloaded}
                                ?readonly=${column.kind === "readonly"}
                                placeholder=${unloaded ? "…" : ""}
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
                          ${isWritable(column) && !unloaded
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

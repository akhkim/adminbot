/**
 * The member roster as an editable grid, and the edits it produces as cells to write.
 *
 * The Membership tab shows the lab's own spreadsheet rather than a copy of it, because that sheet
 * is where Zhijing and the admins already work and where the onboarding and nudge sweeps read
 * from. Everything here is pure: reading the sheet and writing it back are the caller's business
 * (`readGogSheetRows` and a `sheet.update_cells` proposal), so the mapping between a cell an
 * administrator typed in and the A1 range that reaches Google can be tested on its own.
 */

/** Google's own limit: 26 letters, then AA. Column 0 is A. */
export function columnLetter(index: number): string {
  if (index < 0 || !Number.isInteger(index)) {
    throw new Error(`column index must be a non-negative integer, got ${index}`);
  }
  let remaining = index;
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return letters;
}

/**
 * A tab name only needs quoting when it is not a bare word, but quoting it always would break
 * nothing and reads worse in an approval card, so quote exactly when Sheets requires it.
 */
export function a1Range(tab: string, column: number, sheetRow: number): string {
  const name = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(tab) ? tab : `'${tab.replace(/'/gu, "''")}'`;
  return `${name}!${columnLetter(column)}${sheetRow}`;
}

export type SheetGrid = {
  /** Column headings, from the sheet's first row. */
  header: string[];
  /** Body rows, each tagged with the 1-based sheet row it came from. */
  rows: { sheetRow: number; cells: string[] }[];
};

/**
 * Splits a raw value matrix into a header and body rows carrying their true sheet row numbers.
 *
 * gog returns a ragged matrix -- trailing empty cells are omitted rather than padded -- so rows
 * are padded to the grid width. Without that, editing the last column of a sparse row writes to
 * whatever index happened to exist.
 *
 * The width is the widest row, not the header: the roster has columns past its last heading
 * that hold data, and a header-width grid dropped those cells from the page without a trace.
 * A column with no heading shows up under its letter instead.
 */
export function toSheetGrid(values: string[][], firstRow = 1): SheetGrid {
  const [header = [], ...body] = values;
  const width = Math.max(header.length, ...body.map((cells) => cells.length));
  return {
    header: Array.from({ length: width }, (_, column) => header[column] ?? ""),
    rows: body.map((cells, index) => ({
      sheetRow: firstRow + index + 1,
      cells: Array.from({ length: width }, (_, column) => cells[column] ?? ""),
    })),
  };
}

/** One cell an administrator changed in the grid. */
export type SheetCellEdit = {
  sheetRow: number;
  /** Zero-based column, matching `SheetGrid.header`. */
  column: number;
  value: string;
};

export type SheetValueRange = { range: string; values: string[][] };

export type SheetEditPlan = {
  updates: SheetValueRange[];
  /** What those cells hold now, so an approver sees what is being overwritten. */
  before: SheetValueRange[];
  /** Edits dropped because the grid's copy of the cell no longer matches the sheet. */
  conflicts: { sheetRow: number; column: number; expected: string; actual: string }[];
  /** Edits dropped because they changed nothing. */
  unchanged: SheetCellEdit[];
};

/**
 * Turns grid edits into the cells to write, refusing any whose ground has moved.
 *
 * `original` is the grid as it was read. Two people work in this sheet at once, so an edit is only
 * safe if the cell still holds what the editor was looking at when they typed: otherwise the write
 * silently reverts whatever the other person did in between. Those become conflicts for the caller
 * to re-read and re-present rather than a write that quietly wins.
 */
export function planSheetEdits(
  tab: string,
  edits: readonly SheetCellEdit[],
  original: SheetGrid,
  expected?: ReadonlyMap<string, string>,
): SheetEditPlan {
  const byRow = new Map(original.rows.map((row) => [row.sheetRow, row]));
  const updates: SheetValueRange[] = [];
  const before: SheetValueRange[] = [];
  const conflicts: SheetEditPlan["conflicts"] = [];
  const unchanged: SheetCellEdit[] = [];

  for (const edit of edits) {
    const row = byRow.get(edit.sheetRow);
    if (!row) {
      throw new Error(`edit names sheet row ${edit.sheetRow}, which the grid does not hold`);
    }
    if (edit.column < 0 || edit.column >= original.header.length) {
      throw new Error(
        `edit names column ${edit.column}, outside the sheet's ${original.header.length} columns`,
      );
    }
    const current = row.cells[edit.column] ?? "";
    const seen = expected?.get(`${edit.sheetRow}:${edit.column}`);
    if (seen !== undefined && seen !== current) {
      conflicts.push({
        sheetRow: edit.sheetRow,
        column: edit.column,
        expected: seen,
        actual: current,
      });
      continue;
    }
    if (edit.value === current) {
      unchanged.push(edit);
      continue;
    }
    const range = a1Range(tab, edit.column, edit.sheetRow);
    updates.push({ range, values: [[edit.value]] });
    before.push({ range, values: [[current]] });
  }

  return { updates, before, conflicts, unchanged };
}

/**
 * Columns the sheet poller refuses to let the spreadsheet own, by header name.
 *
 * Editing these in the grid is allowed -- an administrator asked for a grid over the whole sheet --
 * but they are the reason the write goes through the approval gate rather than straight out: a
 * privilege or membership change made by typing in a cell should be seen by a second person, and
 * the service re-checks them on the way back in regardless of what the sheet says.
 */
export const ACCESS_BEARING_HEADERS: readonly string[] = [
  "Member Type",
  "Email for correspondence (the more professional the better)",
  "Slack email",
  "Access rights",
];

/** Whether an edit set touches a column that decides who can reach what. */
export function touchesAccess(header: readonly string[], edits: readonly SheetCellEdit[]): boolean {
  return edits.some((edit) => ACCESS_BEARING_HEADERS.includes(header[edit.column] ?? ""));
}

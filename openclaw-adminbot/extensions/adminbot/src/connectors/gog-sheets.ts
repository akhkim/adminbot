// Row inserts in the middle of a Google Sheets tab, over the gog CLI.
//
// gog's first-class `sheets append` can only add rows after the last one, and a hand-kept tab
// that is ordered by year needs rows put *between* existing ones. The Sheets API does that with
// `spreadsheets.batchUpdate` (insertDimension, then the values), which gog has no command for, so
// this goes through `gog api call` the way the Slides connector does: each call pinned with
// --enable-commands-exact to the one method it makes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGogCaptureWith } from "./gog.js";

type GogCapture = (args: string[]) => Promise<string>;

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/** Rows to insert before the row now at 0-based index `at` (the header is row 0). */
export type SheetRowInsert = { at: number; rows: string[][] };

export type GogSheetInsertOptions = {
  env?: NodeJS.ProcessEnv;
  capture?: GogCapture;
  /**
   * The first 0-based column that is not written. Cells from here on are the tab's own: they are
   * never given values, and a per-row formula in a neighbouring row is copied into the new row.
   */
  writtenColumns: number;
};

function rootArgs(method: string, env: NodeJS.ProcessEnv | undefined, write: boolean): string[] {
  const args = ["--json", "--no-input", "--enable-commands-exact", `api.call,api.${method.toLowerCase()}`];
  const account = (env ?? process.env).GOG_ACCOUNT?.trim();
  if (account) {
    args.push("--account", account);
  }
  if (write) {
    args.push("--force");
  }
  return args;
}

function parseJson(output: string, what: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`gog returned non-JSON output for ${what}`);
  }
}

/**
 * The tab's cells as formulas rather than as what they display, so a formula column can be told
 * from a column of typed values. `range` is an A1 range with the tab title (`'Tab'!A:ZZ`).
 */
export async function readGogSheetFormulas(
  spreadsheetId: string,
  range: string,
  options: { env?: NodeJS.ProcessEnv; capture?: GogCapture } = {},
): Promise<string[][]> {
  const capture = options.capture ?? createGogCaptureWith({ env: options.env });
  const args = rootArgs("sheets.spreadsheets.values.get", options.env, false);
  args.push(
    "api",
    "call",
    "sheets",
    "v4",
    "sheets.spreadsheets.values.get",
    "--params",
    JSON.stringify({ spreadsheetId, range, valueRenderOption: "FORMULA" }),
    "--scope",
    SHEETS_SCOPE,
  );
  const parsed = parseJson(await capture(args), "spreadsheets.values.get") as { values?: unknown };
  const values = Array.isArray(parsed?.values) ? parsed.values : [];
  return values.map((row) =>
    Array.isArray(row) ? row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))) : [],
  );
}

// A column filled by one array formula extends itself into an inserted row; copying the formula
// that owns the array into a second row would collide with it and break the whole column.
const ARRAY_FORMULA = /^=\s*(?:arrayformula\s*\(|\{)/iu;

function isRowFormula(cell: string | undefined): boolean {
  return Boolean(cell?.startsWith("=")) && !ARRAY_FORMULA.test(cell!);
}

/** Contiguous [start, end) column runs, from `from` on, where the row holds a per-row formula. */
function formulaRuns(row: readonly string[] | undefined, from: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (let column = from; column < (row?.length ?? 0); column += 1) {
    if (!isRowFormula(row?.[column])) {
      continue;
    }
    const last = runs.at(-1);
    if (last && last[1] === column) {
      last[1] = column + 1;
    } else {
      runs.push([column, column + 1]);
    }
  }
  return runs;
}

function hasContent(row: readonly string[] | undefined): boolean {
  return Boolean(row?.some((cell) => cell.trim()));
}

/**
 * The batchUpdate requests for a set of inserts, applied in the order given.
 *
 * `inserts` must run bottom of the tab first (what `planAcceptanceInserts` returns), so an insert
 * never shifts a row a later one still refers to. `formulas` is the tab as `readGogSheetFormulas`
 * returns it, read before any insert.
 *
 * For each place:
 *  - `insertDimension` makes the rows. They take the formatting of the row above (the row below
 *    when the row above is the header), which is what typing a row in by hand would give.
 *  - `updateCells` writes the values as plain strings (`stringValue`, the API's RAW): a title
 *    beginning `=` stays text.
 *  - `copyPaste` with PASTE_FORMULA copies each per-row formula from that same neighbour into the
 *    new rows, relative references shifted onto them -- so a column that builds a CV entry from
 *    A:E builds one for the new paper too. Cells the neighbour holds as typed values are not
 *    copied, and array-formula columns are left to extend themselves.
 */
export function buildSheetInsertRequests(params: {
  sheetId: number;
  inserts: readonly SheetRowInsert[];
  formulas: readonly (readonly string[])[];
  writtenColumns: number;
}): unknown[] {
  const { sheetId, writtenColumns, formulas } = params;
  const requests: unknown[] = [];
  let previous = Number.POSITIVE_INFINITY;
  for (const insert of params.inserts) {
    if (insert.rows.length === 0) {
      continue;
    }
    if (!Number.isInteger(insert.at) || insert.at < 1 || insert.at >= previous) {
      throw new Error("sheet inserts must be below the header and ordered bottom first");
    }
    previous = insert.at;
    const count = insert.rows.length;
    const start = insert.at;
    const fromAbove = start > 1 && hasContent(formulas[start - 1]);
    requests.push({
      insertDimension: {
        range: { sheetId, dimension: "ROWS", startIndex: start, endIndex: start + count },
        inheritFromBefore: start > 1,
      },
    });
    requests.push({
      updateCells: {
        range: {
          sheetId,
          startRowIndex: start,
          endRowIndex: start + count,
          startColumnIndex: 0,
          endColumnIndex: writtenColumns,
        },
        rows: insert.rows.map((row) => ({
          values: Array.from({ length: writtenColumns }, (_, column) => ({
            userEnteredValue: { stringValue: row[column] ?? "" },
          })),
        })),
        fields: "userEnteredValue",
      },
    });
    // The neighbour as it stood before this insert, and where it sits after it.
    const template = fromAbove ? start - 1 : start;
    const templateNow = fromAbove ? start - 1 : start + count;
    for (const [from, to] of formulaRuns(formulas[template], writtenColumns)) {
      requests.push({
        copyPaste: {
          source: {
            sheetId,
            startRowIndex: templateNow,
            endRowIndex: templateNow + 1,
            startColumnIndex: from,
            endColumnIndex: to,
          },
          destination: {
            sheetId,
            startRowIndex: start,
            endRowIndex: start + count,
            startColumnIndex: from,
            endColumnIndex: to,
          },
          pasteType: "PASTE_FORMULA",
        },
      });
    }
  }
  return requests;
}

/**
 * Sends a batchUpdate. One API request, so the inserts all land or none do: a tab left with
 * empty inserted rows halfway down is worse than one that was not touched.
 */
export async function batchUpdateGogSheet(
  spreadsheetId: string,
  requests: readonly unknown[],
  options: { env?: NodeJS.ProcessEnv; capture?: GogCapture } = {},
): Promise<void> {
  if (requests.length === 0) {
    throw new Error("gog sheets batchUpdate refuses an empty request list");
  }
  const capture = options.capture ?? createGogCaptureWith({ env: options.env });
  // The body goes through a file, not argv: it holds every new row, and argv shows up in every
  // process listing on the box.
  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "adminbot-sheets-"));
  try {
    const bodyPath = path.join(scratch, "body.json");
    await fs.promises.writeFile(bodyPath, JSON.stringify({ requests }), {
      encoding: "utf8",
      mode: 0o600,
    });
    const args = rootArgs("sheets.spreadsheets.batchUpdate", options.env, true);
    args.push(
      "api",
      "call",
      "sheets",
      "v4",
      "sheets.spreadsheets.batchUpdate",
      "--params",
      JSON.stringify({ spreadsheetId }),
      "--body",
      `@${bodyPath}`,
      "--allow-write",
      "--scope",
      SHEETS_SCOPE,
    );
    parseJson(await capture(args), "spreadsheets.batchUpdate");
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  }
}

/** Reads the tab's formulas, then inserts the rows in one batchUpdate. */
export async function insertGogSheetRows(
  spreadsheetId: string,
  params: { sheetId: number; formulaRange: string; inserts: readonly SheetRowInsert[] },
  options: GogSheetInsertOptions,
): Promise<void> {
  const formulas = await readGogSheetFormulas(spreadsheetId, params.formulaRange, options);
  const requests = buildSheetInsertRequests({
    sheetId: params.sheetId,
    inserts: params.inserts,
    formulas,
    writtenColumns: options.writtenColumns,
  });
  await batchUpdateGogSheet(spreadsheetId, requests, options);
}

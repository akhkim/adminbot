/**
 * The lab's paper-acceptance tab: where it is, and the two things AdminBot does to it.
 *
 * Unlike the PaperList and PeopleList tabs, which the daily export owns and rewrites whole (see
 * docs/operations/daily-sheet-export.md), this tab is kept by people. So AdminBot only ever reads
 * it and inserts new rows into it, each where the year-and-conference order puts it: nothing a
 * person typed is rewritten, reordered or removed. Columns right of A:E (the CV entry the lab
 * builds with a formula) are the tab's own; a new row gets its neighbour's per-row formulas there,
 * never a value.
 *
 * Configured by ADMINBOT_ACCEPTANCE_SHEET_URL, the tab's URL out of the address bar. The gid in it
 * is required. A spreadsheet id alone would mean "the first tab", and the first tab of the lab's
 * spreadsheet is the member roster.
 *
 * The lab's own "Peer-Reviewed PaperAcceptance" tab is no longer kept by people: the six-hourly
 * sheet export (scripts/adminbot-acceptance-export.py) rebuilds and protects it. Leave the variable
 * unset for that tab; this insert path is for a tab people keep themselves.
 */
import { readGogSheetRows, readGogSheetTabs } from "../connectors/gog.js";
import { insertGogSheetRows, type SheetRowInsert } from "../connectors/gog-sheets.js";
import { parseSheetUrl } from "./member-sheet-config.js";

export type AcceptanceSheet = {
  /** Every row of the tab, header first. */
  read(): Promise<string[][]>;
  /**
   * Inserts rows before the rows now at each `at` (0-based, header 0), bottom of the tab first,
   * in one request. Never called with an empty list.
   */
  insert(inserts: SheetRowInsert[]): Promise<void>;
};

/** The five columns AdminBot writes: year, paper title, conference, authors, paper_link. */
const WRITTEN_COLUMNS = 5;

function quotedTitle(tabTitle: string): string {
  return `'${tabTitle.replaceAll("'", "''")}'`;
}

/** `'Tab name'!A:E`, with the quoting an A1 range needs for a title holding spaces or quotes. */
export function acceptanceRange(tabTitle: string): string {
  return `${quotedTitle(tabTitle)}!A:E`;
}

export function createAcceptanceSheet(
  env: NodeJS.ProcessEnv = process.env,
): AcceptanceSheet | undefined {
  const { spreadsheetId, gid } = parseSheetUrl(env.ADMINBOT_ACCEPTANCE_SHEET_URL);
  if (!spreadsheetId || gid === undefined) {
    return undefined;
  }
  // Resolved on every call rather than once: the title is what a person renames, and a cached one
  // would append to a tab that no longer exists under that name.
  const title = async (): Promise<string> => {
    const tab = (await readGogSheetTabs(spreadsheetId, { env })).find((entry) => entry.gid === gid);
    if (!tab) {
      throw new Error(`the spreadsheet has no tab with gid ${gid}`);
    }
    return tab.title;
  };
  return {
    read: async () => readGogSheetRows(spreadsheetId, { env, range: acceptanceRange(await title()) }),
    // The gid is the tab's sheetId, which is what batchUpdate addresses rows by.
    insert: async (inserts) =>
      insertGogSheetRows(
        spreadsheetId,
        { sheetId: gid, formulaRange: `${quotedTitle(await title())}!A:ZZ`, inserts },
        { env, writtenColumns: WRITTEN_COLUMNS },
      ),
  };
}

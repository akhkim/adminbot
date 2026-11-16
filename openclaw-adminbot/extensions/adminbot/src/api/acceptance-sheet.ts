/**
 * The lab's paper-acceptance tab: where it is, and the two things AdminBot does to it.
 *
 * Unlike the PaperList and PeopleList tabs, which the daily export owns and rewrites whole (see
 * docs/operations/daily-sheet-export.md), this tab is kept by people. So AdminBot only ever reads
 * it and appends rows to the end of it: nothing a person typed is rewritten, reordered or removed.
 *
 * Configured by ADMINBOT_ACCEPTANCE_SHEET_URL, the tab's URL out of the address bar. The gid in it
 * is required. A spreadsheet id alone would mean "the first tab", and the first tab of the lab's
 * spreadsheet is the member roster.
 */
import { appendGogSheetRows, readGogSheetRows, readGogSheetTabs } from "../connectors/gog.js";
import { parseSheetUrl } from "./member-sheet-config.js";

export type AcceptanceSheet = {
  /** Every row of the tab, header first. */
  read(): Promise<string[][]>;
  /** Adds rows after the last one. Never called with an empty list. */
  append(rows: string[][]): Promise<void>;
};

/** `'Tab name'!A:E`, with the quoting an A1 range needs for a title holding spaces or quotes. */
export function acceptanceRange(tabTitle: string): string {
  return `'${tabTitle.replaceAll("'", "''")}'!A:E`;
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
  const range = async (): Promise<string> => {
    const tab = (await readGogSheetTabs(spreadsheetId, { env })).find((entry) => entry.gid === gid);
    if (!tab) {
      throw new Error(`the spreadsheet has no tab with gid ${gid}`);
    }
    return acceptanceRange(tab.title);
  };
  return {
    read: async () => readGogSheetRows(spreadsheetId, { env, range: await range() }),
    append: async (rows) => appendGogSheetRows(spreadsheetId, rows, { env, range: await range() }),
  };
}

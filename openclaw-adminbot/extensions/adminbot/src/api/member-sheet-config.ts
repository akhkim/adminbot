/**
 * Which spreadsheet and which tab the Membership grid reads, and what to say when it cannot.
 *
 * Configuration accepts what an administrator actually has in front of them -- the URL out of the
 * browser's address bar, gid and all -- rather than only the pair of opaque strings the Sheets API
 * wants. A gid is the stable identity of a tab: it survives a rename, and it is the only thing in
 * that URL that says *which* tab. A tab title is what an A1 range takes. Nothing but the
 * spreadsheet itself can bridge the two, so when a gid is configured the title is resolved from
 * spreadsheet metadata at read time, with the configured title as the fallback for a lookup that
 * fails -- a metadata call that is down must not take the roster down with it.
 */
import { readGogSheetRows, readGogSheetTabs } from "../connectors/gog.js";
import type { MemberSheetSource } from "./server.member-sheet.js";

/**
 * The lab's own roster, which is the sheet this deployment exists to administer.
 *
 * Defaulted rather than required. Leaving it entirely to configuration meant a deployment that had
 * never set ADMINBOT_MEMBER_SHEET_ID answered the Membership grid with a 503 and the tab sat empty
 * -- which is what production did, because nothing ever set it. The environment still overrides,
 * so another lab, or a copy of the sheet to test edits against, is one variable away.
 */
export const DEFAULT_MEMBER_SHEET_ID = "1ZqdaRzev6fFHxGbaAn_NDAPgv-Wi-hklHrT5jB68m68";
export const DEFAULT_MEMBER_SHEET_TAB = "Full Slack Member List";
/** The "Full Slack Member List" tab of the sheet above, as of this writing. */
export const DEFAULT_MEMBER_SHEET_GID = 764749323;

export type MemberSheetConfig = {
  spreadsheetId: string;
  /** The tab title to read, and the fallback when a gid cannot be resolved to one. */
  tab: string;
  /** Resolved to a tab title at read time when set. */
  gid?: number;
};

export type ParsedSheetUrl = { spreadsheetId?: string; gid?: number };

/**
 * The spreadsheet id and gid out of a Google Sheets URL.
 *
 * The gid lives in the fragment (`#gid=1`) on a link copied from the tab bar and in the query
 * (`?gid=1`) on one copied from a share dialog, so both are read.
 */
export function parseSheetUrl(url: string | undefined): ParsedSheetUrl {
  const value = (url ?? "").trim();
  if (!value) {
    return {};
  }
  const id = /\/spreadsheets\/d\/(?:e\/)?([a-zA-Z0-9_-]+)/u.exec(value)?.[1];
  const gid = /[#?&]gid=(\d+)/u.exec(value)?.[1];
  return {
    ...(id ? { spreadsheetId: id } : {}),
    ...(gid ? { gid: Number(gid) } : {}),
  };
}

/**
 * The tab name out of a `Tab!A:Z` range.
 *
 * ADMINBOT_MEMBER_SHEET_RANGE predates this grid -- the sheet poller reads the roster through it --
 * so a deployment that already names its tab there should not have to name it a second time.
 */
export function tabFromRange(range: string | undefined): string | undefined {
  const separator = (range ?? "").lastIndexOf("!");
  if (separator < 0) {
    return undefined;
  }
  const tab = (range ?? "")
    .slice(0, separator)
    .trim()
    .replace(/^'(.*)'$/su, "$1")
    .replaceAll("''", "'");
  return tab || undefined;
}

function positiveGid(value: string | undefined): number | undefined {
  const trimmed = (value ?? "").trim();
  return /^\d+$/u.test(trimmed) ? Number(trimmed) : undefined;
}

/**
 * Reads the member-sheet configuration out of the environment.
 *
 * Precedence, tightest first: an explicit id or gid beats one parsed out of
 * ADMINBOT_MEMBER_SHEET_URL, which beats the lab's own defaults. The default gid applies only to
 * the default spreadsheet -- a gid is meaningless against a different file, and silently reading
 * whatever tab happens to carry that number in someone's copy would be worse than reading none.
 *
 * An explicitly named tab wins over gid resolution: an operator who spelled a title meant that
 * title. Everything else resolves the gid, which is what makes a renamed tab fix itself.
 */
export function resolveMemberSheetConfig(env: NodeJS.ProcessEnv): MemberSheetConfig {
  const fromUrl = parseSheetUrl(env.ADMINBOT_MEMBER_SHEET_URL);
  const spreadsheetId =
    env.ADMINBOT_MEMBER_SHEET_ID?.trim() || fromUrl.spreadsheetId || DEFAULT_MEMBER_SHEET_ID;
  const explicitTab = env.ADMINBOT_MEMBER_SHEET_TAB?.trim();
  const tab =
    explicitTab ||
    tabFromRange(env.ADMINBOT_MEMBER_SHEET_RANGE?.trim()) ||
    DEFAULT_MEMBER_SHEET_TAB;
  const configuredGid = positiveGid(env.ADMINBOT_MEMBER_SHEET_GID) ?? fromUrl.gid;
  const gid =
    configuredGid ??
    (spreadsheetId === DEFAULT_MEMBER_SHEET_ID ? DEFAULT_MEMBER_SHEET_GID : undefined);
  if (gid === undefined || (explicitTab && configuredGid === undefined)) {
    return { spreadsheetId, tab };
  }
  return { spreadsheetId, tab, gid };
}

export type MemberSheetSourceDeps = {
  readRows?: (spreadsheetId: string, range: string) => Promise<string[][]>;
  readTabs?: (spreadsheetId: string) => Promise<{ title: string; gid: number }[]>;
};

export function memberSheetSource(
  config: MemberSheetConfig,
  deps: MemberSheetSourceDeps = {},
): MemberSheetSource {
  const readRows =
    deps.readRows ?? ((spreadsheetId, range) => readGogSheetRows(spreadsheetId, { range }));
  const readTabs = deps.readTabs ?? ((spreadsheetId) => readGogSheetTabs(spreadsheetId));
  const gid = config.gid;
  return {
    spreadsheetId: config.spreadsheetId,
    tab: config.tab,
    ...(gid === undefined
      ? {}
      : {
          resolveTab: async () => {
            try {
              const tabs = await readTabs(config.spreadsheetId);
              const match = tabs.find((entry) => entry.gid === gid);
              // An unresolvable gid falls back to the configured title rather than failing: the
              // title is right far more often than not, and a wrong one produces a much better
              // error from the read itself than "could not list the tabs" does.
              return { tab: match?.title ?? config.tab, gid };
            } catch {
              return { tab: config.tab, gid };
            }
          },
        }),
    read: (range) => readRows(config.spreadsheetId, range),
  };
}

/**
 * The sentence the Membership tab shows when a read of the roster fails.
 *
 * All three failures below arrive as one opaque `gog command failed: <stderr>` string, and the grid
 * used to print it verbatim -- which told an administrator that something Google-shaped went wrong
 * and nothing about which of the three things they can actually fix it was. Each arm names the fix.
 */
export function describeMemberSheetReadFailure(
  error: unknown,
  source: { spreadsheetId: string; tab: string },
): string {
  const detail = error instanceof Error ? error.message : String(error);
  const lowered = detail.toLowerCase();
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${source.spreadsheetId}/edit`;
  if (lowered.includes("unable to parse range") || lowered.includes("range not found")) {
    return `the spreadsheet has no tab named "${source.tab}" (${sheetUrl}) -- rename it back, or point ADMINBOT_MEMBER_SHEET_GID/_URL at the tab that holds the roster: ${detail}`;
  }
  if (
    lowered.includes("permission") ||
    lowered.includes("forbidden") ||
    lowered.includes("403") ||
    lowered.includes("does not have access")
  ) {
    return `AdminBot's Google account cannot open the member spreadsheet (${sheetUrl}) -- share the sheet with it: ${detail}`;
  }
  if (lowered.includes("not found") || lowered.includes("404")) {
    return `no spreadsheet with id ${source.spreadsheetId} (${sheetUrl}) -- check ADMINBOT_MEMBER_SHEET_ID/_URL: ${detail}`;
  }
  if (
    lowered.includes("invalid_grant") ||
    lowered.includes("expired") ||
    lowered.includes("revoked")
  ) {
    return `AdminBot's Google token is no longer valid -- re-run \`gog auth add\` on the host: ${detail}`;
  }
  return `could not read the member sheet: ${detail}`;
}

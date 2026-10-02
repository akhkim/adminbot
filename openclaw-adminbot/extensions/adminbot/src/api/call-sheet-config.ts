/**
 * Which spreadsheet and tab the WhatsApp call queue is pushed to.
 *
 * The same file as the member roster -- it is one workbook with many tabs -- so this reuses
 * `memberSheetSource`, which is generic over `{ spreadsheetId, tab, gid }` despite its name.
 *
 * The gid is the authoritative half and the title is only a fallback, which matters more here than
 * it does for the roster: nobody on this end has read the tab bar, so `DEFAULT_CALL_SHEET_TAB` is
 * a guess at a title that has never been confirmed. That is safe only because it cannot cause a
 * wrong write -- `locateCallSheet` refuses any tab that does not carry the call-request headings,
 * so a fallback that lands somewhere else produces a refusal rather than a row in the wrong place.
 */
import { type MemberSheetConfig, memberSheetSource, parseSheetUrl } from "./member-sheet-config.js";
import { DEFAULT_MEMBER_SHEET_ID } from "./member-sheet-config.js";
import type { MemberSheetSource } from "./server.member-sheet.js";

/** The lab workbook, same file the roster lives in. */
export const DEFAULT_CALL_SHEET_ID = DEFAULT_MEMBER_SHEET_ID;
/** The additional-WhatsApp-call-requests tab of that workbook. Authoritative. */
export const DEFAULT_CALL_SHEET_GID = 1633153118;
/** Fallback title only, used when tab metadata cannot be read. See the header. */
export const DEFAULT_CALL_SHEET_TAB = "Whatsapp call requests";

export type CallSheetSource = MemberSheetSource;

function positiveGid(value: string | undefined): number | undefined {
  const trimmed = (value ?? "").trim();
  return /^\d+$/u.test(trimmed) ? Number(trimmed) : undefined;
}

/**
 * Reads the call-sheet configuration out of the environment.
 *
 * Same precedence as the roster's: explicit id or gid, then a pasted URL, then the lab's defaults.
 * The default gid applies only to the default workbook, because a gid means nothing against a
 * different file.
 */
export function resolveCallSheetConfig(env: NodeJS.ProcessEnv): MemberSheetConfig {
  const fromUrl = parseSheetUrl(env.ADMINBOT_CALL_SHEET_URL);
  const spreadsheetId =
    env.ADMINBOT_CALL_SHEET_ID?.trim() || fromUrl.spreadsheetId || DEFAULT_CALL_SHEET_ID;
  const explicitTab = env.ADMINBOT_CALL_SHEET_TAB?.trim();
  const tab = explicitTab || DEFAULT_CALL_SHEET_TAB;
  const configuredGid = positiveGid(env.ADMINBOT_CALL_SHEET_GID) ?? fromUrl.gid;
  const gid =
    configuredGid ?? (spreadsheetId === DEFAULT_CALL_SHEET_ID ? DEFAULT_CALL_SHEET_GID : undefined);
  if (gid === undefined || (explicitTab && configuredGid === undefined)) {
    return { spreadsheetId, tab };
  }
  return { spreadsheetId, tab, gid };
}

export function defaultCallSheet(env: NodeJS.ProcessEnv): CallSheetSource {
  return memberSheetSource(resolveCallSheetConfig(env));
}

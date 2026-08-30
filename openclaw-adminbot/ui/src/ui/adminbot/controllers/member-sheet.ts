// The Membership tab's grid over the lab's member spreadsheet: load it, edit cells, save the
// edits as one approval item, and onboard a selection.
//
// Split out of admin.ts, which is already over the size gate.
import {
  fetchMemberSheet as fetchMemberSheetRequest,
  loadStoredMemberSession,
  type MemberSheetEditResult,
  type MemberSheetOnboardResult,
  type MemberSheetView,
  onboardFromMemberSheet as onboardFromMemberSheetRequest,
  proposeMemberSheetEdits as proposeMemberSheetEditsRequest,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";
import type { UiSettings } from "../../settings.ts";

/**
 * The Membership grid over the lab's member spreadsheet.
 *
 * `sheetEdits` holds only what the operator has actually changed, keyed "row:column", so an edit
 * to one cell never rewrites the row around it. `sheetBaseline` is what those cells held when the
 * grid was drawn: it travels with the save so the service can refuse a write against a cell
 * somebody else changed in Google since, rather than silently reverting them.
 */
export type AdminBotMemberSheetHost = {
  memberSheet?: MemberSheetView | null;
  memberSheetBusy?: boolean;
  memberSheetError?: string | null;
  memberSheetEdits?: Record<string, string>;
  memberSheetBaseline?: Record<string, string>;
  memberSheetSelection?: number[];
  memberSheetSaveResult?: MemberSheetEditResult | null;
  memberSheetOnboardResult?: MemberSheetOnboardResult | null;
  settings: UiSettings;
};

export function memberSheetCellKey(sheetRow: number, column: number): string {
  return `${sheetRow}:${column}`;
}

export async function loadMemberSheet(host: AdminBotMemberSheetHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.memberSheetError = "Sign in again to read the member sheet.";
    return;
  }
  host.memberSheetBusy = true;
  host.memberSheetError = null;
  try {
    const result = await fetchMemberSheetRequest(
      stored.token,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.memberSheetError = describeMemberSheetFailure(result);
      return;
    }
    host.memberSheet = result.value;
    // A reload is the answer to a conflict, so it must not leave the edits that caused one
    // sitting over freshly-read cells.
    host.memberSheetEdits = {};
    host.memberSheetBaseline = {};
    host.memberSheetSaveResult = null;
  } finally {
    host.memberSheetBusy = false;
  }
}

/** Records one cell edit, remembering what it was overwriting the first time it is touched. */
export function editMemberSheetCell(
  host: AdminBotMemberSheetHost,
  sheetRow: number,
  column: number,
  value: string,
): void {
  const key = memberSheetCellKey(sheetRow, column);
  const original =
    host.memberSheet?.rows.find((row) => row.sheet_row === sheetRow)?.cells[column] ?? "";
  const baseline = { ...host.memberSheetBaseline };
  if (!(key in baseline)) {
    baseline[key] = original;
  }
  const edits = { ...host.memberSheetEdits };
  if (value === original) {
    // Typing a cell back to what it was is not an edit, and should not hold up a save.
    delete edits[key];
    delete baseline[key];
  } else {
    edits[key] = value;
  }
  host.memberSheetEdits = edits;
  host.memberSheetBaseline = baseline;
}

export async function saveMemberSheetEdits(host: AdminBotMemberSheetHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.memberSheetError = "Sign in again to edit the member sheet.";
    return;
  }
  const edits = Object.entries(host.memberSheetEdits ?? {}).map(([key, value]) => {
    const [row, column] = key.split(":");
    return { sheet_row: Number(row), column: Number(column), value };
  });
  if (edits.length === 0) {
    return;
  }
  host.memberSheetBusy = true;
  host.memberSheetError = null;
  try {
    const result = await proposeMemberSheetEditsRequest(
      edits,
      host.memberSheetBaseline ?? {},
      stored.token,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.memberSheetError = describeMemberSheetFailure(result);
      return;
    }
    host.memberSheetSaveResult = result.value;
    // Cells that made it into a proposal are settled; the ones that conflicted stay pending so
    // the operator can see their value against the newer one and decide.
    if (result.value.conflicts.length === 0) {
      host.memberSheetEdits = {};
      host.memberSheetBaseline = {};
    } else {
      const conflicted = new Set(
        result.value.conflicts.map((conflict) =>
          memberSheetCellKey(conflict.sheet_row, conflict.column),
        ),
      );
      host.memberSheetEdits = Object.fromEntries(
        Object.entries(host.memberSheetEdits ?? {}).filter(([key]) => conflicted.has(key)),
      );
    }
  } finally {
    host.memberSheetBusy = false;
  }
}

export async function onboardSelectedMemberRows(host: AdminBotMemberSheetHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.memberSheetError = "Sign in again to onboard from the member sheet.";
    return;
  }
  const rows = host.memberSheetSelection ?? [];
  if (rows.length === 0) {
    return;
  }
  host.memberSheetBusy = true;
  host.memberSheetError = null;
  try {
    const result = await onboardFromMemberSheetRequest(
      rows,
      {},
      stored.token,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      host.memberSheetError = describeMemberSheetFailure(result);
      return;
    }
    host.memberSheetOnboardResult = result.value;
    // Only clear the rows that produced something; a skipped row stays selected so its reason
    // stays next to it and a second press after filling a gap does not need re-selecting.
    const created = new Set(result.value.created.map((entry) => entry.sheet_row));
    host.memberSheetSelection = rows.filter((row) => !created.has(row));
  } finally {
    host.memberSheetBusy = false;
  }
}

function describeMemberSheetFailure(result: { kind?: string; message?: string }): string {
  if (result.message) {
    return result.message;
  }
  switch (result.kind) {
    case "unreachable":
      return "AdminBot is unreachable.";
    case "forbidden":
      return "You need an admin session to work with the member sheet.";
    default:
      return "The member sheet could not be reached.";
  }
}

/**
 * Turning an approved `book_meeting` request into a row on Zhijing's WhatsApp call sheet.
 *
 * The sheet is hers and people are already working in it by hand, which sets every constraint in
 * this file. Three of them are worth stating outright.
 *
 * It is addressed by header text, never by column letter. The tab's own headings carry a typo
 * ("tto receive calls") and a column has already been added to the right of the ones we fill
 * ("Zhijing's actual meeting with you"), so a hardcoded `A:H` would be one insertion away from
 * writing a member's city into her notes. Every field here finds its column by matching the
 * heading that is actually in the sheet at the moment of the write.
 *
 * It only ever fills blank rows. There is no "append after the last row" here, because the block
 * does not end at its last entry -- it ends at a `Finished calls` marker with spare rows above it,
 * and appending past that would write into her archive. When the spare rows run out this reports
 * an overflow rather than finding somewhere to put the row.
 *
 * And it proposes rather than writes. What comes back is a `sheet.update_cells` payload for the
 * approval gate, per the standing rule that nothing reaches Google without passing it.
 */
import type { AdminBotSheetValueRange } from "../../contracts/actions.js";
import { a1Range } from "../members/member-sheet-grid.js";
import { type DocPrepLinkVerdict, isPushableDocPrep } from "./doc-prep-link.js";

/** The columns this file knows how to fill. Deliberately not every column on the tab. */
export type CallSheetField =
  | "name"
  | "topics"
  | "city"
  | "doc_prep"
  | "whatsapp_hello"
  | "min_length"
  | "latest_ok"
  | "entered_at";

/**
 * How each field recognizes its heading.
 *
 * Substring matching on a squashed lowercase form, because the headings are whole sentences that
 * have already been edited once and will be again. Anchored on the part of each heading that
 * carries its meaning -- "doc prep", "until when" -- so rewording the rest costs nothing.
 */
const HEADER_MATCHERS: Record<CallSheetField, (heading: string) => boolean> = {
  name: (h) => h === "name",
  topics: (h) => h.includes("what topics"),
  city: (h) => h.includes("current city"),
  doc_prep: (h) => h.includes("doc prep"),
  whatsapp_hello: (h) => h.includes("whatsapp") && (h.includes("hello") || h.includes("messaged")),
  min_length: (h) => h.includes("min_length") || (h.includes("min") && h.includes("length")),
  latest_ok: (h) => h.includes("until when"),
  entered_at: (h) => h.includes("time you entered"),
};

/** Without these four a row is not a call request, so a tab missing any of them is the wrong tab. */
const REQUIRED_FIELDS: readonly CallSheetField[] = ["name", "topics", "doc_prep", "entered_at"];

/** Squashes a heading to the form the matchers are written against. */
function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

/** The row that closes the live block. Everything at or below it is Zhijing's archive. */
function isFinishedMarker(cells: readonly string[]): boolean {
  return cells.some((cell) => normalize(cell).startsWith("finished call"));
}

export type CallSheetLayout = {
  /** 1-based sheet row of the heading row. */
  header_row: number;
  columns: Record<CallSheetField, number>;
  /** 1-based sheet rows, in order, that are free to fill. */
  open_rows: number[];
  /** 1-based rows holding live requests, used to avoid queueing the same ask twice. */
  filled_rows: number[];
};

export type CallSheetLocation =
  | { ok: true; layout: CallSheetLayout }
  | { ok: false; reason: string };

/**
 * Finds the call-request block inside a whole-tab read.
 *
 * `values` is the raw `A1:ZZ` grid, so `values[0]` is sheet row 1 and a short row means trailing
 * empties rather than missing columns -- Sheets truncates, and every read here has to tolerate it.
 */
export function locateCallSheet(values: readonly (readonly string[])[]): CallSheetLocation {
  let headerIndex = -1;
  let columns: Partial<Record<CallSheetField, number>> = {};

  for (let row = 0; row < values.length; row += 1) {
    const cells = values[row] ?? [];
    const found: Partial<Record<CallSheetField, number>> = {};
    for (let column = 0; column < cells.length; column += 1) {
      const heading = normalize(cells[column] ?? "");
      if (!heading) {
        continue;
      }
      for (const field of Object.keys(HEADER_MATCHERS) as CallSheetField[]) {
        // First match wins: the note row above the headings also mentions the doc prep column, and
        // a later re-match would move a column onto prose.
        if (found[field] === undefined && HEADER_MATCHERS[field](heading)) {
          found[field] = column;
        }
      }
    }
    if (REQUIRED_FIELDS.every((field) => found[field] !== undefined)) {
      headerIndex = row;
      columns = found;
      break;
    }
  }

  if (headerIndex < 0) {
    return {
      ok: false,
      reason: "no call-request heading row found on that tab (looked for Name / topics / doc prep)",
    };
  }

  // The block runs from under the headings to the archive marker, or to the end of the used range.
  let endIndex = values.length;
  for (let row = headerIndex + 1; row < values.length; row += 1) {
    if (isFinishedMarker(values[row] ?? [])) {
      endIndex = row;
      break;
    }
  }

  const mapped = Object.values(columns) as number[];
  const open: number[] = [];
  const filled: number[] = [];
  for (let row = headerIndex + 1; row < endIndex; row += 1) {
    const cells = values[row] ?? [];
    // Emptiness is judged across the whole row, not just our columns: a row carrying only a note in
    // the column Zhijing keeps for herself is still a row somebody is using.
    const blank = cells.every((cell) => !cell.trim());
    if (blank) {
      open.push(row + 1);
    } else if (mapped.some((column) => (cells[column] ?? "").trim())) {
      filled.push(row + 1);
    }
  }

  return {
    ok: true,
    layout: {
      header_row: headerIndex + 1,
      columns: columns as Record<CallSheetField, number>,
      open_rows: open,
      filled_rows: filled,
    },
  };
}

/** One request, flattened to the shape the sheet wants. */
export type CallRequestEntry = {
  /** The AdminBot request id, carried through so the audit trail can join the two sides. */
  request_id: string;
  member_name: string;
  purpose: string;
  city?: string;
  timezone?: string;
  length_minutes?: number;
  latest_ok_date?: string;
  whatsapp_hello?: boolean;
  submitted_at: string;
  doc_prep: DocPrepLinkVerdict;
};

/** yyyy-mm-dd, which is how every dated cell already in the sheet reads. */
function isoDate(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString().slice(0, 10);
}

/**
 * The cell values for one entry.
 *
 * The doc prep cell gets the canonical link the probe actually opened, not the string the member
 * pasted: the pasted one carries a `#0de1bd` fragment naming the sharer's own cursor position, and
 * what belongs in a column Zhijing clicks is the URL that was verified to answer.
 */
export function callRequestCells(entry: CallRequestEntry): Record<CallSheetField, string> {
  const location = (entry.city ?? "").trim() || (entry.timezone ?? "").trim();
  return {
    name: entry.member_name.trim(),
    topics: entry.purpose.trim(),
    city: location,
    doc_prep: entry.doc_prep.status === "ok" ? entry.doc_prep.url : "",
    whatsapp_hello: entry.whatsapp_hello === undefined ? "" : entry.whatsapp_hello ? "Yes" : "No",
    min_length: entry.length_minutes ? `${entry.length_minutes} min` : "",
    latest_ok: entry.latest_ok_date ? entry.latest_ok_date : "",
    entered_at: isoDate(entry.submitted_at),
  };
}

/** Why an entry did not make it onto the sheet. */
export type CallRequestSkip = {
  request_id: string;
  member_name: string;
  reason: "doc_prep_invalid" | "already_on_sheet" | "no_open_row";
  detail: string;
};

export type CallRequestPlan = {
  updates: AdminBotSheetValueRange[];
  /** What those cells hold now, so the approval card can show it is writing into blanks. */
  before: AdminBotSheetValueRange[];
  placed: { request_id: string; member_name: string; sheet_row: number }[];
  skipped: CallRequestSkip[];
};

/**
 * Plans the write for a batch of requests.
 *
 * Order of the three refusals matters and is the order a person would apply them: an unopenable
 * doc prep link is not a row at all; a request already sitting in the block is not a second row;
 * and only then can the block run out of space. Getting this backwards would report "no room" for
 * rows that were never going to be written.
 */
export function planCallRequestAppend(
  tab: string,
  values: readonly (readonly string[])[],
  entries: readonly CallRequestEntry[],
): CallRequestPlan | { error: string } {
  const located = locateCallSheet(values);
  if (!located.ok) {
    return { error: located.reason };
  }
  const { columns, open_rows, filled_rows } = located.layout;

  // Name + topics is what a duplicate looks like from the sheet's side: the request id is ours and
  // was never written into a column, so there is nothing sharper to match on.
  const existing = new Set(
    filled_rows.map((sheetRow) => {
      const cells = values[sheetRow - 1] ?? [];
      return `${normalize(cells[columns.name] ?? "")} ${normalize(cells[columns.topics] ?? "")}`;
    }),
  );

  const updates: AdminBotSheetValueRange[] = [];
  const before: AdminBotSheetValueRange[] = [];
  const placed: CallRequestPlan["placed"] = [];
  const skipped: CallRequestSkip[] = [];
  const free = [...open_rows];

  for (const entry of entries) {
    if (!isPushableDocPrep(entry.doc_prep)) {
      skipped.push({
        request_id: entry.request_id,
        member_name: entry.member_name,
        reason: "doc_prep_invalid",
        detail: entry.doc_prep.status,
      });
      continue;
    }
    const cells = callRequestCells(entry);
    const key = `${normalize(cells.name)} ${normalize(cells.topics)}`;
    if (existing.has(key)) {
      skipped.push({
        request_id: entry.request_id,
        member_name: entry.member_name,
        reason: "already_on_sheet",
        detail: "a row with this name and topic is already in the queue",
      });
      continue;
    }
    const sheetRow = free.shift();
    if (sheetRow === undefined) {
      skipped.push({
        request_id: entry.request_id,
        member_name: entry.member_name,
        reason: "no_open_row",
        detail: "no blank row left above the Finished calls marker; add rows to the tab",
      });
      continue;
    }

    // One range per cell rather than one per row: the filled columns are not contiguous once a
    // column has been inserted between them, and a single wide range would blank whatever sits in
    // the gap -- including the column Zhijing keeps her own notes in.
    const current = values[sheetRow - 1] ?? [];
    for (const field of Object.keys(cells) as CallSheetField[]) {
      const column = columns[field];
      if (column === undefined) {
        continue;
      }
      const value = cells[field];
      if (!value) {
        continue;
      }
      updates.push({
        range: a1Range(tab, column, sheetRow),
        values: [[value]],
      });
      before.push({
        range: a1Range(tab, column, sheetRow),
        values: [[current[column] ?? ""]],
      });
    }
    existing.add(key);
    placed.push({
      request_id: entry.request_id,
      member_name: entry.member_name,
      sheet_row: sheetRow,
    });
  }

  return { updates, before, placed, skipped };
}

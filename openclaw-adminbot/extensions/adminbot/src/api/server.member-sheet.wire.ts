import type { MemberSheetView } from "./server.member-sheet.js";

/**
 * The Membership grid as it goes over the wire: each row without its trailing empty cells.
 *
 * The grid is padded to the header's width so every row lines up with its column, which on a
 * 30-column roster where most people fill a handful means most of every row is `""`. The page pads
 * the rows back to the header before it draws or diffs anything (ui api/onboarding.ts), so an edit
 * still compares against the same cell it did; only the empty tail is not sent.
 */
export function memberSheetWire(view: MemberSheetView): MemberSheetView {
  return {
    ...view,
    rows: view.rows.map((row) => ({
      sheet_row: row.sheet_row,
      cells: withoutEmptyTail(row.cells),
    })),
  };
}

function withoutEmptyTail(cells: string[]): string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === "") {
    end -= 1;
  }
  return end === cells.length ? cells : cells.slice(0, end);
}

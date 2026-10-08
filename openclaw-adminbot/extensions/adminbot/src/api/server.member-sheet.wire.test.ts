import { describe, expect, it } from "vitest";
import { memberSheetWire } from "./server.member-sheet.wire.js";

const view = {
  spreadsheet_id: "sheet",
  tab: "Roster",
  url: "https://docs.google.com/spreadsheets/d/sheet/edit",
  header: ["Name", "Email", "Type", "Notes"],
  rows: [
    { sheet_row: 2, cells: ["Ada", "ada@lab.test", "", ""] },
    { sheet_row: 3, cells: ["", "", "", ""] },
    { sheet_row: 4, cells: ["Bo", "", "", "keeps a middle gap"] },
  ],
  read_at: "2026-10-08T00:00:00.000Z",
};

describe("memberSheetWire", () => {
  it("drops only each row's empty tail", () => {
    const wire = memberSheetWire(view);
    expect(wire.rows.map((row) => row.cells)).toEqual([
      ["Ada", "ada@lab.test"],
      [],
      ["Bo", "", "", "keeps a middle gap"],
    ]);
    expect(wire.header).toEqual(view.header);
    expect(wire.rows.map((row) => row.sheet_row)).toEqual([2, 3, 4]);
  });
});

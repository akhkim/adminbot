import { describe, expect, it } from "vitest";
import {
  a1Range,
  columnLetter,
  planSheetEdits,
  type SheetCellEdit,
  toSheetGrid,
  touchesAccess,
} from "./member-sheet-grid.js";

const TAB = "Full Slack Member List";

describe("addressing a cell", () => {
  it("counts columns the way Sheets does, past Z", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(18)).toBe("S");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(51)).toBe("AZ");
    expect(columnLetter(52)).toBe("BA");
  });

  it("rejects a nonsense column rather than addressing the wrong cell", () => {
    expect(() => columnLetter(-1)).toThrow();
    expect(() => columnLetter(1.5)).toThrow();
  });

  // "Full Slack Member List" has spaces, so Sheets needs it quoted; a bare word must not be.
  it("quotes a tab name only when Sheets requires it", () => {
    expect(a1Range(TAB, 18, 169)).toBe("'Full Slack Member List'!S169");
    expect(a1Range("Sheet1", 0, 2)).toBe("Sheet1!A2");
    expect(a1Range("Bob's list", 0, 2)).toBe("'Bob''s list'!A2");
  });
});

describe("reading the sheet into a grid", () => {
  it("keeps each row's true sheet number, so an edit addresses the right line", () => {
    const grid = toSheetGrid([
      ["Name", "Email", "Member Type"],
      ["Yuen Chen", "yuenc2@illinois.edu", "alumni"],
      ["Rauno Arike", "rauno.arike@gmail.com", "coauthor-discussant-or-designer"],
    ]);
    expect(grid.header).toEqual(["Name", "Email", "Member Type"]);
    expect(grid.rows[0]).toEqual({
      sheetRow: 2,
      cells: ["Yuen Chen", "yuenc2@illinois.edu", "alumni"],
    });
    expect(grid.rows[1]!.sheetRow).toBe(3);
  });

  // gog omits trailing empty cells rather than padding them, so a sparse row arrives short.
  it("pads a ragged row to the header width", () => {
    const grid = toSheetGrid([["Name", "Email", "Member Type"], ["Kem Nguyen-Le"]]);
    expect(grid.rows[0]!.cells).toEqual(["Kem Nguyen-Le", "", ""]);
  });

  // The roster carries data in columns past its last heading. A header-width grid dropped those
  // cells silently; now the header grows to the widest row and the extra columns arrive unnamed.
  it("widens the header to the widest row, so unlabeled columns are not dropped", () => {
    const grid = toSheetGrid([
      ["Name", "Email"],
      ["Kem Nguyen-Le", "kem@example.org", "note in column C"],
      ["Youssef"],
    ]);
    expect(grid.header).toEqual(["Name", "Email", ""]);
    expect(grid.rows[0]!.cells).toEqual(["Kem Nguyen-Le", "kem@example.org", "note in column C"]);
    expect(grid.rows[1]!.cells).toEqual(["Youssef", "", ""]);
  });

  it("honours a range that does not start at row 1", () => {
    const grid = toSheetGrid([["Name"], ["Youssef"]], 168);
    expect(grid.rows[0]!.sheetRow).toBe(169);
  });
});

describe("planning the write", () => {
  const grid = toSheetGrid([
    ["Name", "Member Type", "Test Onboard"],
    ["Yuen Chen", "alumni", "3"],
    ["Rauno Arike", "acquaintance", "3"],
  ]);

  it("writes one range per edited cell, carrying what it is overwriting", () => {
    const plan = planSheetEdits(
      TAB,
      [{ sheetRow: 3, column: 1, value: "coauthor-discussant-or-designer" }],
      grid,
    );
    expect(plan.updates).toEqual([
      {
        range: "'Full Slack Member List'!B3",
        values: [["coauthor-discussant-or-designer"]],
      },
    ]);
    expect(plan.before).toEqual([
      { range: "'Full Slack Member List'!B3", values: [["acquaintance"]] },
    ]);
    expect(plan.conflicts).toEqual([]);
  });

  it("drops an edit that changes nothing, so an approval card is never empty noise", () => {
    const plan = planSheetEdits(TAB, [{ sheetRow: 2, column: 1, value: "alumni" }], grid);
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged).toHaveLength(1);
  });

  // Two people work in this sheet at once. An edit typed against a stale cell would silently
  // revert whatever the other person did in between, so it is refused and handed back instead.
  it("refuses an edit whose cell changed under it", () => {
    const expected = new Map([["3:1", "acquaintance"]]);
    const moved = toSheetGrid([
      ["Name", "Member Type", "Test Onboard"],
      ["Yuen Chen", "alumni", "3"],
      ["Rauno Arike", "coauthor-major", "3"],
    ]);
    const plan = planSheetEdits(TAB, [{ sheetRow: 3, column: 1, value: "alumni" }], moved, expected);
    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([
      { sheetRow: 3, column: 1, expected: "acquaintance", actual: "coauthor-major" },
    ]);
  });

  it("allows the edit when the cell still holds what the editor was looking at", () => {
    const plan = planSheetEdits(
      TAB,
      [{ sheetRow: 3, column: 1, value: "alumni" }],
      grid,
      new Map([["3:1", "acquaintance"]]),
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.conflicts).toEqual([]);
  });

  it("refuses to address a row or column the grid does not hold", () => {
    expect(() => planSheetEdits(TAB, [{ sheetRow: 99, column: 1, value: "x" }], grid)).toThrow(
      /does not hold/u,
    );
    expect(() => planSheetEdits(TAB, [{ sheetRow: 2, column: 9, value: "x" }], grid)).toThrow(
      /outside/u,
    );
  });
});

describe("access-bearing columns", () => {
  // Editing these is allowed; it is why the write is approval-gated rather than direct.
  it("recognises the columns that decide who can reach what", () => {
    const header = ["Name", "Member Type", "tldr"];
    const typeEdit: SheetCellEdit[] = [{ sheetRow: 2, column: 1, value: "full" }];
    const notesEdit: SheetCellEdit[] = [{ sheetRow: 2, column: 2, value: "likes causality" }];
    expect(touchesAccess(header, typeEdit)).toBe(true);
    expect(touchesAccess(header, notesEdit)).toBe(false);
    expect(touchesAccess(header, [...notesEdit, ...typeEdit])).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { withFullRows } from "./onboarding.ts";

const header = ["Name", "Email", "Type", "Notes"];
const full = {
  spreadsheet_id: "sheet",
  tab: "Roster",
  url: "https://docs.google.com/spreadsheets/d/sheet/edit",
  header,
  rows: [
    { sheet_row: 2, cells: ["Ada", "ada@lab.test", "", ""] },
    { sheet_row: 3, cells: ["", "", "", ""] },
  ],
  read_at: "2026-10-08T00:00:00.000Z",
};

describe("withFullRows", () => {
  it("pads rows sent without their empty tail back to the header's width", () => {
    const trimmed = {
      ...full,
      rows: [
        { sheet_row: 2, cells: ["Ada", "ada@lab.test"] },
        { sheet_row: 3, cells: [] },
      ],
    };
    expect(withFullRows(trimmed)).toEqual(full);
  });

  it("leaves an older service's full rows as they are", () => {
    expect(withFullRows(full).rows[0]).toBe(full.rows[0]);
  });
});

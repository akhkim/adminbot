import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import { editMemberSheetCell, memberSheetCellKey } from "../controllers/member-sheet.ts";
import { renderMemberSheet } from "./member-sheet.ts";

const SHEET = {
  spreadsheet_id: "1ZqdaRze",
  tab: "Full Slack Member List",
  url: "https://docs.google.com/spreadsheets/d/1ZqdaRze/edit",
  header: ["Name", "Member Type", "tldr"],
  rows: [
    { sheet_row: 2, cells: ["Yuen Chen", "alumni", ""] },
    { sheet_row: 3, cells: ["Rauno Arike", "coauthor-discussant-or-designer", ""] },
  ],
  read_at: "2026-08-29T00:00:00.000Z",
};

function draw(state: Partial<AppViewState>): HTMLElement {
  const host = document.createElement("div");
  render(renderMemberSheet(state as AppViewState), host);
  return host;
}

/** lit keeps the template's own line breaks, so assert on the text as a reader sees it. */
function text(host: HTMLElement): string {
  return (host.textContent ?? "").replace(/\s+/gu, " ").trim();
}

describe("the roster grid", () => {
  it("offers to load the sheet before one has been read", () => {
    const host = draw({});
    expect(text(host)).toContain("Load the sheet");
    expect(host.querySelector("table")).toBeNull();
  });

  it("draws a cell per column and keeps each row's sheet number visible", () => {
    const host = draw({ memberSheet: SHEET });
    const headings = [...host.querySelectorAll("thead th")].map((th) => th.textContent?.trim());
    expect(headings).toContain("Member Type");
    const rowHeadings = [...host.querySelectorAll("tbody th")].map((th) => th.textContent?.trim());
    expect(rowHeadings).toEqual(["2", "3"]);
    expect(host.querySelector('a[href*="1ZqdaRze"]')).not.toBeNull();
  });

  // The live roster: a blank first heading over the names, and data in columns past the last
  // heading. Both used to be lost -- the name column was unpinned and unnamed, and a header-width
  // read dropped the trailing columns. Every column is drawn, and a nameless one gets its letter.
  it("shows every column, names a blank heading by its letter, and pins the name column first", () => {
    const host = draw({
      memberSheet: {
        ...SHEET,
        header: ["", "Joined month", "Member Type", "", ""],
        rows: [{ sheet_row: 2, cells: ["Yuen Chen", "2024-01", "alumni", "", "note in E"] }],
      },
    });
    const headings = [...host.querySelectorAll("thead th")].map((th) => th.textContent?.trim());
    // Onboard checkbox, Row, then the sheet's own columns: name (column A) first, then the ones
    // worth reading first, then the rest in sheet order.
    expect(headings.slice(2)).toEqual([
      "Column A",
      "Member Type",
      "Joined month",
      "Column D",
      "Column E",
    ]);
    expect(host.querySelector("thead th.adminbot-member-roster__name")?.textContent?.trim()).toBe(
      "Column A",
    );
    expect(host.querySelector<HTMLInputElement>("td.adminbot-member-roster__name input")?.value).toBe(
      "Yuen Chen",
    );
    const values = [...host.querySelectorAll<HTMLInputElement>("tbody input[type=text]")].map(
      (input) => input.value,
    );
    expect(values).toContain("note in E");
    expect(text(host)).toContain("5 columns");
  });

  it("filters rows by any cell, and counts what is shown", () => {
    const host = draw({ memberSheet: SHEET, memberSheetFilter: "rauno" });
    const rowHeadings = [...host.querySelectorAll("tbody th")].map((th) => th.textContent?.trim());
    expect(rowHeadings).toEqual(["3"]);
    expect(text(host)).toContain("1 of 2 rows");

    const none = draw({ memberSheet: SHEET, memberSheetFilter: "nobody" });
    expect(text(none)).toContain("No rows match");

    // A pending edit is what the operator sees, so it is what the filter matches.
    const edited = draw({
      memberSheet: SHEET,
      memberSheetFilter: "renamed",
      memberSheetEdits: { [memberSheetCellKey(2, 0)]: "Renamed Person" },
    });
    expect([...edited.querySelectorAll("tbody th")].map((th) => th.textContent?.trim())).toEqual([
      "2",
    ]);
  });

  it("selects every shown row from the heading checkbox", () => {
    const state: Partial<AppViewState> = { memberSheet: SHEET, memberSheetFilter: "rauno" };
    const host = draw(state);
    const all = host.querySelector<HTMLInputElement>("thead input[type=checkbox]");
    all!.checked = true;
    all!.dispatchEvent(new Event("change"));
    expect(state.memberSheetSelection).toEqual([3]);
  });

  it("shows an edited cell's new value, not the sheet's", () => {
    const host = draw({
      memberSheet: SHEET,
      memberSheetEdits: { [memberSheetCellKey(2, 1)]: "full" },
    });
    const values = [...host.querySelectorAll<HTMLInputElement>("tbody input[type=text]")].map(
      (input) => input.value,
    );
    expect(values).toContain("full");
    expect(host.querySelector("td.is-edited")).not.toBeNull();
  });

  it("counts pending changes on the save button and disables it when there are none", () => {
    expect(text(draw({ memberSheet: SHEET }))).toContain("No changes");
    const edited = draw({
      memberSheet: SHEET,
      memberSheetEdits: { "2:1": "full", "3:2": "note" },
    });
    expect(text(edited)).toContain("Propose 2 changes");
  });

  // A conflict is an ordinary event when two people share a sheet. It must show both values and
  // keep what the operator typed, rather than reading as a failure.
  it("shows both values when a cell changed underneath, and says the text is kept", () => {
    const host = draw({
      memberSheet: SHEET,
      memberSheetSaveResult: {
        updates: [],
        unchanged: 0,
        touches_access: false,
        conflicts: [
          {
            sheet_row: 2,
            column: 1,
            header: "Member Type",
            expected: "alumni",
            actual: "coauthor-major",
          },
        ],
      },
    });
    expect(text(host)).toContain("alumni");
    expect(text(host)).toContain("coauthor-major");
    expect(text(host)).toContain("Your text is still in the grid");
  });

  it("says an approved write is still pending, and flags an access column", () => {
    const host = draw({
      memberSheet: SHEET,
      memberSheetSaveResult: {
        proposal: { id: "act_1", status: "pending" },
        updates: [{ range: "A1", values: [["x"]] }],
        conflicts: [],
        unchanged: 0,
        touches_access: true,
      },
    });
    expect(text(host)).toContain("Pending Actions");
    expect(text(host)).toContain("access column");
  });

  it("reports what onboarding queued and what it would not, with reasons", () => {
    const host = draw({
      memberSheet: SHEET,
      memberSheetOnboardResult: {
        created: [
          { sheet_row: 2, email: "yuenc2@illinois.edu", template_id: "alumni", proposal_id: "a" },
        ],
        skipped: [{ sheet_row: 3, reason: "coauthor-discussant-or-designer sends no onboarding mail" }],
      },
    });
    expect(text(host)).toContain("Queued 1");
    expect(text(host)).toContain("Nothing has been sent yet");
    expect(text(host)).toContain("sends no onboarding mail");
  });

  it("only offers to onboard once rows are selected", () => {
    expect(text(draw({ memberSheet: SHEET }))).toContain("Select rows to onboard");
    expect(text(draw({ memberSheet: SHEET, memberSheetSelection: [2] }))).toContain(
      "Onboard 1 selected",
    );
  });
});

describe("recording an edit", () => {
  it("remembers what the cell held, so a stale write can be refused later", () => {
    const host = { memberSheet: SHEET } as Parameters<typeof editMemberSheetCell>[0];
    editMemberSheetCell(host, 2, 1, "full");
    expect(host.memberSheetEdits).toEqual({ "2:1": "full" });
    expect(host.memberSheetBaseline).toEqual({ "2:1": "alumni" });
  });

  // Typing a cell back to its original is not a change and must not hold up a save.
  it("drops an edit typed back to the original value", () => {
    const host = { memberSheet: SHEET } as Parameters<typeof editMemberSheetCell>[0];
    editMemberSheetCell(host, 2, 1, "full");
    editMemberSheetCell(host, 2, 1, "alumni");
    expect(host.memberSheetEdits).toEqual({});
    expect(host.memberSheetBaseline).toEqual({});
  });

  it("keeps the first baseline when a cell is edited twice", () => {
    const host = { memberSheet: SHEET } as Parameters<typeof editMemberSheetCell>[0];
    editMemberSheetCell(host, 2, 1, "full");
    editMemberSheetCell(host, 2, 1, "coauthor-major");
    expect(host.memberSheetEdits).toEqual({ "2:1": "coauthor-major" });
    expect(host.memberSheetBaseline).toEqual({ "2:1": "alumni" });
  });
});

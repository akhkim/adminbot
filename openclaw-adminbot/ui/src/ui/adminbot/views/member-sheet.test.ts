import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import { editMemberSheetCell, memberSheetCellKey } from "../controllers/member-sheet.ts";
import { adminBotMemberTypes } from "../../../../../extensions/adminbot/src/contracts/actions.js";
import { memberTypeOptions, renderMemberSheet } from "./member-sheet.ts";

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

  // Onboarding automates real mail, so the button no longer executes: it asks the service what
  // would happen, and the panel below is what actually queues it.
  it("previews onboarding instead of executing it, and confirms from the panel", () => {
    const previewOnboardSelectedRows = vi.fn();
    const onboardSelectedMemberRows = vi.fn();
    const state: Partial<AppViewState> = {
      memberSheet: SHEET,
      memberSheetSelection: [2],
      previewOnboardSelectedRows,
      onboardSelectedMemberRows,
      memberSheetOnboardPreview: {
        planned: [
          {
            sheet_row: 2,
            name: "Yuen Chen",
            email: "yuen@example.org",
            template_id: "alumni",
            subject: "Welcome back",
            body: "Dear Yuen,\nthe guide.",
            reply_to: "akim@cs.toronto.edu",
          },
        ],
        skipped: [{ sheet_row: 3, reason: "no email address on this row" }],
      },
    };
    const host = draw(state);

    host
      .querySelector<HTMLButtonElement>('[data-testid="onboard-preview-open"]')
      ?.click();
    expect(previewOnboardSelectedRows).toHaveBeenCalledOnce();
    expect(onboardSelectedMemberRows).not.toHaveBeenCalled();

    const panel = text(host);
    expect(panel).toContain("Review before onboarding");
    expect(panel).toContain("Nothing is sent until an admin approves them there.");
    expect(panel).toContain("Yuen Chen");
    expect(panel).toContain("alumni → yuen@example.org");
    expect(panel).toContain("Welcome back");
    expect(panel).toContain("the guide.");
    expect(panel).toContain("Row 3: no email address on this row");

    host.querySelector<HTMLButtonElement>('[data-testid="onboard-confirm"]')?.click();
    expect(onboardSelectedMemberRows).toHaveBeenCalledOnce();
  });

  it("dismisses the preview without queueing anything", () => {
    const state: Partial<AppViewState> = {
      memberSheet: SHEET,
      memberSheetOnboardPreview: { planned: [], skipped: [] },
    };
    const host = draw(state);
    expect(text(host)).toContain("Nothing would be queued for this selection.");
    host.querySelector<HTMLButtonElement>('[data-testid="onboard-preview-cancel"]')?.click();
    expect(state.memberSheetOnboardPreview).toBeNull();
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
    // Read across both controls: Member Type is a dropdown and every other column a text box, and
    // "an edit shows the operator's value rather than the sheet's" is true of both.
    const values = [
      ...host.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        "tbody input[type=text], tbody select",
      ),
    ].map((control) => control.value);
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

  it("only offers to onboard once rows are selected, and then only as a preview", () => {
    const idle = draw({ memberSheet: SHEET });
    expect(
      idle.querySelector<HTMLButtonElement>('[data-testid="onboard-preview-open"]')?.disabled,
    ).toBe(true);
    expect(text(draw({ memberSheet: SHEET, memberSheetSelection: [2] }))).toContain(
      "Preview onboarding (1)",
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

// The Member Type column decides which onboarding mail a row gets and which access items the
// backend grants, and it used to be a free text box in a grid of thirty of them. A typo there is
// not a typo, it is a row that quietly stops matching any sweep.
describe("the Member Type cell", () => {
  function typeCell(host: HTMLElement, row = 0): HTMLSelectElement | null {
    return [...host.querySelectorAll("tbody tr")][row]?.querySelector("select") ?? null;
  }

  it("is a dropdown, where every other column stays a text box", () => {
    const host = draw({ memberSheet: SHEET });
    const select = typeCell(host);
    expect(select).not.toBeNull();
    expect(select?.getAttribute("aria-label")).toBe("Member Type, row 2");
    // One select in the row: the other two columns are still free text.
    expect([...host.querySelectorAll("tbody tr")][0]?.querySelectorAll("select")).toHaveLength(1);
    expect(
      [...host.querySelectorAll("tbody tr")][0]?.querySelectorAll('input[type="text"]').length,
    ).toBeGreaterThan(0);
  });

  it("offers the whole vocabulary, with the row's own value selected", () => {
    const host = draw({ memberSheet: SHEET });
    const options = [...(typeCell(host)?.options ?? [])].map((option) => option.value);
    for (const token of adminBotMemberTypes) {
      expect(options).toContain(token);
    }
    expect(typeCell(host)?.value).toBe("alumni");
    expect(typeCell(host, 1)?.value).toBe("coauthor-discussant-or-designer");
  });

  // The column is comma-separated and three tokens the lab uses postdate the routing table, so a
  // closed list would have made real rows unselectable and rewritten them on first touch.
  it("keeps a value the vocabulary does not know, rather than dropping it", () => {
    const host = draw({
      memberSheet: {
        ...SHEET,
        rows: [
          { sheet_row: 2, cells: ["Zhijing Jin", "full, adminbot-admin", ""] },
          { sheet_row: 3, cells: ["Someone", "mailing-list", ""] },
        ],
      },
    });
    expect(typeCell(host)?.value).toBe("full, adminbot-admin");
    const options = [...(typeCell(host)?.options ?? [])].map((option) => option.value);
    // Offered to every row, so a second person can be given the same combination.
    expect(options).toContain("full, adminbot-admin");
    expect(options).toContain("mailing-list");
  });

  it("records a pick as an edit, like any other cell", () => {
    const host: Partial<AppViewState> = { memberSheet: SHEET };
    const edits: Array<[number, number, string]> = [];
    const drawn = draw({
      ...host,
      editMemberSheetCell: (row: number, column: number, value: string) => {
        edits.push([row, column, value]);
      },
    } as Partial<AppViewState>);
    const select = typeCell(drawn);
    select!.value = "full";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(edits).toEqual([[2, 1, "full"]]);
  });

  it("can clear a cell back to empty", () => {
    const drawn = draw({ memberSheet: SHEET });
    const options = [...(typeCell(drawn)?.options ?? [])].map((option) => option.value);
    expect(options[0]).toBe("");
  });
});

describe("memberTypeOptions", () => {
  it("puts the canonical vocabulary first, then whatever the sheet adds", () => {
    const options = memberTypeOptions(
      [{ cells: { 1: "zzz-custom" } }, { cells: { 1: "full" } }],
      1,
      "",
    );
    expect(options[0]).toBe("full");
    expect(options.at(-1)).toBe("zzz-custom");
  });

  it("never repeats a value", () => {
    const options = memberTypeOptions([{ cells: { 1: "full" } }], 1, "full");
    expect(options.filter((option) => option === "full")).toHaveLength(1);
  });

  it("survives a sheet with no Member Type column", () => {
    expect(memberTypeOptions([{ cells: { 0: "x" } }], -1, "")).toEqual([...adminBotMemberTypes]);
  });
});

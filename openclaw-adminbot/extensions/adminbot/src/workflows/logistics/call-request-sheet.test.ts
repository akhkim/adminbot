import { describe, expect, it } from "vitest";
import {
  type CallRequestEntry,
  callRequestCells,
  locateCallSheet,
  planCallRequestAppend,
} from "./call-request-sheet.js";
import type { DocPrepLinkVerdict } from "./doc-prep-link.js";

const TAB = "Call requests";

const OK_DOC: DocPrepLinkVerdict = {
  status: "ok",
  document_id: "1DvlfAFPHplL5kGH9zjpOFKAx2D3cltnltzQdpIY43i0",
  url: "https://docs.google.com/document/d/1DvlfAFPHplL5kGH9zjpOFKAx2D3cltnltzQdpIY43i0/edit",
};

/**
 * The live tab, shape for shape: a prose note above the headings, the headings with their real
 * typo, filled rows, spare blanks, and the archive marker under them. The tests are only worth
 * anything if the grid they run against has the same traps as the sheet.
 */
function sheet(): string[][] {
  return [
    [
      "",
      "Note: This sheet is for additional whatsapp call requests with Zhijing.",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ],
    [
      "Name",
      "What topics do you want to go through?",
      "Your current city (or time range flexible for you tto receive calls)",
      "Doc prep of all the questions (before the call)",
      'Have you messaged Zhijing a "hello" on whatsapp, so she can easily find your number?',
      "min_length of the call possible",
      "until when is it ok to make this call?",
      "time you entered this call request",
      "Zhijing's actual meeting with you",
    ],
    [
      "Aryan Barsainyan",
      "Grad school application",
      "IST time zone",
      OK_DOC.url,
      "yes",
      "20 min",
      "Until 2026-09-06",
      "2026-08-14",
      "",
    ],
    [
      "Gopal",
      "Future research plans",
      "IST time zone",
      "TODO",
      "",
      "15 min",
      "2026-09-15",
      "2026-09-03",
      "",
    ],
    ["", "", "", "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", "", ""],
    ["Finished calls", "", "", "", "", "", "", "", ""],
    [
      "Luke",
      "Grad school app",
      "Toronto",
      "TODO",
      "Yes",
      "15 min",
      "Until 2026-08-31",
      "2026-08-17",
      "2026-08-21 in person",
    ],
  ];
}

function entry(overrides: Partial<CallRequestEntry> = {}): CallRequestEntry {
  return {
    request_id: "req-1",
    member_name: "Jiarui",
    purpose: "Research plans for the semester",
    city: "Boston",
    length_minutes: 30,
    latest_ok_date: "2026-09-30",
    whatsapp_hello: true,
    submitted_at: "2026-09-09T08:15:00.000Z",
    doc_prep: OK_DOC,
    ...overrides,
  };
}

describe("locateCallSheet", () => {
  it("finds the heading row past the prose note above it", () => {
    const located = locateCallSheet(sheet());
    expect(located.ok).toBe(true);
    if (!located.ok) {
      return;
    }
    expect(located.layout.header_row).toBe(2);
    expect(located.layout.columns.doc_prep).toBe(3);
    expect(located.layout.columns.entered_at).toBe(7);
  });

  it("does not bind the whatsapp column to the note row that also says whatsapp", () => {
    const located = locateCallSheet(sheet());
    expect(located.ok && located.layout.columns.whatsapp_hello).toBe(4);
  });

  it("stops the live block at the Finished calls marker", () => {
    const located = locateCallSheet(sheet());
    expect(located.ok).toBe(true);
    if (!located.ok) {
      return;
    }
    // Rows 5 and 6 are the blanks; row 8 is Luke, below the marker, and must not be offered.
    expect(located.layout.open_rows).toEqual([5, 6]);
    expect(located.layout.filled_rows).toEqual([3, 4]);
  });

  it("refuses a tab that is not the call sheet", () => {
    expect(locateCallSheet([["Title", "Venue", "Authors"]])).toEqual({
      ok: false,
      reason: "no call-request heading row found on that tab (looked for Name / topics / doc prep)",
    });
  });
});

describe("callRequestCells", () => {
  it("formats the cells the way the rows already in the sheet read", () => {
    expect(callRequestCells(entry())).toEqual({
      name: "Jiarui",
      topics: "Research plans for the semester",
      city: "Boston",
      doc_prep: OK_DOC.url,
      whatsapp_hello: "Yes",
      min_length: "30 min",
      latest_ok: "2026-09-30",
      entered_at: "2026-09-09",
    });
  });

  it("falls back to the timezone when no city was given", () => {
    expect(callRequestCells(entry({ city: undefined, timezone: "Europe/Zurich" })).city).toBe(
      "Europe/Zurich",
    );
  });

  it("leaves the whatsapp cell blank when the member never answered", () => {
    expect(callRequestCells(entry({ whatsapp_hello: undefined })).whatsapp_hello).toBe("");
    expect(callRequestCells(entry({ whatsapp_hello: false })).whatsapp_hello).toBe("No");
  });
});

describe("planCallRequestAppend", () => {
  it("fills the first blank row and reports where it went", () => {
    const plan = planCallRequestAppend(TAB, sheet(), [entry()]);
    expect("error" in plan).toBe(false);
    if ("error" in plan) {
      return;
    }
    expect(plan.placed).toEqual([{ request_id: "req-1", member_name: "Jiarui", sheet_row: 5 }]);
    expect(plan.updates).toContainEqual({
      range: "'Call requests'!A5",
      values: [["Jiarui"]],
    });
    expect(plan.updates).toContainEqual({
      range: "'Call requests'!D5",
      values: [[OK_DOC.url]],
    });
  });

  it("never writes into Zhijing's own meeting column", () => {
    const plan = planCallRequestAppend(TAB, sheet(), [entry()]);
    if ("error" in plan) {
      throw new Error(plan.error);
    }
    expect(plan.updates.some((update) => update.range.includes("I"))).toBe(false);
  });

  it("carries the prior cell contents so the approval card shows it is filling blanks", () => {
    const plan = planCallRequestAppend(TAB, sheet(), [entry()]);
    if ("error" in plan) {
      throw new Error(plan.error);
    }
    expect(plan.before.every((range) => range.values[0]?.[0] === "")).toBe(true);
  });

  // The whole point of the feature: a link nobody can open never reaches her sheet.
  it.each([
    { status: "placeholder", raw: "TODO" } as DocPrepLinkVerdict,
    { status: "missing" } as DocPrepLinkVerdict,
    {
      status: "restricted",
      document_id: "x",
      url: OK_DOC.url,
    } as DocPrepLinkVerdict,
    {
      status: "not_found",
      document_id: "x",
      url: OK_DOC.url,
    } as DocPrepLinkVerdict,
    {
      status: "unreachable",
      document_id: "x",
      url: OK_DOC.url,
      reason: "boom",
    } as DocPrepLinkVerdict,
  ])("skips a request whose doc prep is $status", (doc_prep) => {
    const plan = planCallRequestAppend(TAB, sheet(), [entry({ doc_prep })]);
    if ("error" in plan) {
      throw new Error(plan.error);
    }
    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        request_id: "req-1",
        member_name: "Jiarui",
        reason: "doc_prep_invalid",
        detail: doc_prep.status,
      },
    ]);
  });

  it("does not queue the same ask twice", () => {
    const plan = planCallRequestAppend(TAB, sheet(), [
      entry({
        member_name: "Aryan Barsainyan",
        purpose: "Grad school application",
      }),
    ]);
    if ("error" in plan) {
      throw new Error(plan.error);
    }
    expect(plan.updates).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ reason: "already_on_sheet" });
  });

  it("does not queue a duplicate inside one batch either", () => {
    const plan = planCallRequestAppend(TAB, sheet(), [
      entry({ request_id: "a" }),
      entry({ request_id: "b" }),
    ]);
    if ("error" in plan) {
      throw new Error(plan.error);
    }
    expect(plan.placed).toHaveLength(1);
    expect(plan.skipped[0]).toMatchObject({
      request_id: "b",
      reason: "already_on_sheet",
    });
  });

  it("reports an overflow rather than writing past the last blank row", () => {
    const plan = planCallRequestAppend(TAB, sheet(), [
      entry({ request_id: "a", purpose: "one" }),
      entry({ request_id: "b", purpose: "two" }),
      entry({ request_id: "c", purpose: "three" }),
    ]);
    if ("error" in plan) {
      throw new Error(plan.error);
    }
    expect(plan.placed.map((row) => row.sheet_row)).toEqual([5, 6]);
    expect(plan.skipped).toEqual([
      {
        request_id: "c",
        member_name: "Jiarui",
        reason: "no_open_row",
        detail: "no blank row left above the Finished calls marker; add rows to the tab",
      },
    ]);
  });

  // A column inserted to the left is exactly the change a hardcoded A:H would survive silently and
  // wrongly, so it is asserted rather than assumed.
  it("follows its headings when a column is inserted before them", () => {
    const shifted = sheet().map((row) => {
      const shiftedRow = [""];
      shiftedRow.push(...row);
      return shiftedRow;
    });
    const plan = planCallRequestAppend(TAB, shifted, [entry()]);
    if ("error" in plan) {
      throw new Error(plan.error);
    }
    expect(plan.updates).toContainEqual({
      range: "'Call requests'!B5",
      values: [["Jiarui"]],
    });
  });

  it("tolerates the short rows Sheets returns for trailing empties", () => {
    const ragged = sheet().map((row, index) => (index >= 4 ? [] : row));
    const plan = planCallRequestAppend(TAB, ragged, [entry()]);
    if ("error" in plan) {
      throw new Error(plan.error);
    }
    expect(plan.placed).toHaveLength(1);
  });

  it("surfaces the wrong tab as an error rather than an empty plan", () => {
    expect(planCallRequestAppend(TAB, [["Title", "Venue"]], [entry()])).toMatchObject({
      error: expect.stringContaining("no call-request heading row"),
    });
  });
});

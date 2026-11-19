// Row inserts into the acceptance tab. What matters: every call is pinned to the one API method it
// makes, the rows travel in a file that is gone afterwards, and a per-row formula column (the CV
// entry) is carried onto the new rows while an array formula is left alone.
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  batchUpdateGogSheet,
  buildSheetInsertRequests,
  insertGogSheetRows,
  readGogSheetFormulas,
} from "./gog-sheets.js";

const ENV = { GOG_ACCOUNT: "bot@example.org" } as NodeJS.ProcessEnv;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

describe("readGogSheetFormulas", () => {
  it("reads formulas, not displayed values, through a read-only pinned call", async () => {
    const capture = vi.fn(async (_args: string[]) =>
      JSON.stringify({ values: [["year", "title"], ["2026", "T", null, "=B2"]] }),
    );
    const formulas = await readGogSheetFormulas("sheet_1", "'Acc'!A:ZZ", { env: ENV, capture });
    expect(formulas).toEqual([["year", "title"], ["2026", "T", "", "=B2"]]);
    const args = capture.mock.calls[0]![0];
    expect(flag(args, "--enable-commands-exact")).toBe(
      "api.call,api.sheets.spreadsheets.values.get",
    );
    expect(flag(args, "--account")).toBe("bot@example.org");
    expect(JSON.parse(flag(args, "--params")!)).toEqual({
      spreadsheetId: "sheet_1",
      range: "'Acc'!A:ZZ",
      valueRenderOption: "FORMULA",
    });
    expect(args).not.toContain("--force");
    expect(args).not.toContain("--allow-write");
  });

  it("refuses output that is not JSON", async () => {
    await expect(
      readGogSheetFormulas("s", "A:ZZ", { env: ENV, capture: async () => "Error: no auth" }),
    ).rejects.toThrow(/non-JSON/u);
  });
});

describe("buildSheetInsertRequests", () => {
  const formulas = [
    ["year", "title", "conference", "authors", "link", "latex"],
    ["2026", "A", "NeurIPS", "x", "", '=B2&" "&C2', "typed note", "=ARRAYFORMULA(B2:B)"],
    ["2025", "B", "EMNLP", "y", "", '=B3&" "&C3', "", ""],
  ];

  it("inserts, writes the values as text and copies the per-row formula from the row above", () => {
    const requests = buildSheetInsertRequests({
      sheetId: 7,
      inserts: [{ at: 2, rows: [["2026", "=not a formula", "NeurIPS", "z", ""]] }],
      formulas,
      writtenColumns: 5,
    });
    expect(requests).toEqual([
      {
        insertDimension: {
          range: { sheetId: 7, dimension: "ROWS", startIndex: 2, endIndex: 3 },
          inheritFromBefore: true,
        },
      },
      {
        updateCells: {
          range: { sheetId: 7, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 5 },
          rows: [
            {
              values: ["2026", "=not a formula", "NeurIPS", "z", ""].map((value) => ({
                userEnteredValue: { stringValue: value },
              })),
            },
          ],
          fields: "userEnteredValue",
        },
      },
      // Column F only: G is a typed value, H the array formula that extends itself.
      {
        copyPaste: {
          source: { sheetId: 7, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 5, endColumnIndex: 6 },
          destination: { sheetId: 7, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 5, endColumnIndex: 6 },
          pasteType: "PASTE_FORMULA",
        },
      },
    ]);
  });

  it("takes the row below as the template under the header, where it has moved to", () => {
    const requests = buildSheetInsertRequests({
      sheetId: 7,
      inserts: [{ at: 1, rows: [["2027", "N", "ICLR", "", ""], ["2027", "M", "ICLR", "", ""]] }],
      formulas,
      writtenColumns: 5,
    }) as Array<Record<string, any>>;
    expect(requests[0]!.insertDimension.inheritFromBefore).toBe(false);
    // The old row 1 is now at index 3, below the two new rows.
    expect(requests[2]!.copyPaste.source).toMatchObject({ startRowIndex: 3, endRowIndex: 4 });
    expect(requests[2]!.copyPaste.destination).toMatchObject({ startRowIndex: 1, endRowIndex: 3 });
  });

  it("takes the row below when the row above is blank, and copies nothing when neither has a formula", () => {
    const blankAbove = [formulas[0]!, ["", "", ""], ["2025", "B", "EMNLP", "", "", "=B3"]];
    const below = buildSheetInsertRequests({
      sheetId: 1,
      inserts: [{ at: 2, rows: [["2025", "C", "EMNLP", "", ""]] }],
      formulas: blankAbove,
      writtenColumns: 5,
    }) as Array<Record<string, any>>;
    expect(below[2]!.copyPaste.source).toMatchObject({ startRowIndex: 3 });

    const plain = buildSheetInsertRequests({
      sheetId: 1,
      inserts: [{ at: 1, rows: [["2025", "C", "EMNLP", "", ""]] }],
      formulas: [formulas[0]!, ["2024", "D", "ACL", "", ""]],
      writtenColumns: 5,
    });
    expect(plain).toHaveLength(2);
  });

  it("refuses inserts above the header or out of bottom-first order", () => {
    const build = (inserts: Array<{ at: number; rows: string[][] }>) =>
      buildSheetInsertRequests({ sheetId: 1, inserts, formulas, writtenColumns: 5 });
    expect(() => build([{ at: 0, rows: [["x"]] }])).toThrow(/bottom first/u);
    expect(() => build([{ at: 1, rows: [["x"]] }, { at: 2, rows: [["y"]] }])).toThrow(/bottom first/u);
    expect(build([{ at: 2, rows: [["x"]] }, { at: 1, rows: [["y"]] }])).toHaveLength(6);
  });
});

describe("batchUpdateGogSheet", () => {
  it("sends the body from a private file that is removed afterwards, through a pinned write", async () => {
    let bodyPath = "";
    let body: unknown;
    let mode = 0;
    const capture = vi.fn(async (args: string[]) => {
      bodyPath = flag(args, "--body")!.slice(1);
      body = JSON.parse(fs.readFileSync(bodyPath, "utf8"));
      mode = fs.statSync(bodyPath).mode & 0o777;
      return "{}";
    });
    await batchUpdateGogSheet("sheet_1", [{ insertDimension: {} }], { env: ENV, capture });
    const args = capture.mock.calls[0]![0];
    expect(flag(args, "--enable-commands-exact")).toBe("api.call,api.sheets.spreadsheets.batchupdate");
    expect(args).toEqual(expect.arrayContaining(["--force", "--allow-write"]));
    expect(JSON.parse(flag(args, "--params")!)).toEqual({ spreadsheetId: "sheet_1" });
    expect(body).toEqual({ requests: [{ insertDimension: {} }] });
    expect(mode).toBe(0o600);
    expect(fs.existsSync(bodyPath)).toBe(false);
  });

  it("removes the body file when the call fails, and refuses an empty batch", async () => {
    let bodyPath = "";
    const capture = vi.fn(async (args: string[]) => {
      bodyPath = flag(args, "--body")!.slice(1);
      throw new Error("gog failed");
    });
    await expect(batchUpdateGogSheet("s", [{}], { env: ENV, capture })).rejects.toThrow(/gog failed/u);
    expect(fs.existsSync(bodyPath)).toBe(false);
    await expect(batchUpdateGogSheet("s", [], { env: ENV, capture })).rejects.toThrow(/empty/u);
  });
});

describe("insertGogSheetRows", () => {
  it("reads the formulas first, then makes one batchUpdate", async () => {
    const methods: string[] = [];
    const capture = vi.fn(async (args: string[]) => {
      methods.push(flag(args, "--enable-commands-exact")!);
      return JSON.stringify({ values: [["year"], ["2026", "", "", "", "", "=B2"]] });
    });
    await insertGogSheetRows(
      "sheet_1",
      { sheetId: 3, formulaRange: "'Acc'!A:ZZ", inserts: [{ at: 2, rows: [["2025", "T", "ACL", "", ""]] }] },
      { env: ENV, capture, writtenColumns: 5 },
    );
    expect(methods).toEqual([
      "api.call,api.sheets.spreadsheets.values.get",
      "api.call,api.sheets.spreadsheets.batchupdate",
    ]);
  });
});

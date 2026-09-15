// The export, which is the half of this feature a paper actually reads.
import { describe, expect, it } from "vitest";
import type { TabVisitRow } from "../auth/session.ts";
import { tabVisitsCsv } from "./tab-usage.ts";

function row(fields: Partial<TabVisitRow> & { tab: string }): TabVisitRow {
  return {
    id: "tabv_1",
    member_id: "ada",
    at: "2026-09-01T09:00:00.000Z",
    ...fields,
  };
}

describe("tabVisitsCsv", () => {
  it("writes the service's own field names as the header", () => {
    // The column in the paper's analysis and the column here have to mean the same thing without a
    // translation table, so these are deliberately not the camelCase the page uses.
    expect(tabVisitsCsv([]).split("\n")[0]).toBe("id,member_id,tab,at,impersonated");
  });

  it("writes one row per visit, with the flag as 0 or 1", () => {
    const csv = tabVisitsCsv([
      row({ id: "a", tab: "dashboard" }),
      row({ id: "b", tab: "profile", impersonated: true }),
    ]);
    expect(csv.split("\n")).toEqual([
      "id,member_id,tab,at,impersonated",
      "a,ada,dashboard,2026-09-01T09:00:00.000Z,0",
      "b,ada,profile,2026-09-01T09:00:00.000Z,1",
    ]);
  });

  it("quotes a value that would otherwise shift every column after it", () => {
    // Not hypothetical for a member id imported from a spreadsheet: "Chen, Mei" is one field and
    // unquoted it is two, which moves the timestamp into the tab column for that row only.
    const csv = tabVisitsCsv([row({ tab: "dash,board", member_id: 'say "hi"' })]);
    expect(csv.split("\n")[1]).toBe('tabv_1,"say ""hi""","dash,board",2026-09-01T09:00:00.000Z,0');
  });

  it("quotes a value carrying a newline rather than ending the row early", () => {
    const csv = tabVisitsCsv([row({ tab: "two\nlines" })]);
    expect(csv).toContain('"two\nlines"');
    // The header plus one logical row, even though the file has three physical lines.
    expect(csv.split("\n")).toHaveLength(3);
  });

  it("answers an empty log with a header and nothing else", () => {
    expect(tabVisitsCsv([])).toBe("id,member_id,tab,at,impersonated");
  });
});

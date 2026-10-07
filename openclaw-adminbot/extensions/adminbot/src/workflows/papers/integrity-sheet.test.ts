import { describe, expect, it } from "vitest";
import type { OpenReviewSubmission } from "../../contracts/openreview-citation-checks.js";
import {
  cellRange,
  citationCellText,
  openReviewIdIn,
  planSheet,
  scoreCellText,
  sheetColumns,
  unconfirmedCellText,
} from "./integrity-sheet.js";

const TAB = "Papers-iclr-feedback";
const header = ["Title", "Venue", "Authors", "Edit", "View", "Slack", "TODO", "Pangram Score"];

function submission(id: string, title: string, pdf = true): OpenReviewSubmission {
  return {
    id,
    title,
    venue_id: "ICLR.cc/2027/Conference/Submission",
    pdf_path: pdf ? `/pdf/${id}.pdf` : "",
    modified_at: 0,
    author_names: ["Ada Lovelace", "Grace Hopper"],
  };
}

const check = (findings: Array<{ citation: string; status: string }>, status = "completed") =>
  ({
    submission_id: "s",
    pdf_path: "/p",
    title: "t",
    venue_id: "v",
    status,
    checked_at: "",
    attempts: 1,
    findings: findings.map((finding) => ({ ...finding, explanation: "" })),
  }) as never;

describe("the lab sheet plan", () => {
  // The lab moved its rows down and left the top empty, one row per submission.
  it("adds each submission as a new entry in the empty rows, with its link", () => {
    const grid = [header, [], [], ["Old working title", "", "Ada Lovelace"]];
    const plan = planSheet(grid, TAB, [
      { submission: submission("aaaa1111", "First paper"), score: "82% AI" },
      { submission: submission("bbbb2222", "Abstract only", false) },
    ]);
    const cells = Object.fromEntries(plan.updates.map((u) => [u.range, u.values[0][0]]));
    expect(cells).toMatchObject({
      [`'${TAB}'!I1`]: "Hallucinated citations",
      [`'${TAB}'!J1`]: "Unconfirmed references",
      [`'${TAB}'!K1`]: "OpenReview",
      [`'${TAB}'!A2`]: "First paper",
      [`'${TAB}'!C2`]: "Ada Lovelace, Grace Hopper",
      [`'${TAB}'!K2`]: "https://openreview.net/forum?id=aaaa1111",
      [`'${TAB}'!H2`]: "82% AI",
      [`'${TAB}'!A3`]: "Abstract only",
      [`'${TAB}'!K3`]: "https://openreview.net/forum?id=bbbb2222",
    });
    // The lab's own row below is never touched.
    expect(Object.keys(cells).some((range) => range.endsWith("4"))).toBe(false);
    expect(plan.added).toEqual(["First paper", "Abstract only"]);
    expect(plan.columns.toSorted()).toEqual(["A", "C", "H", "I", "J", "K"]);
  });

  it("finds a submission's row by its link and writes only what changed", () => {
    const full = [...header, "Hallucinated citations", "Unconfirmed references", "OpenReview"];
    const row = ["First paper", "", "Ada", "", "", "", "", "82% AI", "", "None"];
    row[10] = "https://openreview.net/forum?id=aaaa1111";
    const plan = planSheet([full, row], TAB, [
      {
        submission: submission("aaaa1111", "First paper"),
        score: "82% AI",
        unconfirmed: "could not check: X",
      },
    ]);
    expect(plan.updates).toEqual([{ range: `'${TAB}'!J2`, values: [["could not check: X"]] }]);
    expect(plan.added).toEqual([]);
  });

  it("appends after the last row when no row is empty", () => {
    const full = [...header, "Hallucinated citations", "Unconfirmed references", "OpenReview"];
    const plan = planSheet([full, ["Taken"]], TAB, [{ submission: submission("cccc3333", "New") }]);
    expect(plan.updates.map((u) => u.range)).toContain(`'${TAB}'!A3`);
  });
});

describe("cell text", () => {
  it("reads a submission id out of an OpenReview link", () => {
    expect(openReviewIdIn("https://openreview.net/forum?id=aB3_x-9")).toBe("aB3_x-9");
    expect(openReviewIdIn("https://openreview.net/pdf?id=zz9")).toBe("zz9");
    expect(openReviewIdIn("not a link")).toBeUndefined();
  });

  it("names only confirmed fabrications in the hallucinated column", () => {
    const findings = [
      { citation: "Nobody. 2031.", status: "not_found" },
      { citation: "Unasked. 2024.", status: "unavailable" },
    ];
    expect(citationCellText(check(findings))).toBe("Nobody. 2031.");
    // A partial check confirms nothing, so it names nothing here.
    expect(citationCellText(check(findings, "failed"))).toBeUndefined();
  });

  it("names every reference that could not be confirmed, from a partial check too", () => {
    const findings = [
      { citation: "Unasked. 2024.", status: "unavailable" },
      { citation: "Close call. 2023.", status: "review" },
      { citation: "Real. 2020.", status: "matched" },
    ];
    expect(unconfirmedCellText(check(findings, "failed"))).toBe(
      "could not check: Unasked. 2024.\nneeds review: Close call. 2023.",
    );
    expect(unconfirmedCellText(check([{ citation: "Real.", status: "matched" }]))).toBe("None");
    expect(unconfirmedCellText(undefined)).toBeUndefined();
  });

  it("says which model scored it", () => {
    expect(
      scoreCellText({
        submission_id: "s",
        pdf_path: "/p",
        title: "t",
        venue_id: "v",
        status: "completed",
        checked_at: "",
        attempts: 1,
        fraction_ai: 0.82,
        fraction_ai_assisted: 0,
        scored_from: "full_text",
        model_version: "4.0",
      }),
    ).toBe("82% AI, 0% AI-assisted (Pangram 4.0)");
  });

  it("falls back to H, I, J and K and reports the missing headers", () => {
    expect(sheetColumns(header)).toEqual({
      columns: { title: 0, authors: 2, score: 7, citations: 8, unconfirmed: 9, openreview: 10 },
      missing: ["citations", "unconfirmed", "openreview"],
    });
  });

  it("quotes the tab so a name with dashes or quotes stays one token", () => {
    expect(cellRange("Papers-iclr-feedback", 7, 20)).toBe("'Papers-iclr-feedback'!H20");
    expect(cellRange("Andrew's", 8, 3)).toBe("'Andrew''s'!I3");
  });
});

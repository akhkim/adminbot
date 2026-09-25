import { describe, expect, it } from "vitest";
import type { OpenReviewSubmission } from "../../contracts/openreview-citation-checks.js";
import {
  cellRange,
  citationCellText,
  matchSheetRows,
  scoreCellText,
  sheetColumns,
  sheetPaperRows,
} from "./integrity-sheet.js";

// Shapes from the lab's real sheet, with synthetic people: a PI and a lead on most rows, working
// titles that differ from the submitted ones, and a first author the sheet spells without a
// given name OpenReview has.
const header = ["Title", "Venue", "Authors", "Edit", "View", "Slack", "TODO", "Pangram Score"];
const grid = [
  header,
  [
    "When scaling interaction breaks cooperation",
    "",
    "Sekai Carr, Lead Person, Ada Singh, Pi Prof",
  ],
  ["Riemannian Manifold Steering", "", "Nora Oz, Lead Person, Pi Prof"],
  ["Benchmarking Safety Through Games", "", "Pepe Cob, Angelo Huang, Lead Person, Pi Prof"],
  ["Group Alignment for Cooperation", "", "Angelo Huang, Sam Marro, Pi Prof"],
  ["Joint scaffold optimization", "", "Yong Yang"],
  ["Transfer for reasoning", "", "Yong Yang, Jia Liu, Pi Prof"],
  ["Judging the judges", "", "Ada Singh, Sam Simko, Pi Prof"],
  ["Lead's other paper", "", "Lead Person, Pi Prof"],
  ["Another PI paper", "", "Someone Else, Pi Prof"],
];

function submission(title: string, authors: string[]): OpenReviewSubmission {
  return {
    id: title.slice(0, 12),
    title,
    venue_id: "ICLR.cc/2027/Conference/Submission",
    pdf_path: "/pdf/1.pdf",
    modified_at: 0,
    author_names: authors,
  };
}

const rows = sheetPaperRows(grid, sheetColumns(header));

describe("matching sheet rows to submissions", () => {
  it("finds the columns by header, falling back to A, C, H and I", () => {
    expect(sheetColumns(header)).toEqual({ title: 0, authors: 2, score: 7, citations: 8 });
    expect(sheetColumns([])).toEqual({ title: 0, authors: 2, score: 7, citations: 8 });
    expect(sheetColumns([...header, "Hallucinated citations"]).citations).toBe(8);
  });

  it("matches a sheet title that is the submitted title before its colon", () => {
    const paper = submission("Riemannian Manifold Steering: Geodesics of a Metric", ["Nora Oz"]);
    expect(matchSheetRows(rows, [paper]).matched.get(paper.id)?.row).toBe(3);
  });

  // "When scaling interaction..." was submitted as "Fool Me Once". Only the authors tie them, and
  // the sheet writes the first author without the given name OpenReview has.
  it("falls back to distinctive authors when the title was changed", () => {
    const paper = submission("Fool Me Once: Scaling Interaction Reveals Exploitation", [
      "Ulysses Sekai Carr",
      "Lead Person",
      "Ada Singh",
      "Pi Prof",
    ]);
    expect(matchSheetRows(rows, [paper]).matched.get(paper.id)?.row).toBe(2);
  });

  // The real mistake this guards against: a paper with no row matched to GT-HarmBench because the
  // PI and a lead are on both, and one distinctive co-author also wrote another paper.
  it("does not count the authors on most rows as evidence", () => {
    const paper = submission("Where Does Reasoning Fail?", [
      "Zed Jing",
      "Lead Person",
      "Yong Yang",
      "Angelo Huang",
      "Pi Prof",
    ]);
    const result = matchSheetRows(rows, [paper]);
    expect(result.matched.has(paper.id)).toBe(false);
    expect(result.unmatched).toEqual([paper]);
  });

  it("leaves a paper unmatched when two rows share as many of its authors", () => {
    const paper = submission("A renamed paper", ["Yong Yang", "Jia Liu", "Ada Singh", "Sam Simko"]);
    expect(matchSheetRows(rows, [paper]).matched.has(paper.id)).toBe(false);
  });

  it("does not let an author match take a row a title already claimed", () => {
    const titled = submission("Group Alignment for Cooperation", ["Angelo Huang", "Sam Marro"]);
    const other = submission("Something new", ["Angelo Huang", "Sam Marro"]);
    const result = matchSheetRows(rows, [titled, other]);
    expect(result.matched.get(titled.id)?.row).toBe(5);
    expect(result.matched.has(other.id)).toBe(false);
  });
});

describe("cell text", () => {
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

  it("writes references one per line, and nothing when there are none", () => {
    expect(citationCellText(["A. Nobody. 2031.", "B. Nobody. 2032."])).toBe(
      "A. Nobody. 2031.\nB. Nobody. 2032.",
    );
    expect(citationCellText([])).toBeUndefined();
  });

  it("quotes the tab so a name with dashes or quotes stays one token", () => {
    expect(cellRange("Papers-iclr-feedback", 7, 20)).toBe("'Papers-iclr-feedback'!H20");
    expect(cellRange("Andrew's", 8, 3)).toBe("'Andrew''s'!I3");
  });
});

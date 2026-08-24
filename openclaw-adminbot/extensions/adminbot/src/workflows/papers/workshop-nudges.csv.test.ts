import { describe, expect, it } from "vitest";
import { parseWorkshopAttendance, parseWorkshopNudgePapers } from "./workshop-nudges.csv.js";

const paperHeader =
  "paper_id,title,year,current_submission_state,topic_summary,lab_author_names,recipient_member_id,recipient_display_name,publication_source";
const attendanceHeader =
  "member_id,parent_conference_key,attendance_likelihood,source,last_confirmed_at";

describe("workshop nudge CSV inputs", () => {
  it("keeps title-only and unresolved paper records valid", () => {
    const papers = parseWorkshopNudgePapers(
      `${paperHeader}\nold-1,"A title, with punctuation",,,,,,,CV\n`,
    );
    expect(papers).toEqual([
      {
        paper_id: "old-1",
        title: "A title, with punctuation",
        lab_author_names: [],
        publication_sources: ["CV"],
      },
    ]);
  });

  it("parses recipient, provenance, authors, and an optional summary", () => {
    const papers = parseWorkshopNudgePapers(
      `${paperHeader}\np-1,Auditing agents,2021,Published,Safety evaluations,Ada|External,member-1,Ada,CV|Scholar\n`,
    );
    expect(papers[0]).toMatchObject({
      paper_id: "p-1",
      year: 2021,
      current_submission_state: "Published",
      topic_summary: "Safety evaluations",
      lab_author_names: ["Ada", "External"],
      recipient_member_id: "member-1",
      recipient_display_name: "Ada",
      publication_sources: ["CV", "Scholar"],
    });
  });

  it("requires the complete typed header and stable unique paper ids", () => {
    expect(() => parseWorkshopNudgePapers("paper_id,title\np-1,Paper\n")).toThrow(
      /missing required columns/u,
    );
    expect(() =>
      parseWorkshopNudgePapers(`${paperHeader}\np-1,One,,,,,,,,\np-1,Two,,,,,,,,\n`),
    ).toThrow(/duplicate paper_id p-1/u);
  });

  it("preserves explicit attendance percentages and blank unknowns", () => {
    expect(
      parseWorkshopAttendance(
        `${attendanceHeader}\nmember-1,neurips-2026,80,travel survey,2026-08-20\nmember-1,emnlp-2026,,profile,2026-08-19\n`,
      ),
    ).toEqual([
      {
        member_id: "member-1",
        parent_conference_key: "neurips-2026",
        attendance_likelihood: 80,
        source: "travel survey",
        last_confirmed_at: "2026-08-20",
      },
      {
        member_id: "member-1",
        parent_conference_key: "emnlp-2026",
        source: "profile",
        last_confirmed_at: "2026-08-19",
      },
    ]);
    expect(parseWorkshopAttendance(undefined)).toEqual([]);
    expect(() =>
      parseWorkshopAttendance(`${attendanceHeader}\nmember-1,neurips-2026,101,survey,2026-08-20\n`),
    ).toThrow(/integer from 0 to 100/u);
    expect(() =>
      parseWorkshopAttendance(`${attendanceHeader}\nmember-1,neurips-2026,80,survey,yesterday\n`),
    ).toThrow(/last_confirmed_at must be an ISO date or instant/u);
  });
});

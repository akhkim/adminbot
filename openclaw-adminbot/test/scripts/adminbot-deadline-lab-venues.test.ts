import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));

function runPython(body: string) {
  const result = execFileSync(
    "python3",
    [
      "-c",
      `
import json, sys
sys.path.insert(0, ${JSON.stringify(scripts)})
from adminbot_deadlines import AoEClock
from adminbot_lab_venues import lab_venue_conferences, lab_venue_counts, paper_family
from adminbot_conference_deadlines import confirm_with_openreview
clock = AoEClock.resolve('2035-01-02')
checked = lambda: '2035-01-02T12:00:00Z'
${body}
`,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(result.trim().split("\n").at(-1)!);
}

describe("lab venues from paper records", () => {
  it("reads the family out of a free-text venue without matching inside other words", () => {
    expect(
      runPython(
        "print(json.dumps([paper_family(v) for v in ['NAACL 2025 Findings', 'AACL-IJCNLP 2026', 'aaai 2027', 'Quaint Workshop', '']]))",
      ),
    ).toEqual(["NAACL", "AACL", "AAAI", "", ""]);
  });

  it("adds an open round for a lab venue the configured list does not cover", () => {
    const { rows, report, asked } = runPython(`
papers = [dict(venue='AAAI 2034'), dict(venue='AAAI 2033', venue_decision='accept'),
          dict(venue='ICLR 2034'), dict(venue='CVPR 2034'), dict(venue='')]
items = [dict(id='iclr2035_paper', venue_group='ICLR 2035', track='main')]
asked = []
def read(groups):
    asked.extend(groups)
    return {'AAAI.org/2036/Conference': '2035-07-20 23:59:00'}
rows, report = lab_venue_conferences(papers, items, {}, clock, read_deadlines=read, checked_at=checked)
print(json.dumps(dict(rows=rows, report=report, asked=asked)))`);
    // ICLR 2035 is curated already, so only its uncovered edition is looked up.
    expect(asked).toEqual([
      "AAAI.org/2035/Conference",
      "AAAI.org/2036/Conference",
      "ICLR.cc/2036/Conference",
    ]);
    expect(rows).toMatchObject([
      {
        id: "auto_aaai2036_submission",
        venue_family: "AAAI",
        venue_group: "AAAI 2036",
        track: "main",
        deadline_aoe: "2035-07-20 23:59:00",
        deadline_source_status: "openreview_only",
        deadline_source_evidence: "Tracked automatically: 2 lab paper records name AAAI.",
      },
    ]);
    expect(report).toEqual(["CVPR (1 paper; unrecognized venue)"]);
  });

  it("keeps the last sweep's rows when the paper records cannot be read", () => {
    const { rows } = runPython(`
previous = {'auto_aaai2036_submission': dict(id='auto_aaai2036_submission', deadline_aoe='2035-07-20 23:59:00'),
            'iclr2035_paper': dict(id='iclr2035_paper')}
rows, report = lab_venue_conferences(None, [], previous, clock, read_deadlines=lambda groups: {}, checked_at=checked)
print(json.dumps(dict(rows=rows)))`);
    expect(rows).toEqual([{ id: "auto_aaai2036_submission", deadline_aoe: "2035-07-20 23:59:00" }]);
  });

  it("counts every paper record, decided or not", () => {
    expect(
      runPython(
        "print(json.dumps(lab_venue_counts([dict(venue='EMNLP 2033', venue_decision='reject'), dict(venue='Findings of EMNLP 2034')])[0]))",
      ),
    ).toEqual({ EMNLP: 2 });
  });
});

describe("OpenReview confirmation of CFP-sourced conference rows", () => {
  const confirm = (row: string, portal: string) =>
    runPython(`
item = dict(${row}, id='arr_2026_october', _primary_attempted=True)
read = lambda ids: {i: dict(id=i, duedate_aoe='${portal}') for i in ids}
print(json.dumps(confirm_with_openreview([item], read, checked)[0]))`);

  it("confirms an announced date the portal agrees with and takes its clock", () => {
    expect(
      confirm(
        "deadline_aoe='2026-10-12 00:00:00', deadline_source_status='portal_unverified'",
        "2026-10-12 23:59:00",
      ),
    ).toMatchObject({
      deadline_aoe: "2026-10-12 23:59:00",
      deadline_time_precision: "exact",
      deadline_source_status: "official_date_matches_openreview",
    });
  });

  it("falls back to the portal when the official page is unavailable", () => {
    expect(
      confirm(
        "deadline_aoe='', deadline_source_status='source_unavailable'",
        "2026-10-12 23:59:00",
      ),
    ).toMatchObject({
      deadline_aoe: "2026-10-12 23:59:00",
      deadline_source_kind: "openreview",
      deadline_source_status: "openreview_only",
      _source_observed: true,
    });
  });

  it("records a disagreeing portal date without moving the deadline", () => {
    for (const status of ["portal_unverified", "source_unavailable"]) {
      expect(
        confirm(
          `deadline_aoe='2026-10-12 23:59:00', deadline_source_status='${status}'`,
          "2026-10-19 23:59:00",
        ),
      ).toMatchObject({
        deadline_aoe: "2026-10-12 23:59:00",
        deadline_source_status: status,
        openreview_invitation: { duedate_aoe: "2026-10-19 23:59:00" },
      });
    }
  });
});

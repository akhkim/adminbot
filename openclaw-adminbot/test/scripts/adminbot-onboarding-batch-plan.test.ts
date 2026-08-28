import { describe, expect, it } from "vitest";
import { buildPlan, parseEmailOverrides } from "../../scripts/adminbot-onboarding-batch-plan.ts";

// The columns the plan reads, at their real indices on the "Full Slack Member List" tab.
function sheetRow(fields: Partial<Record<string, string>>): string[] {
  const row = Array.from({ length: 26 }, () => "");
  row[0] = fields.name ?? "";
  row[4] = fields.correspondence ?? "";
  row[6] = fields.calendar ?? "";
  row[16] = fields.slackEmail ?? "";
  row[17] = fields.testOnboard ?? "";
  row[18] = fields.memberType ?? "";
  row[19] = fields.attributes ?? "";
  row[20] = fields.projects ?? "";
  row[22] = fields.tldr ?? "";
  return row;
}

const HEADER = sheetRow({ name: "" });

// The reviewed mapping is an input, not a constant in the script: it is keyed by personal
// addresses and changes every batch.
const MATCHES = {
  "youssef.saad@mail.utoronto.ca": "adminbot_and_causaltutor",
  "xinping.song@mail.utoronto.ca": "adminbot_only",
  "y4472wan@uwaterloo.ca": "adminbot_career_launch",
  "sergiusnyah@gmail.com": "causaltutor_rahul",
};

describe("onboarding batch plan", () => {
  it("matches applicants to the recommendation reviewed for them", () => {
    const rows = [
      HEADER,
      sheetRow({ slackEmail: "xinping.song@mail.utoronto.ca", attributes: "Andrew: AdminBot" }),
      sheetRow({ slackEmail: "y4472wan@uwaterloo.ca", attributes: "AdminBot Career Launch" }),
      sheetRow({ slackEmail: "sergiusnyah@gmail.com", attributes: "Rahul, causal tutor" }),
    ];
    const plan = buildPlan(rows, [2, 4], MATCHES);
    expect(plan.direct_matching.map((entry) => entry.values.recommendation)).toEqual([
      "adminbot_only",
      "adminbot_career_launch",
      "causaltutor_rahul",
    ]);
    // Every applicant still needs their own response link: there is no API that returns it.
    for (const entry of plan.direct_matching) {
      expect(entry.needs.join(" ")).toContain("application_form_link");
    }
  });

  // The form link and the causal topic are the two values a run can never fill, so they must show
  // up as needs rather than as a blank that ships.
  it("reports an unmatched applicant and an unfilled topic instead of guessing", () => {
    const rows = [
      HEADER,
      sheetRow({ slackEmail: "youssef.saad@mail.utoronto.ca", attributes: "Test 1 / Test 2" }),
      sheetRow({ slackEmail: "someone.new@example.edu", attributes: "Bryan: word play RL" }),
    ];
    const plan = buildPlan(rows, [2, 3], MATCHES);
    expect(plan.direct_matching[0]?.needs.join(" ")).toContain("causal_topic");
    expect(plan.direct_matching[0]?.values.task_recommendation).toBeUndefined();
    expect(plan.direct_matching[1]?.needs.join(" ")).toContain("no approved sentence");
  });

  it("skips a row that carries only a note, and surfaces a second address", () => {
    const rows = [
      HEADER,
      sheetRow({ attributes: "can Joeun review all EngSci applicants?" }),
      sheetRow({ slackEmail: "s.pavlovic1204@gmail.com\nemuhigir@andrew.cmu.edu" }),
    ];
    const plan = buildPlan(rows, [2, 3]);
    expect(plan.skipped[0]?.reason).toContain("no email address");
    expect(plan.direct_matching[0]?.email).toBe("s.pavlovic1204@gmail.com");
    expect(plan.direct_matching[0]?.other_addresses).toEqual(["emuhigir@andrew.cmu.edu"]);
  });

  // Excel hands "Test Onboard" back as a float; the batch is still 3.
  it("takes the Test Onboard 3 group whether the cell reads 3 or 3.0", () => {
    const rows = [
      HEADER,
      sheetRow({
        name: "Three",
        memberType: "alumni",
        testOnboard: "3",
        correspondence: "a@x.edu",
      }),
      sheetRow({
        name: "Float",
        memberType: "alumni",
        testOnboard: "3.0",
        correspondence: "b@x.edu",
      }),
      sheetRow({
        name: "Two",
        memberType: "alumni",
        testOnboard: "2.0",
        correspondence: "c@x.edu",
      }),
    ];
    const plan = buildPlan(rows, [99, 99]);
    expect(plan.test_onboard_3.map((entry) => entry.name)).toEqual(["Three", "Float"]);
  });

  // The live coauthor role outranks alumni, the same reading the roster import uses.
  it("resolves a multi-valued Member Type through the shared precedence", () => {
    const rows = [
      HEADER,
      sheetRow({
        name: "Both",
        memberType: "alumni, coauthor-major",
        testOnboard: "3.0",
        correspondence: "both@x.edu",
      }),
    ];
    const plan = buildPlan(rows, [99, 99]);
    expect(plan.test_onboard_3[0]?.template_id).toBe("coauthor_major");
    expect(plan.test_onboard_3[0]?.also_named).toEqual(["alumni"]);
  });

  // A subgroup with no template must be a named skip, not a silent drop -- that is how David Jenny
  // would otherwise vanish from the batch.
  it("skips a subgroup that has no onboarding template", () => {
    const rows = [
      HEADER,
      sheetRow({
        name: "David Jenny",
        memberType: "alumni, coauthor-discussant-or-designer",
        testOnboard: "3.0",
        correspondence: "dj@x.edu",
      }),
    ];
    const plan = buildPlan(rows, [99, 99]);
    expect(plan.test_onboard_3).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toContain("no onboarding template exists");
  });

  it("fills an address the sheet is missing from an override, and reports one it is not given", () => {
    const rows = [
      HEADER,
      sheetRow({ name: "Korinna Fragkia", memberType: "coauthor-minor", testOnboard: "3.0" }),
    ];
    expect(buildPlan(rows, [99, 99]).test_onboard_3[0]?.needs).toContain(
      "email: no address on this sheet row",
    );
    const overridden = buildPlan(
      rows,
      [99, 99],
      {},
      parseEmailOverrides(["--email", "Korinna Fragkia=korinna@example.edu"]),
    );
    expect(overridden.test_onboard_3[0]?.email).toBe("korinna@example.edu");
    expect(overridden.test_onboard_3[0]?.needs).toEqual([]);
  });
});

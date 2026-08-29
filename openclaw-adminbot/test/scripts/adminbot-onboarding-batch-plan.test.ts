import { describe, expect, it } from "vitest";
import {
  applicationLinksFromAttributes,
  buildPlan,
  parseEmailOverrides,
} from "../../scripts/adminbot-onboarding-batch-plan.ts";

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

  // An applicant with no reviewed sentence is reported; one whose sentence has only an optional
  // clause outstanding still gets their recommendation.
  it("reports an unmatched applicant, and still renders one with an optional clause missing", () => {
    const rows = [
      HEADER,
      sheetRow({ slackEmail: "youssef.saad@mail.utoronto.ca", attributes: "Test 1 / Test 2" }),
      sheetRow({ slackEmail: "someone.new@example.edu", attributes: "Bryan: word play RL" }),
    ];
    const plan = buildPlan(rows, [2, 3], MATCHES);
    expect(plan.direct_matching[0]?.values.task_recommendation).toContain(
      "learn about causality from scratch.",
    );
    expect(plan.direct_matching[0]?.needs.join(" ")).not.toContain("task_recommendation");
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

describe("cc and form links", () => {
  // The lead is resolved from the sheet's own first names, so a new lead works the day their row
  // exists rather than when someone remembers to update a list here.
  const DIRECTORY_ROWS = [
    HEADER,
    sheetRow({
      name: "Andrew Kim",
      correspondence: "andrew.personal@gmail.com",
      slackEmail: "akim@cs.toronto.edu",
    }),
    sheetRow({ name: "Rahul Shrestha", correspondence: "rahul@cs.toronto.edu" }),
    sheetRow({ slackEmail: "applicant@example.edu", attributes: "Andrew: AdminBot modular task" }),
  ];

  it("ccs the named lead at their institutional address, and always bccs tracking", () => {
    const plan = buildPlan(DIRECTORY_ROWS, [4, 4], { "applicant@example.edu": "adminbot_only" });
    const entry = plan.direct_matching[0];
    // Not andrew.personal@gmail.com: a lead cc'd on mail to an applicant is reached where their
    // institution put them.
    expect(entry?.cc).toEqual(["akim@cs.toronto.edu"]);
    expect(entry?.bcc).toEqual(["jinesis.adminbot@gmail.com"]);
  });

  it("reports an unresolvable lead rather than sending with an empty cc", () => {
    const rows = [
      HEADER,
      sheetRow({ slackEmail: "applicant@example.edu", attributes: "somebody we do not know" }),
    ];
    const plan = buildPlan(rows, [2, 2], { "applicant@example.edu": "adminbot_only" });
    expect(plan.direct_matching[0]?.cc).toEqual([]);
    expect(plan.direct_matching[0]?.needs.join(" ")).toContain("no project lead resolved");
  });

  // Two people share a first name: cc'ing the wrong one puts an applicant's file in front of
  // somebody uninvolved, so it asks instead.
  it("refuses to guess between two people with the same first name", () => {
    const rows = [
      HEADER,
      sheetRow({ name: "Rahul Shrestha", correspondence: "rahul.one@cs.example" }),
      sheetRow({ name: "Rahul Other", correspondence: "rahul.two@cs.example" }),
      sheetRow({ slackEmail: "applicant@example.edu", attributes: "Rahul: causal tutor" }),
    ];
    const plan = buildPlan(rows, [4, 4], { "applicant@example.edu": "adminbot_only" });
    expect(plan.direct_matching[0]?.cc).toEqual([]);
    expect(plan.direct_matching[0]?.needs.join(" ")).toContain("matches more than one person");
  });

  it("fills the form link when one is supplied, and needs it otherwise", () => {
    const matches = { "applicant@example.edu": "adminbot_only" };
    const withoutLink = buildPlan(DIRECTORY_ROWS, [4, 4], matches);
    expect(withoutLink.direct_matching[0]?.needs.join(" ")).toContain("application_form_link");
    expect(withoutLink.direct_matching[0]?.body).toContain("{application_form_link}");

    const link = "https://docs.google.com/forms/d/FORMID/edit#response=ACYDBN";
    const withLink = buildPlan(
      DIRECTORY_ROWS,
      [4, 4],
      matches,
      new Map(),
      {},
      {
        "applicant@example.edu": link,
      },
    );
    expect(withLink.direct_matching[0]?.values.application_form_link).toBe(link);
    expect(withLink.direct_matching[0]?.body).toContain(link);
    expect(withLink.direct_matching[0]?.needs.join(" ")).not.toContain("application_form_link");
  });
});

describe("application links in the sheet's notes", () => {
  const APPLICATION = "https://docs.google.com/document/d/1kZGmrQ/edit?rtpof=true";
  const TASK_DOC = "https://docs.google.com/document/d/1aH8qG5/edit?tab=t.0";

  // Some applicants sent a document instead of filling the form, and the link in the notes is the
  // only thing that shows the lead what they wrote.
  it("takes the URL on the 'Student application' line", () => {
    const found = applicationLinksFromAttributes(
      `Rahul, causal tutor human subject first\nStudent application: ${APPLICATION}`,
    );
    expect(found.application).toBe(APPLICATION);
    expect(found.others).toEqual([]);
  });

  // "Bryan: word play RL as interviews" is followed by the WordPlay *task* doc. Forwarding a task
  // brief as though it were the applicant's file is the same mistake as forwarding the blank form.
  it("never mistakes an unlabelled task doc for the application", () => {
    const found = applicationLinksFromAttributes(`Bryan: word play RL as interviews\n${TASK_DOC}`);
    expect(found.application).toBeUndefined();
    expect(found.others).toEqual([TASK_DOC]);
  });

  it("surfaces a second document rather than choosing between them", () => {
    const found = applicationLinksFromAttributes(
      `Kem, check if they could help\nStudent application: ${APPLICATION}\n${TASK_DOC}`,
    );
    expect(found.application).toBe(APPLICATION);
    expect(found.others).toEqual([TASK_DOC]);
  });

  it("fills application_form_link from the row, and reports the row that has none", () => {
    const withDoc = buildPlan(
      [
        HEADER,
        sheetRow({
          slackEmail: "doc@example.edu",
          attributes: `Rahul, causal tutor\nStudent application: ${APPLICATION}`,
        }),
      ],
      [2, 2],
      { "doc@example.edu": "cladder_rahul" },
    );
    expect(withDoc.direct_matching[0]?.values.application_form_link).toBe(APPLICATION);
    expect(withDoc.direct_matching[0]?.needs.join(" ")).not.toContain("application_form_link");

    const withTaskDocOnly = buildPlan(
      [HEADER, sheetRow({ slackEmail: "task@example.edu", attributes: `Bryan: RL\n${TASK_DOC}` })],
      [2, 2],
      { "task@example.edu": "wordplay_rl_bryan" },
    );
    expect(withTaskDocOnly.direct_matching[0]?.values.application_form_link).toBeUndefined();
    expect(withTaskDocOnly.direct_matching[0]?.other_links).toEqual([TASK_DOC]);
  });
});

describe("drafts", () => {
  const ENV: NodeJS.ProcessEnv = {
    ADMINBOT_SLACK_INVITE_URL: "https://join.slack.com/t/example/shared_invite/zt-example",
    ADMINBOT_CONTACT_EMAILS: "ops@example.com",
    ADMINBOT_BOT_EMAIL: "adminbot@example.com",
  };

  it("carries the composed mail on every entry, ready or not", () => {
    const rows = [
      HEADER,
      sheetRow({ slackEmail: "xinping.song@mail.utoronto.ca", attributes: "Andrew: AdminBot" }),
      sheetRow({
        name: "Yuen Chen",
        memberType: "alumni",
        testOnboard: "3.0",
        correspondence: "yuen@x.edu",
      }),
    ];
    const plan = buildPlan(rows, [2, 2], MATCHES, new Map(), ENV);

    const applicant = plan.direct_matching[0];
    expect(applicant?.subject).toBe("Your application to the Jinesis Lab");
    // The reviewed sentence is in the body, not just named in `values`.
    expect(applicant?.body).toContain("with Andrew for some coding test tasks");
    // The one value no run can fill stays visible rather than becoming a blank.
    expect(applicant?.body).toContain("{application_form_link}");

    const member = plan.test_onboard_3[0];
    // The greeting is derived from the sheet's name, the way the send derives it.
    expect(member?.body).toMatch(/^Hi Yuen,/u);
    expect(member?.subject).toBe("Staying Connected with the Jinesis Lab");
  });

  // Flattening to "label (url)" is lossy: nothing in it says which half was the anchor, so a
  // person pasting the draft into Gmail cannot rebuild the hyperlink. The bracket form survives.
  it("keeps links in the copy's [label](url) notation", () => {
    const rows = [
      HEADER,
      sheetRow({
        name: "Yuen Chen",
        memberType: "alumni",
        testOnboard: "3.0",
        correspondence: "yuen@x.edu",
      }),
    ];
    const [entry] = buildPlan(rows, [99, 99], {}, new Map(), ENV).test_onboard_3;
    expect(entry?.body).toContain("[Zhijing-Jin](https://www.linkedin.com/in/zhijing-jin/)");
    expect(entry?.body).not.toContain("Zhijing-Jin (https://");
  });

  // A machine with no deployment config must still produce a reviewable draft.
  it("still drafts when the deployment tokens are unset", () => {
    const rows = [
      HEADER,
      sheetRow({
        name: "Yuen Chen",
        memberType: "alumni",
        testOnboard: "3.0",
        correspondence: "yuen@x.edu",
      }),
    ];
    const [entry] = buildPlan(rows, [99, 99], {}, new Map(), {}).test_onboard_3;
    expect(entry?.body).toContain("Hi Yuen,");
    expect(entry?.body).toContain("{slack_invite_url}");
  });
});

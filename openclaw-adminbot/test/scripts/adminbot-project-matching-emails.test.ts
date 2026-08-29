import { describe, expect, it } from "vitest";
import { composeOnboardingGuide } from "../../extensions/adminbot/src/workflows/onboarding/guide.js";
import { AdminBotEmailModel } from "../../scripts/adminbot-email-model.js";
import {
  addressesIn,
  applicationDocsIn,
  buildLeadIndex,
  type Lead,
  PROJECT_LEADS,
  resolveLeads,
  rowToMatches,
  taskDocIn,
  TEMPLATE_ID,
} from "../../scripts/adminbot-project-matching-emails.js";

const ANDREW: Lead = { firstName: "andrew", name: "Andrew Kim", email: "akim@cs.toronto.edu" };
const RAHUL: Lead = { firstName: "rahul", name: "Rahul Shrestha", email: "rahulbs@cs.toronto.edu" };
const KEM: Lead = { firstName: "kem", name: "Kem Nguyen-Le", email: "nlpa@umd.edu" };

const DOC_A = "https://docs.google.com/document/d/1cjbJb4g0twZkMgFwXmO1Hkx9kKUwyN4F/edit";
const DOC_B = "https://docs.google.com/document/d/1nadDTLY8WMsLWCJ-4GXsuFzp81MLgxmp/edit";

describe("reading the sheet", () => {
  it("splits a cell holding several addresses", () => {
    expect(addressesIn("s.pavlovic1204@gmail.com\nemuhigir@andrew.cmu.edu")).toEqual([
      "s.pavlovic1204@gmail.com",
      "emuhigir@andrew.cmu.edu",
    ]);
    expect(addressesIn("")).toEqual([]);
    expect(addressesIn("not an address")).toEqual([]);
  });

  // The lab address in column Q is the one a lead is cc'd at; several leads keep a personal
  // address in column E that they do not use for lab correspondence.
  it("prefers the lab address over the personal one, and takes the first namesake", () => {
    const index = buildLeadIndex(
      [
        ["Andrew Kim", "andrewkihyun@gmail.com", "akim@cs.toronto.edu"],
        ["Andrew Someone-Else", "other@example.com", "other@cs.toronto.edu"],
        ["Kem Nguyen-Le", "nlpa@umd.edu", ""],
      ],
      0,
      1,
      2,
    );
    expect(index.get("andrew")?.email).toBe("akim@cs.toronto.edu");
    expect(index.get("kem")?.email).toBe("nlpa@umd.edu");
  });

  it("names the leads column T mentions, in the order it mentions them", () => {
    const index = new Map([
      ["andrew", ANDREW],
      ["rahul", RAHUL],
    ]);
    expect(
      resolveLeads("Test 1, Andrew: AdminBot modular task\nTest 2, Rahul: CausalTutor", index),
    ).toEqual({ leads: [ANDREW, RAHUL], via: "named" });
    expect(resolveLeads("Rahul: CLadder leaderboard", index)).toEqual({
      leads: [RAHUL],
      via: "named",
    });
  });

  it("does not match a lead's name inside a longer word", () => {
    expect(resolveLeads("Kemal asked about this", new Map([["kem", KEM]])).leads).toEqual([]);
    expect(resolveLeads("Kem, check the FAccT paper", new Map([["kem", KEM]])).leads).toEqual([
      KEM,
    ]);
  });

  // Half the rows in the batch say only what the work is -- "AdminBot privacy logic" -- because
  // the lab knows whose project that is. Without this they would go out cc'ing nobody.
  it("falls back to the project's owner when the note names no one", () => {
    const index = new Map([
      ["andrew", ANDREW],
      ["rahul", RAHUL],
    ]);
    expect(resolveLeads("AdminBot privacy logic", index)).toEqual({
      leads: [ANDREW],
      via: "project",
    });
    expect(resolveLeads("AdminBot see her Career Launch Agent", index).leads).toEqual([ANDREW]);
    expect(resolveLeads("something unrelated", index)).toEqual({ leads: [], via: "none" });
  });

  // A note that names someone has reassigned the work; the map must not override it.
  it("prefers a name in the note over the project map", () => {
    const index = new Map([
      ["andrew", ANDREW],
      ["rahul", RAHUL],
    ]);
    expect(resolveLeads("Rahul: AdminBot modular task", index)).toEqual({
      leads: [RAHUL],
      via: "named",
    });
  });

  it("every project in the map names a first name, so it can resolve against the sheet", () => {
    for (const [keyword, firstName] of Object.entries(PROJECT_LEADS)) {
      expect(firstName, keyword).toBe(firstName.toLowerCase());
      expect(firstName, keyword).not.toContain(" ");
    }
  });

  // A doc on the row is the lead's task description, unless it sits under "Student application:",
  // in which case it is the applicant's own file and must not be offered as the task.
  it("tells a lead's task doc from an applicant's application document", () => {
    const task = "Bryan: word play RL as interviews\nhttps://docs.google.com/document/d/1aH8/edit";
    expect(taskDocIn(task)).toBe("https://docs.google.com/document/d/1aH8/edit");
    expect(applicationDocsIn(task)).toEqual([]);

    const application = `Rahul, causal tutor first\nStudent application: ${DOC_A}`;
    expect(taskDocIn(application)).toBeUndefined();
    expect(applicationDocsIn(application)).toEqual([DOC_A]);
  });
});

describe("choosing each applicant's application link", () => {
  const formLinks = new Map([
    ["youssef@example.com", "https://docs.google.com/forms/d/e/FORM/viewform?edit2=2_ABC"],
  ]);

  it("uses the applicant's own form response when they filed one", () => {
    const [match] = rowToMatches({
      sheetRow: 169,
      addresses: ["youssef@example.com"],
      note: "Andrew: AdminBot modular task",
      leads: [ANDREW],
      leadsVia: "named" as const,
      formLinks,
    });
    expect(match!.applicationLink).toBe(
      "https://docs.google.com/forms/d/e/FORM/viewform?edit2=2_ABC",
    );
    expect(match!.needs).toEqual([]);
  });

  it("falls back to the application document when one applicant filed none", () => {
    const [match] = rowToMatches({
      sheetRow: 182,
      addresses: ["sergius@example.com"],
      note: `Rahul, causal tutor human subject first\nStudent application: ${DOC_A}`,
      leads: [RAHUL],
      leadsVia: "named" as const,
      formLinks,
    });
    expect(match!.applicationLink).toBe(DOC_A);
    expect(match!.needs).toEqual([]);
  });

  // The regression this whole guard exists for: sheet row 181 lists two applicants and two
  // documents, and pairing them by position mailed one applicant the other's application.
  it("refuses to pair several applicants with several documents", () => {
    const matches = rowToMatches({
      sheetRow: 181,
      addresses: ["s.pavlovic1204@gmail.com", "emuhigir@andrew.cmu.edu"],
      note: `Kem, check the FAccT paper\nStudent application: ${DOC_A}\n${DOC_B}`,
      leads: [KEM],
      leadsVia: "named" as const,
      formLinks,
    });
    expect(matches).toHaveLength(2);
    for (const match of matches) {
      expect(match.applicationLink).toBeUndefined();
      expect(match.needs.join(" ")).toContain("no stated pairing");
      expect(match.otherLinks).toEqual([DOC_A, DOC_B]);
    }
  });

  it("refuses one document shared between several applicants", () => {
    const matches = rowToMatches({
      sheetRow: 181,
      addresses: ["one@example.com", "two@example.com"],
      note: `Kem, check the FAccT paper\nStudent application: ${DOC_A}`,
      leads: [KEM],
      leadsVia: "named" as const,
      formLinks,
    });
    for (const match of matches) {
      expect(match.applicationLink).toBeUndefined();
      expect(match.needs.join(" ")).toContain("not clear whose it is");
    }
  });

  it("flags an applicant with no response and no document, rather than mailing a bare form", () => {
    const [match] = rowToMatches({
      sheetRow: 170,
      addresses: ["nobody@example.com"],
      note: "Andrew: AdminBot modular task",
      leads: [ANDREW],
      leadsVia: "named" as const,
      formLinks,
    });
    expect(match!.applicationLink).toBeUndefined();
    expect(match!.needs.join(" ")).toContain("no response to the application form");
  });

  it("flags a row whose note names no lead, since nobody would be cc'd", () => {
    const [match] = rowToMatches({
      sheetRow: 171,
      addresses: ["youssef@example.com"],
      note: "Low privacy but difficult AdminBot tasks",
      leads: [],
      leadsVia: "none" as const,
      formLinks,
    });
    expect(match!.needs.join(" ")).toContain("names no lead");
  });

  it("gives each applicant on a shared row the other's address, not the other's link", () => {
    const matches = rowToMatches({
      sheetRow: 181,
      addresses: ["one@example.com", "two@example.com"],
      note: "Kem, check the FAccT paper",
      leads: [KEM],
      leadsVia: "named" as const,
      formLinks,
    });
    expect(matches[0]!.otherAddresses).toEqual(["two@example.com"]);
    expect(matches[1]!.otherAddresses).toEqual(["one@example.com"]);
  });
});

describe("the composed mail", () => {
  const recommendation =
    "Zhijing's personal recommendation is to match you (1) with Andrew for a test task about "
    + "AdminBot programming, and (2) with Rahul to do a human test to use CausalTutor. Note that "
    + "this can still be totally up to the project lead to decide your suitability.";

  it("keeps the template sentence and drops the link inside it", () => {
    const result = composeOnboardingGuide(TEMPLATE_ID, {
      application_form_link: "https://docs.google.com/forms/d/e/FORM/viewform?edit2=2_ABC",
      task_recommendation: recommendation,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.guide.body).toContain(
      "we have forwarded your application form "
        + "https://docs.google.com/forms/d/e/FORM/viewform?edit2=2_ABC and skill sets to our "
        + "Jinesis project lead cc'ed.",
    );
    expect(result.guide.body).toContain(recommendation);
    expect(result.guide.body).not.toMatch(/\{[a-z_]+\}/u);
  });

  it("refuses to compose without a link rather than mailing a half-rendered sentence", () => {
    const result = composeOnboardingGuide(TEMPLATE_ID, { task_recommendation: recommendation });
    expect(result).toMatchObject({ ok: false, reason: "missing-values" });
    expect(result.ok ? [] : result.missing).toContain("application_form_link");
  });
});

describe("the recommendation the model is held to", () => {
  // The applicant reads this sentence and nothing else about their match, so a model that drifts
  // has to fail the generation rather than mail a sentence in the wrong shape.
  const good =
    "Zhijing's personal recommendation is to match you with Andrew for a test task about AdminBot "
    + "programming. Note that this can still be totally up to the project lead to decide your "
    + "suitability.";

  async function generate(content: string): Promise<{ recommendation: string }> {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ recommendation: content }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;
    return new AdminBotEmailModel(fetchImpl, {}).projectMatch({
      matchingNote: "Andrew: AdminBot modular task",
      leadFirstNames: ["andrew"],
    });
  }

  it("accepts a sentence in the agreed shape", async () => {
    await expect(generate(good)).resolves.toEqual({ recommendation: good });
  });

  it("rejects one that does not open with Zhijing's recommendation", async () => {
    await expect(
      generate(good.replace("Zhijing's personal", "Andrew's personal")),
    ).rejects.toThrow();
  });

  it("rejects one that drops the closing caveat", async () => {
    await expect(generate(good.replace(/ Note that.*$/u, ""))).rejects.toThrow();
  });

  // Column T says things like "Test 1, Andrew: ..." and "Low privacy but difficult". None of it
  // is for the applicant.
  it("rejects one that repeats the sheet's internal shorthand", async () => {
    await expect(
      generate(good.replace("a test task about AdminBot programming", "the Test 1 task")),
    ).rejects.toThrow();
  });
});

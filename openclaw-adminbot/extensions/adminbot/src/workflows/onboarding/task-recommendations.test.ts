import { describe, expect, it } from "vitest";
import { ADMINBOT_ONBOARDING_TEMPLATES } from "./emails.js";
import { createAdminBotOnboardingSender } from "./guide-sender.js";
import { applicantResponseLinkProblem } from "./guide.js";
import {
  ADMINBOT_TASK_RECOMMENDATIONS,
  RETIRED_RECOMMENDATION_PHRASES,
  renderTaskRecommendation,
} from "./task-recommendations.js";

// The public form URL from the review: it opens an empty questionnaire, so forwarding it tells a
// project lead nothing about the applicant they are being asked to judge.
const BLANK_FORM =
  "https://docs.google.com/forms/d/e/1FAIpQLSdyRYBiLPFUaaUC5v4ATIUwQpYPgmjRja33qwZFvH6BoIRCAA/viewform";
const OWN_RESPONSE = `${BLANK_FORM}?edit2=2_ABaOnud_example_token`;

describe("task recommendations", () => {
  it("renders each catalog entry with no placeholder left behind", () => {
    for (const recommendation of ADMINBOT_TASK_RECOMMENDATIONS) {
      const values = Object.fromEntries(
        (recommendation.placeholders ?? []).map((placeholder) => [
          placeholder.token,
          "causal discovery",
        ]),
      );
      const result = renderTaskRecommendation(recommendation.id, values);
      expect(result.ok, recommendation.id).toBe(true);
      expect(result.ok ? result.text : "").not.toMatch(/\{[a-z_]+\}/u);
    }
  });

  // The sentence claims to be Zhijing's personal judgement about one person, so a half-filled
  // version of it is worse than no mail.
  it("refuses rather than shipping an unfilled topic", () => {
    expect(renderTaskRecommendation("adminbot_and_causaltutor")).toMatchObject({
      ok: false,
      reason: "missing-values",
      missing: ["causal_topic"],
    });
    expect(renderTaskRecommendation("no_such_id")).toMatchObject({
      ok: false,
      reason: "unknown-id",
    });
  });

  // Both phrases were struck by name in the review: the WordPlay task was the hard-coded default
  // that produced mismatched recommendations, and the "doc they will share with you" clause
  // promised something that never happens.
  it("keeps the retired phrases out of the catalog and the templates", () => {
    const catalog = ADMINBOT_TASK_RECOMMENDATIONS.map((entry) => entry.text).join("\n");
    const templates = ADMINBOT_ONBOARDING_TEMPLATES.map(
      (entry) => `${entry.subject ?? ""}\n${entry.body}`,
    ).join("\n");
    for (const phrase of RETIRED_RECOMMENDATION_PHRASES) {
      expect(catalog, phrase).not.toContain(phrase);
      expect(templates, phrase).not.toContain(phrase);
    }
  });

  it("names Andrew for the adminbot-only default", () => {
    const result = renderTaskRecommendation("adminbot_only");
    expect(result.ok && result.text).toContain("with Andrew for some coding test tasks");
  });
});

describe("application form link", () => {
  it("rejects the blank form and accepts a per-response link", () => {
    expect(applicantResponseLinkProblem(BLANK_FORM)).toContain("blank form");
    expect(applicantResponseLinkProblem(OWN_RESPONSE)).toBeUndefined();
    // A prefilled link identifies one person's answers too.
    expect(applicantResponseLinkProblem(`${BLANK_FORM}?usp=pp_url&entry.123=Ada`)).toBeUndefined();
  });

  it("leaves non-form links alone and reports a non-URL", () => {
    expect(
      applicantResponseLinkProblem("https://drive.google.com/file/d/abc/view"),
    ).toBeUndefined();
    expect(applicantResponseLinkProblem(undefined)).toBeUndefined();
    expect(applicantResponseLinkProblem("not a url")).toContain("not a URL");
  });

  it("refuses the send that would forward a blank form", async () => {
    const sent: string[] = [];
    const sender = createAdminBotOnboardingSender({
      env: {
        ADMINBOT_SLACK_INVITE_URL: "https://join.slack.com/t/example/shared_invite/zt-example",
        ADMINBOT_CONTACT_EMAILS: "ops@example.com",
        ADMINBOT_BOT_EMAIL: "adminbot@example.com",
      },
      sendEmail: async ({ body }) => {
        sent.push(body);
      },
    });
    const request = {
      template_id: "interview_invite_project_matching",
      name: "Ada Lovelace",
      email: "ada@example.edu",
      values: {
        application_form_link: BLANK_FORM,
        task_recommendation: "Zhijing's personal recommendation is to match you with Andrew.",
      },
    };
    const refused = await sender(request);
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? "" : refused.error.message).toContain("blank form");
    expect(sent).toHaveLength(0);

    const allowed = await sender({
      ...request,
      values: { ...request.values, application_form_link: OWN_RESPONSE },
    });
    expect(allowed.ok).toBe(true);
    expect(sent[0]).toContain("Zhijing's personal recommendation is to match you with Andrew.");
    expect(sent[0]).not.toMatch(/\{[a-z_]+\}/u);
  });
});

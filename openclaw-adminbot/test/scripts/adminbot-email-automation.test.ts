import { describe, expect, it } from "vitest";
import {
  authorizeClassification,
  formatTalkLatex,
  resolveEmailAutomationSlackAccount,
  type EmailMessage,
} from "../../scripts/adminbot-email-automation.js";
import type { ModelClassification } from "../../scripts/adminbot-email-model.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const message = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  id: "m1",
  threadId: "t1",
  from: "student@example.com",
  fromName: "Genis Example",
  subject: "Research opportunity",
  body: "I would like to join your lab for a research opportunity.",
  ...overrides,
});

const classification = (overrides: Partial<ModelClassification> = {}): ModelClassification => ({
  category: "student_reachout",
  confidence: 0.98,
  reason: "student asks to join the lab",
  decision: null,
  candidateEmail: null,
  candidateName: null,
  ...overrides,
});

describe("adminbot email automation", () => {
  it("accepts high-confidence student outreach for LLM-guided handling", () => {
    expect(authorizeClassification(message(), classification()).category).toBe("student_reachout");
  });

  it("requires the real sender and complete model extraction for onboarding", () => {
    const direct = classification({
      category: "onboarding_instruction",
      reason: "accept directly",
      decision: "direct",
      candidateEmail: "candidate@example.com",
      candidateName: "Candidate",
    });
    expect(authorizeClassification(message(), direct).category).toBe("unknown");
    expect(authorizeClassification(message({ from: "zjin@cs.toronto.edu" }), direct)).toMatchObject(
      {
        category: "onboarding_instruction",
        decision: "direct",
        candidateEmail: "candidate@example.com",
      },
    );
    expect(
      authorizeClassification(message({ from: "andrewkihyun@gmail.com" }), direct).category,
    ).toBe("unknown");
  });

  it("recognizes only tracked candidate followups", () => {
    const followup = classification({
      category: "onboarding_followup",
      reason: "candidate supplied a department email",
      decision: null,
      candidateEmail: "candidate@cs.toronto.edu",
    });
    expect(
      authorizeClassification(message({ from: "candidate@example.com" }), followup, {
        candidate_email: "candidate@example.com",
        decision: "direct",
      }),
    ).toMatchObject({
      category: "onboarding_followup",
      decision: "direct",
      candidateEmail: "candidate@example.com",
    });
    expect(authorizeClassification(message(), followup).category).toBe("unknown");
  });

  it("rejects low-confidence and unauthorized privileged classifications", () => {
    expect(authorizeClassification(message(), classification({ confidence: 0.79 })).category).toBe(
      "unknown",
    );
    expect(
      authorizeClassification(
        message(),
        classification({
          category: "calendar_event",
          reason: "calendar request",
        }),
      ).category,
    ).toBe("unknown");
  });

  it("resolves env-backed Slack SecretRefs before standalone token reads", async () => {
    const cfg = {
      channels: {
        slack: {
          accounts: {
            default: {
              botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
              userToken: { source: "env", provider: "default", id: "SLACK_USER_TOKEN" },
            },
          },
        },
      },
    } as OpenClawConfig;

    const account = await resolveEmailAutomationSlackAccount({
      cfg,
      env: {
        ...process.env,
        SLACK_BOT_TOKEN: "xoxb-resolved-bot-token",
        SLACK_USER_TOKEN: "xoxp-resolved-user-token",
      },
    });

    expect(account.botToken).toBe("xoxb-resolved-bot-token");
    expect(account.userToken).toBe("xoxp-resolved-user-token");
  });

  it("formats the requested CV talk LaTex structure", () => {
    expect(
      formatTalkLatex({
        title: "Emergent AI Safety Risks in Multi-Agent LLMs",
        venue: "Invited Keynote at the Cooperative AI Foundation Summer School 2026",
        location: "Toronto, Canada",
        date: "2026/8/3-4",
        upcoming: true,
      }),
    ).toBe(
      "\\item \\cvtalk{Emergent AI Safety Risks in Multi-Agent LLMs}{(Upcoming) Invited Keynote at the Cooperative AI Foundation Summer School 2026, Toronto, Canada}{2026/8/3-4}",
    );
  });
});

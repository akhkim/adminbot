import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authorizeClassification,
  formatTalkLatex,
  outcomeLabelChange,
  shouldTrashAfterFiling,
  resolveEmailAutomationSlackAccount,
  type EmailMessage,
} from "../../scripts/adminbot-email-automation.js";
import type { ModelClassification } from "../../scripts/adminbot-email-model.js";
import type { OpenClawConfig } from "../../src/config/types/openclaw.js";

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

// The privileged-sender allowlist is deployment configuration; without it nobody is privileged.
// Set here so the authorization tests exercise a configured deployment.
beforeAll(() => {
  vi.stubEnv("ADMINBOT_ONBOARDING_SENDERS", "pi@example.edu,pi.admin@example.edu");
  vi.stubEnv("ADMINBOT_CONTACT_EMAILS", "ops@example.com");
});
afterAll(() => {
  vi.unstubAllEnvs();
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
    expect(authorizeClassification(message({ from: "pi@example.edu" }), direct)).toMatchObject({
      category: "onboarding_instruction",
      decision: "direct",
      candidateEmail: "candidate@example.com",
    });
    expect(authorizeClassification(message({ from: "ops@example.com" }), direct).category).toBe(
      "unknown",
    );
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

  describe("outcomeLabelChange", () => {
    it("files a handled message out of the inbox", () => {
      const change = outcomeLabelChange("completed");
      expect(change.add).toEqual(["AdminBot/Handled"]);
      // The inbox is the to-do list: what the automation finished does not belong on it.
      expect(change.remove).toContain("INBOX");
    });

    it("leaves the ones needing a person in the inbox, labelled with why", () => {
      for (const outcome of ["needs_review", "failed"] as const) {
        const change = outcomeLabelChange(outcome);
        // This is the whole reason these are labels and not a trash call: a failure that was
        // deleted is a failure nobody ever acts on, and a failure left unlabelled in the inbox
        // looks exactly like mail that has not been processed yet.
        expect(change.remove).not.toContain("INBOX");
      }
      expect(outcomeLabelChange("needs_review").add).toEqual(["AdminBot/Needs Review"]);
      expect(outcomeLabelChange("failed").add).toEqual(["AdminBot/Error"]);
    });

    it("clears the other two outcomes, so a retried message never carries both", () => {
      const change = outcomeLabelChange("completed");
      expect(change.remove).toContain("AdminBot/Error");
      expect(change.remove).toContain("AdminBot/Needs Review");
      expect(change.remove).not.toContain("AdminBot/Handled");
    });
  });

  describe("shouldTrashAfterFiling", () => {
    it("trashes a fully handled message by default", () => {
      expect(shouldTrashAfterFiling("completed", {})).toBe(true);
      expect(shouldTrashAfterFiling("completed", { ADMINBOT_EMAIL_TRASH_HANDLED: "1" })).toBe(true);
    });

    it("never trashes an outcome that still needs a person", () => {
      // The failure mode this guards is the one that made the script stop deleting in the first
      // place: a failure that was deleted is a failure nobody ever acts on.
      for (const outcome of ["needs_review", "failed"] as const) {
        expect(shouldTrashAfterFiling(outcome, {})).toBe(false);
        expect(shouldTrashAfterFiling(outcome, { ADMINBOT_EMAIL_TRASH_HANDLED: "1" })).toBe(false);
      }
    });

    it("can be turned off entirely, back to labelling only", () => {
      expect(shouldTrashAfterFiling("completed", { ADMINBOT_EMAIL_TRASH_HANDLED: "0" })).toBe(false);
      expect(shouldTrashAfterFiling("completed", { ADMINBOT_EMAIL_TRASH_HANDLED: " 0 " })).toBe(
        false,
      );
    });
  });
});

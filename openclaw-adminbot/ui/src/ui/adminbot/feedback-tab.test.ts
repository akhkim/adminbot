import { describe, expect, it } from "vitest";
import { feedbackConfigForTab } from "./feedback-tab.ts";

describe("feedbackConfigForTab", () => {
  it("returns a config for every member-visible AdminBot tab", () => {
    for (const tab of [
      "dashboard",
      "profile",
      "adminbotTimeAvailability",
      "myWork",
      "labSharing",
      "adminbotMembers",
      "adminbotReimbursements",
      "adminbotDeadlines",
    ] as const) {
      expect(feedbackConfigForTab(tab)).not.toBeNull();
    }
  });

  it("returns null for admin-only AdminBot tabs", () => {
    for (const tab of [
      "adminbot",
      "adminbotRegistrations",
      "adminbotOnboarding",
      "adminbotSettings",
      "adminbotPapers",
      "adminbotAnnouncements",
      "adminbotCalendar",
    ] as const) {
      expect(feedbackConfigForTab(tab)).toBeNull();
    }
  });

  it("points each config at its own source file and stable feature id", () => {
    const myWork = feedbackConfigForTab("myWork");
    expect(myWork?.featureId).toBe("my-work");
    expect(myWork?.githubFile).toContain("my-work.ts");
    const reimbursements = feedbackConfigForTab("adminbotReimbursements");
    expect(reimbursements?.featureId).toBe("reimbursements");
    expect(reimbursements?.githubFile).toContain("reimbursements.ts");
  });

  it("returns null for native OpenClaw surfaces", () => {
    for (const tab of ["chat", "overview", "activity", "sessions", "config", "instances"] as const) {
      expect(feedbackConfigForTab(tab)).toBeNull();
    }
  });
});
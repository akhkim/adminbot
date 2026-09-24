import { describe, expect, it } from "vitest";
import { needsLabRoster } from "./roster-required.ts";

describe("direct tab entry roster loading", () => {
  it("keeps the dashboard, profile, and unrelated pages on the self-only cold path", () => {
    for (const tab of [
      "dashboard",
      "profile",
      "adminbotTimeAvailability",
      "adminbotDeadlines",
      "adminbotReimbursements",
      "adminbotOpportunities",
    ]) {
      expect(needsLabRoster(tab, "general", null)).toBe(false);
    }
  });

  it("loads roster for pages that read peers or lab-wide counts", () => {
    expect(needsLabRoster("adminbot", "general", "papers")).toBe(true);
    expect(needsLabRoster("adminbotPapers", "admin", "papers")).toBe(true);
    expect(needsLabRoster("myWork", "general", null)).toBe(true);
    expect(needsLabRoster("adminbotTimeAvailability", "admin", null)).toBe(true);
    for (const tab of ["adminbotMeetings", "adminbotBadges", "adminbotCalendar"]) {
      expect(needsLabRoster(tab, "admin", null)).toBe(true);
    }
    expect(needsLabRoster("adminbotMembers", "admin", "members")).toBe(false);
    expect(needsLabRoster("adminbotMembers", "general", "members")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { needsLabPapers } from "./papers-required.ts";

describe("page paper dependencies", () => {
  it("keeps Meeting Recordings, Time Availability, and unrelated pages off the full paper read", () => {
    for (const tab of [
      "adminbotMeetings",
      "adminbotTimeAvailability",
      "adminbotSettings",
      "adminbot",
      "labSharing",
      "adminbotDeadlines",
    ]) {
      expect(needsLabPapers(tab)).toBe(false);
    }
  });

  it("loads papers for every page that renders them or uses them in filters", () => {
    for (const tab of [
      "dashboard",
      "profile",
      "myWork",
      "adminbotMembers",
      "adminbotPapers",
      "adminbotAnnouncements",
      "adminbotCalendar",
      "adminbotProfessor",
      "adminbotGrantReport",
    ]) {
      expect(needsLabPapers(tab)).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import { needsLabPapers, paperScopeForTab, papersReadyFor } from "./papers-required.ts";

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

describe("paper scope", () => {
  it("reads only the viewer's own papers for the Profile and a plain member's Dashboard", () => {
    expect(paperScopeForTab("profile", "admin")).toBe("own");
    expect(paperScopeForTab("dashboard", "member")).toBe("own");
    expect(paperScopeForTab("dashboard", "admin")).toBe("lab");
    expect(paperScopeForTab("myWork", "member")).toBe("lab");
  });

  it("lets the lab list satisfy an own page but never the reverse", () => {
    expect(papersReadyFor({ papersLoadedAt: 1 }, "own")).toBe(true);
    expect(papersReadyFor({ papersLoadedAt: null, ownPapersLoadedAt: 1 }, "own")).toBe(true);
    expect(papersReadyFor({ papersLoadedAt: null, ownPapersLoadedAt: 1 }, "lab")).toBe(false);
    expect(papersReadyFor(undefined, "own")).toBe(false);
  });
});

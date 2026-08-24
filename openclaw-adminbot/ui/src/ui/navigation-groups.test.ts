// Control UI tests cover navigation groups behavior.
import { describe, expect, it } from "vitest";
import {
  SETTINGS_TABS,
  TAB_GROUPS,
  isSettingsTab,
  isTabInGroup,
  tabFromPath,
} from "./navigation.ts";

describe("TAB_GROUPS", () => {
  it("collapses the upstream operator surfaces into one OpenClaw group", () => {
    const openclaw = TAB_GROUPS.find((group) => group.label === "openclaw");
    expect(openclaw?.tabs).toEqual([
      "overview",
      "activity",
      "sessions",
      "usage",
      "agents",
      "skills",
      "nodes",
      "config",
    ]);
    // Retired from the sidebar for this deployment: one gateway, one host, no agent work board.
    // Nodes stays -- it is the device-pairing approval surface.
    for (const retired of ["workboard", "instances", "dreams"]) {
      expect(TAB_GROUPS.flatMap((group) => group.tabs as readonly string[])).not.toContain(retired);
    }
    expect(SETTINGS_TABS.every((tab) => isSettingsTab(tab))).toBe(true);
    // Channel management stays a settings slice reached from inside the config page.
    expect(SETTINGS_TABS).toContain("channels");
  });

  it("orders the sidebar member-first, with the two privileged groups last", () => {
    expect(TAB_GROUPS.map((group) => group.label)).toEqual([
      "home",
      "myProfile",
      "myProjects",
      "generalTools",
      "labSharing",
      "admin",
      "openclaw",
    ]);
  });

  it("groups the member surfaces by what a person came to do", () => {
    const byLabel = (label: string) => TAB_GROUPS.find((group) => group.label === label)?.tabs;

    expect(byLabel("home")).toEqual(["dashboard"]);
    // Your own schedule is a thing you edit about yourself, so it sits with your profile rather
    // than among the shared tools.
    expect(byLabel("myProfile")).toEqual(["profile", "adminbotTimeAvailability"]);
    // Active Papers is the lab-wide pipeline, so it lives under Admin now, not "my" work.
    expect(byLabel("myProjects")).toEqual(["myWork"]);
    // Ordered by how often a member reaches for them, not alphabetically.
    expect(byLabel("generalTools")).toEqual([
      "adminbotLogistics",
      "adminbotReimbursements",
      "adminbotDeadlines",
      "adminbotConferencePapers",
    ]);
    // Chat is no longer a group of its own: asking AdminBot something is the second half of the
    // guidebook surface, which the sidebar footer renders.
    expect(TAB_GROUPS.flatMap((group) => group.tabs as readonly string[])).not.toContain("chat");
    // The roster is part of the lab's shared surface, not a tool you operate.
    expect(byLabel("labSharing")).toEqual(["labSharing", "adminbotMeetings", "adminbotMembers"]);
    expect(byLabel("admin")).toEqual([
      "adminbot",
      "adminbotPapers",
      "adminbotWorkshopNudges",
      "adminbotRegistrations",
      "adminbotOnboarding",
      "adminbotProfileOverview",
      "adminbotCalendar",
      "adminbotAnnouncements",
      // Tasks & Tools: the jobs listed there are the lab's own scheduled passes, so it is
      // governance rather than an upstream operator surface.
      "cron",
      "adminbotSettings",
    ]);
  });

  it("keeps the OpenClaw group active for nested settings routes", () => {
    const openclaw = TAB_GROUPS.find((group) => group.label === "openclaw");
    if (!openclaw) {
      throw new Error("Expected openclaw group");
    }

    expect(isTabInGroup(openclaw, "appearance")).toBe(true);
    expect(isTabInGroup(openclaw, "channels")).toBe(true);
    expect(isTabInGroup(openclaw, "debug")).toBe(true);
    expect(isTabInGroup(openclaw, "chat")).toBe(false);

    const admin = TAB_GROUPS.find((group) => group.label === "admin");
    if (!admin) {
      throw new Error("Expected admin group");
    }
    // Registration review is lab governance, so it belongs to the Admin group, not to OpenClaw's
    // settings page.
    expect(isTabInGroup(admin, "adminbotRegistrations")).toBe(true);
    expect(isTabInGroup(openclaw, "adminbotRegistrations")).toBe(false);
  });

  it("routes every published settings slice", () => {
    expect(tabFromPath("/communications")).toBe("communications");
    expect(tabFromPath("/appearance")).toBe("appearance");
    expect(tabFromPath("/automation")).toBe("automation");
    expect(tabFromPath("/infrastructure")).toBe("infrastructure");
    expect(tabFromPath("/ai-agents")).toBe("aiAgents");
    expect(tabFromPath("/config")).toBe("config");
    expect(tabFromPath("/channels")).toBe("channels");
  });
});

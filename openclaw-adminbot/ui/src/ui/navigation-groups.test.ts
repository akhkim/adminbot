// Control UI tests cover navigation groups behavior.
import { describe, expect, it } from "vitest";
import {
  SETTINGS_TABS,
  TAB_GROUPS,
  TAB_PAGES,
  isSettingsTab,
  isTabInGroup,
  pageTabsFor,
  sidebarTabFor,
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
      "myInfo",
      "labSharing",
      "requestsToZhijing",
      "generalTools",
      "admin",
      "openclaw",
    ]);
  });

  it("groups the member surfaces by what a person came to do", () => {
    const byLabel = (label: string) => TAB_GROUPS.find((group) => group.label === label)?.tabs;

    expect(byLabel("home")).toEqual(["dashboard"]);
    // Your own schedule is a thing you edit about yourself, and Active Papers is the lab-wide
    // pipeline (under Admin), so "My Info" is the record, the schedule kept on it and your work.
    // The checklist has no tab of its own: it is a disclosure on My Profile, because a page nobody
    // visits twice is a page nobody visits once.
    expect(byLabel("myInfo")).toEqual(["profile", "adminbotTimeAvailability", "myWork"]);
    // One tab per request template, named for what it asks and who it asks.
    expect(byLabel("requestsToZhijing")).toEqual([
      "adminbotSignatures",
      "adminbotRecLetters",
      "adminbotMeetingRequests",
    ]);
    // Ordered by how often a member reaches for them, not alphabetically.
    expect(byLabel("generalTools")).toEqual([
      "adminbotReimbursements",
      "adminbotDeadlines",
      // Opportunities sits with the member-facing tools, not under Admin: the brainstorming deck
      // asks that members hear about Rising Star and fellowship deadlines, not that admins audit
      // a list of them.
      "adminbotOpportunities",
      "adminbotConferencePapers",
    ]);
    // Chat is no longer a group of its own: asking AdminBot something is the second half of the
    // guidebook surface, which the sidebar footer renders.
    expect(TAB_GROUPS.flatMap((group) => group.tabs as readonly string[])).not.toContain("chat");
    // The roster is part of the lab's shared surface, not a tool you operate.
    expect(byLabel("labSharing")).toEqual(["labSharing", "adminbotMeetings", "adminbotMembers"]);
    // Eight entries, not eleven: Lab Overview, Nudges and Membership are each one page with a tab
    // bar inside it (TAB_PAGES), and only the landing tab is listed here.
    expect(byLabel("admin")).toEqual([
      // First in the group: it is the page that says which of the others to open.
      "adminbotProfessor",
      "adminbotPapers",
      "adminbotAnnouncements",
      "adminbotRegistrations",
      "adminbotCalendar",
      // Grant Report sits after the surfaces it reads from: it is compiled out of the lab's paper
      // record, so it is a thing you write at the end of a cycle, not one you operate during it.
      "adminbotGrantReport",
      // Tasks & Tools: the jobs listed there are the lab's own scheduled passes, so it is
      // governance rather than an upstream operator surface.
      "cron",
      // Pending Actions sits below it: an approval queue is somewhere you go when something is
      // waiting, not where a sweep begins.
      "adminbot",
      "adminbotSettings",
    ]);
  });

  it("keeps every page sub-tab out of the sidebar but reachable through its page", () => {
    const sidebarTabs = TAB_GROUPS.flatMap((group) => group.tabs as readonly string[]);
    for (const page of TAB_PAGES) {
      const [landing, ...rest] = page.tabs;
      expect(sidebarTabs).toContain(landing);
      for (const tab of rest) {
        // Not a sidebar entry of its own, but still routed and still reachable from the bar.
        expect(sidebarTabs).not.toContain(tab);
        expect(sidebarTabFor(tab)).toBe(landing);
        expect(pageTabsFor(tab)).toEqual(page.tabs);
      }
    }
  });

  it("lights the page's sidebar entry when a sub-tab is open", () => {
    const admin = TAB_GROUPS.find((group) => group.label === "admin");
    if (!admin) {
      throw new Error("Expected admin group");
    }
    expect(isTabInGroup(admin, "adminbotWorkshopNudges")).toBe(true);
    expect(isTabInGroup(admin, "adminbotOnboarding")).toBe(true);
    expect(isTabInGroup(admin, "adminbotProfileOverview")).toBe(true);
    expect(sidebarTabFor("adminbotProfileOverview")).toBe("adminbotPapers");
  });

  it("keeps every sub-tab path routable so existing links still land", () => {
    expect(tabFromPath("/adminbot/workshop-nudges")).toBe("adminbotWorkshopNudges");
    expect(tabFromPath("/adminbot/onboarding")).toBe("adminbotOnboarding");
    expect(tabFromPath("/adminbot/profile-overview")).toBe("adminbotProfileOverview");
    expect(tabFromPath("/adminbot/announcements")).toBe("adminbotAnnouncements");
    expect(tabFromPath("/adminbot/registrations")).toBe("adminbotRegistrations");
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

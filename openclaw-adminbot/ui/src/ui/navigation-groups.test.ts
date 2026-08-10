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
  it("collapses detailed settings slices into one sidebar entry", () => {
    const settings = TAB_GROUPS.find((group) => group.label === "settings");
    expect(settings?.tabs).toEqual(["config"]);
    expect(SETTINGS_TABS.every((tab) => isSettingsTab(tab))).toBe(true);
  });

  it("keeps channel management out of the primary control sidebar", () => {
    const control = TAB_GROUPS.find((group) => group.label === "control");
    expect(control?.tabs).toEqual([
      "overview",
      "activity",
      "workboard",
      "instances",
      "sessions",
      "usage",
      "cron",
    ]);
    expect(SETTINGS_TABS).toContain("channels");
  });

  it("splits the AdminBot sidebar into member, admin, and guest sections, in that order", () => {
    const labels = TAB_GROUPS.map((group) => group.label);
    const memberIndex = labels.indexOf("adminbotMember");
    const adminIndex = labels.indexOf("adminbotAdmin");
    const guestIndex = labels.indexOf("adminbotGuest");
    expect(memberIndex).toBeGreaterThanOrEqual(0);
    expect(adminIndex).toBeGreaterThan(memberIndex);
    expect(guestIndex).toBeGreaterThan(adminIndex);

    const member = TAB_GROUPS.find((group) => group.label === "adminbotMember");
    expect(member?.tabs).toEqual(["adminbotMembers", "adminbotTimeAvailability", "adminbotPapers"]);

    const admin = TAB_GROUPS.find((group) => group.label === "adminbotAdmin");
    expect(admin?.tabs).toEqual([
      "adminbot",
      "adminbotRegistrations",
      "adminbotOnboarding",
      "adminbotSettings",
      "adminbotAnnouncements",
    ]);

    const guest = TAB_GROUPS.find((group) => group.label === "adminbotGuest");
    expect(guest?.tabs).toEqual(["adminbotReimbursements", "adminbotDeadlines"]);
  });

  it("keeps the settings group active for nested settings routes", () => {
    const settings = TAB_GROUPS.find((group) => group.label === "settings");
    if (!settings) {
      throw new Error("Expected settings group");
    }

    expect(isTabInGroup(settings, "appearance")).toBe(true);
    expect(isTabInGroup(settings, "channels")).toBe(true);
    expect(isTabInGroup(settings, "debug")).toBe(true);
    expect(isTabInGroup(settings, "chat")).toBe(false);

    const admin = TAB_GROUPS.find((group) => group.label === "adminbotAdmin");
    if (!admin) {
      throw new Error("Expected adminbotAdmin group");
    }
    // Registration review is governance, so it belongs to the AdminBot admin group, not settings.
    expect(isTabInGroup(admin, "adminbotRegistrations")).toBe(true);
    expect(isTabInGroup(settings, "adminbotRegistrations")).toBe(false);
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

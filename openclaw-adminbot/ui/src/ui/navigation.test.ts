// Control UI tests cover navigation behavior.
import { describe, expect, it } from "vitest";
import {
  TAB_GROUPS,
  SETTINGS_TABS,
  iconForTab,
  inferBasePathFromPathname,
  isSettingsTab,
  normalizeBasePath,
  normalizePath,
  pathForTab,
  subtitleForTab,
  tabFromPath,
  titleForTab,
  type Tab,
} from "./navigation.ts";

/** All valid tab identifiers derived from visible groups plus routed settings slices. */
const ALL_TABS: Tab[] = Array.from(
  new Set<Tab>([...(TAB_GROUPS.flatMap((group) => group.tabs) as Tab[]), ...SETTINGS_TABS]),
);

const leadingSlashNormalizerCases = [
  {
    name: "normalizeBasePath",
    normalize: normalizeBasePath,
    input: "ui",
    expected: "/ui",
  },
  {
    name: "normalizePath",
    normalize: normalizePath,
    input: "chat",
    expected: "/chat",
  },
];

describe("iconForTab", () => {
  it("returns stable icons for every tab", () => {
    expect(Object.fromEntries(ALL_TABS.map((tab) => [tab, iconForTab(tab)]))).toEqual({
      dashboard: "barChart",
      profile: "user",
      myWork: "book",
      labSharing: "link",
      chat: "messageSquare",
      overview: "barChart",
      adminbot: "brain",
      adminbotRegistrations: "check",
      adminbotOnboarding: "send",
      adminbotReimbursements: "fileText",
      adminbotSettings: "settings",
      adminbotMembers: "folder",
      adminbotTimeAvailability: "clock",
      adminbotLogistics: "paperclip",
      adminbotPapers: "fileText",
      adminbotAnnouncements: "activity",
      adminbotDeadlines: "loader",
      activity: "activity",
      workboard: "folder",
      channels: "link",
      instances: "radio",
      sessions: "fileText",
      usage: "barChart",
      cron: "loader",
      agents: "folder",
      skills: "zap",
      nodes: "monitor",
      dreams: "moon",
      config: "settings",
      communications: "send",
      appearance: "spark",
      automation: "terminal",
      mcp: "wrench",
      infrastructure: "globe",
      aiAgents: "brain",
      debug: "bug",
      logs: "scrollText",
    });
  });

  it("returns a fallback icon for unknown tab", () => {
    // TypeScript won't allow this normally, but runtime could receive unexpected values
    const unknownTab = "unknown" as Tab;
    expect(iconForTab(unknownTab)).toBe("folder");
  });
});

describe("titleForTab", () => {
  it("returns expected titles for every tab", () => {
    expect(Object.fromEntries(ALL_TABS.map((tab) => [tab, titleForTab(tab)]))).toEqual({
      dashboard: "Dashboard",
      profile: "My Profile",
      myWork: "My Projects & Papers",
      labSharing: "Lab Sharing",
      chat: "Chat",
      overview: "Overview",
      adminbot: "Pending Actions",
      adminbotRegistrations: "Member Requests",
      adminbotOnboarding: "Onboarding",
      adminbotSettings: "Settings",
      adminbotMembers: "Lab Members",
      adminbotTimeAvailability: "Time Availability",
      adminbotLogistics: "Logistics Requests",
      adminbotReimbursements: "Reimbursements",
      adminbotPapers: "Active Papers",
      adminbotAnnouncements: "Announcements",
      adminbotDeadlines: "Deadlines",
      activity: "Activity",
      workboard: "Workboard",
      channels: "Channels",
      instances: "Instances",
      sessions: "Sessions",
      usage: "Usage",
      cron: "Tasks & Tools",
      agents: "Agents",
      skills: "Skills",
      nodes: "Nodes",
      dreams: "Dreaming",
      config: "Settings",
      communications: "Communications",
      appearance: "Appearance",
      automation: "Automation",
      mcp: "MCP",
      infrastructure: "Infrastructure",
      aiAgents: "AI & Agents",
      debug: "Debug",
      logs: "Logs",
    });
  });
});

describe("subtitleForTab", () => {
  it("returns expected subtitles for every tab", () => {
    expect(Object.fromEntries(ALL_TABS.map((tab) => [tab, subtitleForTab(tab)]))).toEqual({
      dashboard: "What needs you, and where the lab stands.",
      profile: "Your details, and anything still blank.",
      myWork: "What you are working on, and anything holding it up.",
      labSharing: "Shared lab resources. Not built yet.",
      chat: "Gateway chat for quick interventions.",
      overview: "Status, entry points, health.",
      adminbot: "Approval queue and execution controls.",
      adminbotRegistrations: "Approve or reject pending member signups and roster claims.",
      adminbotOnboarding: "Send a member or collaborator their onboarding guide.",
      adminbotSettings: "Lab defaults and escalation policy.",
      adminbotMembers: "Privilege levels and access profiles.",
      adminbotTimeAvailability: "Who is committed to what, and when.",
      adminbotLogistics: "Start a routine request and let AdminBot carry it.",
      adminbotReimbursements: "Upload receipts, answer questions, and generate expense forms.",
      adminbotPapers: "PaperPublish records and current steps.",
      adminbotAnnouncements: "Nudge members or send a general announcement.",
      adminbotDeadlines: "Upcoming conference & workshop deadlines.",
      activity: "Browser-local tool activity summaries.",
      workboard: "Agent work queue and session handoff.",
      channels: "Channels and settings.",
      instances: "Connected clients and nodes.",
      sessions: "Active sessions and defaults.",
      usage: "API usage and costs.",
      cron: "Recurring runs, and tools you run on command.",
      agents: "Workspaces, tools, identities.",
      skills: "Skills and API keys.",
      nodes: "Paired devices and commands.",
      dreams: "Memory dreaming, consolidation, and reflection.",
      config: "Edit openclaw.json.",
      communications: "Channels, messages, and audio settings.",
      appearance: "Theme, UI, and setup wizard settings.",
      automation: "Commands, hooks, cron, and plugins.",
      mcp: "MCP servers, auth, tools, and diagnostics.",
      infrastructure: "Gateway, web, browser, and media settings.",
      aiAgents: "Agents, models, skills, tools, memory, session.",
      debug: "Snapshots, events, RPC.",
      logs: "Live gateway logs.",
    });
  });
});

describe("leading slash path normalizers", () => {
  it.each(leadingSlashNormalizerCases)(
    "$name adds leading slash if missing",
    ({ expected, input, normalize }) => {
      expect(normalize(input)).toBe(expected);
    },
  );
});

describe("normalizeBasePath", () => {
  it("returns empty string for falsy input", () => {
    expect(normalizeBasePath("")).toBe("");
  });

  it("removes trailing slash", () => {
    expect(normalizeBasePath("/ui/")).toBe("/ui");
  });

  it("returns empty string for root path", () => {
    expect(normalizeBasePath("/")).toBe("");
  });

  it("handles nested paths", () => {
    expect(normalizeBasePath("/apps/openclaw")).toBe("/apps/openclaw");
  });
});

describe("normalizePath", () => {
  it("returns / for falsy input", () => {
    expect(normalizePath("")).toBe("/");
  });

  it("removes trailing slash except for root", () => {
    expect(normalizePath("/chat/")).toBe("/chat");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("pathForTab", () => {
  it("returns correct path without base", () => {
    expect(pathForTab("chat")).toBe("/chat");
    expect(pathForTab("overview")).toBe("/overview");
  });

  it("prepends base path", () => {
    expect(pathForTab("chat", "/ui")).toBe("/ui/chat");
    expect(pathForTab("sessions", "/apps/openclaw")).toBe("/apps/openclaw/sessions");
  });
});

describe("tabFromPath", () => {
  it("returns tab for valid path", () => {
    expect(tabFromPath("/chat")).toBe("chat");
    expect(tabFromPath("/overview")).toBe("overview");
    expect(tabFromPath("/adminbot")).toBe("adminbot");
    expect(tabFromPath("/adminbot/registrations")).toBe("adminbotRegistrations");
    expect(tabFromPath("/adminbot/settings")).toBe("adminbotSettings");
    expect(tabFromPath("/adminbot/members")).toBe("adminbotMembers");
    expect(tabFromPath("/adminbot/papers")).toBe("adminbotPapers");
    expect(tabFromPath("/adminbot/announcements")).toBe("adminbotAnnouncements");
    expect(tabFromPath("/adminbot/deadlines")).toBe("adminbotDeadlines");
    expect(tabFromPath("/activity")).toBe("activity");
    expect(tabFromPath("/sessions")).toBe("sessions");
    expect(tabFromPath("/dreaming")).toBe("dreams");
    expect(tabFromPath("/dreams")).toBe("dreams");
  });

  // Root is the dashboard for a signed-in viewer; app-render still coerces a visitor's root to
  // the landing page.
  it("returns the dashboard for root path", () => {
    expect(tabFromPath("/")).toBe("dashboard");
  });

  it("routes the Lab Sharing placeholder", () => {
    expect(tabFromPath("/lab-sharing")).toBe("labSharing");
  });

  it("handles base paths", () => {
    expect(tabFromPath("/ui/chat", "/ui")).toBe("chat");
    expect(tabFromPath("/apps/openclaw/sessions", "/apps/openclaw")).toBe("sessions");
  });

  it("returns null for unknown path", () => {
    expect(tabFromPath("/unknown")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(tabFromPath("/CHAT")).toBe("chat");
    expect(tabFromPath("/Overview")).toBe("overview");
  });
});

describe("inferBasePathFromPathname", () => {
  it("returns empty string for root", () => {
    expect(inferBasePathFromPathname("/")).toBe("");
  });

  it("returns empty string for direct tab path", () => {
    expect(inferBasePathFromPathname("/chat")).toBe("");
    expect(inferBasePathFromPathname("/overview")).toBe("");
    expect(inferBasePathFromPathname("/dreaming")).toBe("");
    expect(inferBasePathFromPathname("/dreams")).toBe("");
  });

  it("infers base path from nested paths", () => {
    expect(inferBasePathFromPathname("/ui/chat")).toBe("/ui");
    expect(inferBasePathFromPathname("/apps/openclaw/sessions")).toBe("/apps/openclaw");
  });

  it("handles index.html suffix", () => {
    expect(inferBasePathFromPathname("/index.html")).toBe("");
    expect(inferBasePathFromPathname("/ui/index.html")).toBe("/ui");
  });
});

describe("TAB_GROUPS", () => {
  it("contains all expected groups, member surfaces first and privileged ones last", () => {
    expect(TAB_GROUPS.map((g) => g.label)).toEqual([
      "home",
      "myProfile",
      "myProjects",
      "generalTools",
      "labSharing",
      "admin",
      "openclaw",
    ]);
  });

  it("all tabs are unique", () => {
    const allTabs = TAB_GROUPS.flatMap((g) => g.tabs);
    const uniqueTabs = new Set(allTabs);
    expect(uniqueTabs.size).toBe(allTabs.length);
  });

  it("keeps detailed settings slices routed but out of the root sidebar", () => {
    const openclaw = TAB_GROUPS.find((group) => group.label === "openclaw");
    // `config` is the only settings tab in the sidebar; the rest are slices of that page.
    expect(openclaw?.tabs).toContain("config");
    expect(openclaw?.tabs).not.toContain("channels");
    expect(SETTINGS_TABS).toEqual([
      "config",
      "channels",
      "communications",
      "appearance",
      "automation",
      "mcp",
      "infrastructure",
      "aiAgents",
      "debug",
      "logs",
    ]);
    expect(SETTINGS_TABS.every((tab) => isSettingsTab(tab))).toBe(true);
  });
});

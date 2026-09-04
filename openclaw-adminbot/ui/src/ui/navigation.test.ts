// Control UI tests cover navigation behavior.
import { describe, expect, it } from "vitest";
import {
  TAB_GROUPS,
  TAB_PAGES,
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

// Chat is routed but in no sidebar group: it renders in the pinned sidebar footer, in the slot
// the external docs link used to occupy.
const UNGROUPED_TABS: Tab[] = ["chat"];

/**
 * All valid tab identifiers derived from visible groups plus routed settings slices.
 *
 * Sub-tabs of a multi-tab page are included explicitly: the sidebar lists only their page's landing
 * tab, but each is still a routed surface with an icon, a title and a subtitle of its own.
 */
const ALL_TABS: Tab[] = Array.from(
  new Set<Tab>([
    ...(TAB_GROUPS.flatMap((group) => group.tabs) as Tab[]),
    ...(TAB_PAGES.flatMap((page) => page.tabs) as Tab[]),
    ...UNGROUPED_TABS,
    ...SETTINGS_TABS,
  ]),
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
      adminbotOpportunities: "zap",
      chat: "messageSquare",
      overview: "barChart",
      adminbot: "brain",
      adminbotRegistrations: "user",
      adminbotBadges: "spark",
      adminbotOnboarding: "send",
      adminbotReimbursements: "fileText",
      adminbotSettings: "settings",
      adminbotMembers: "folder",
      adminbotProfileOverview: "check",
      adminbotGrantReport: "scrollText",
      adminbotMailingList: "send",
      adminbotRecentEdits: "history",
      adminbotProfessor: "lobster",
      adminbotMeetings: "play",
      adminbotTimeAvailability: "clock",
      adminbotSignatures: "penLine",
      adminbotRecLetters: "fileText",
      adminbotMeetingRequests: "clock",
      adminbotPapers: "barChart",
      adminbotWorkshopNudges: "send",
      adminbotConferencePapers: "fileText",
      adminbotAnnouncements: "send",
      adminbotCalendar: "clock",
      adminbotDeadlines: "loader",
      activity: "activity",
      channels: "link",
      sessions: "fileText",
      usage: "barChart",
      cron: "loader",
      agents: "folder",
      skills: "zap",
      nodes: "monitor",
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
      labSharing: "Collaborate",
      adminbotOpportunities: "Opportunities",
      chat: "Chat",
      overview: "Overview",
      adminbot: "Pending Actions",
      adminbotRegistrations: "Requests",
      adminbotBadges: "Badges",
      adminbotOnboarding: "Onboarding",
      adminbotSettings: "Settings",
      adminbotMembers: "Lab Members",
      adminbotProfileOverview: "Profile Completeness",
      adminbotGrantReport: "Grant Report",
      adminbotMailingList: "Mailing List",
      adminbotRecentEdits: "Recent Edits",
      adminbotProfessor: "My Desk",
      adminbotMeetings: "Meeting Recordings",
      adminbotTimeAvailability: "Time Availability",
      adminbotSignatures: "Signatures for You",
      adminbotRecLetters: "Rec Letter Request",
      adminbotMeetingRequests: "Meeting Request",
      adminbotReimbursements: "Reimbursement Form Prep",
      adminbotPapers: "Active Papers",
      adminbotWorkshopNudges: "Workshop Matches",
      adminbotConferencePapers: "Find Interesting Papers",
      adminbotAnnouncements: "Announcements",
      adminbotCalendar: "Calendar",
      adminbotDeadlines: "Deadlines",
      activity: "Activity",
      channels: "Channels",
      sessions: "Sessions",
      usage: "Usage",
      cron: "Tasks & Tools",
      agents: "Agents",
      skills: "Skills",
      nodes: "Nodes",
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
      // Corrected to the shipped string: the tab has said "Coming soon" for a while and this
      // expectation had not followed, leaving the suite red for a reason unrelated to it.
      labSharing: "Coming soon — share resources, ideas, and collaborate.",
      adminbotOpportunities: "PhD programs, internships, grants, awards, and Rising Stars.",
      chat: "Gateway chat for quick interventions.",
      overview: "Status, entry points, health.",
      adminbot: "Approval queue and execution controls.",
      adminbotRegistrations: "Approve or reject pending member signups and roster claims.",
      adminbotBadges: "Manage badge definitions, assignments, and self-nominations.",
      adminbotOnboarding: "Send a member or collaborator their onboarding guide.",
      adminbotSettings: "Lab defaults and escalation policy.",
      adminbotMembers: "Privilege levels and access profiles.",
      adminbotProfileOverview: "Who has filled in their profile and planned their term.",
      adminbotGrantReport:
        "Every paper mapped to a safety area, and the track record behind each ask.",
      adminbotMailingList: "Mail our publications for a date range to one address.",
      adminbotRecentEdits: "Who changed what, newest first.",
      adminbotProfessor: "What is waiting on you, across every queue.",
      adminbotMeetings: "Recordings, attendance and summaries of lab meetings.",
      adminbotTimeAvailability: "Who is committed to what, and when.",
      adminbotSignatures: "Send a document over for signing, and follow where it got to.",
      adminbotRecLetters:
        "Ask for a recommendation letter, school by school and deadline by deadline.",
      adminbotMeetingRequests: "Ask for a slot, and say what the call is for.",
      adminbotReimbursements: "Upload receipts, answer questions, and generate expense forms.",
      adminbotPapers: "PaperPublish records and current steps.",
      adminbotWorkshopNudges: "Review paper–workshop matches and send workshop nudges.",
      adminbotConferencePapers:
        "Search a conference's accepted papers, ranked against what you work on.",
      adminbotAnnouncements: "Nudge members or send a general announcement.",
      adminbotCalendar: "Draft an event, and invite the people the roster can describe.",
      adminbotDeadlines: "Past and upcoming conference & workshop deadlines.",
      activity: "Browser-local tool activity summaries.",
      channels: "Channels and settings.",
      sessions: "Active sessions and defaults.",
      usage: "API usage and costs.",
      cron: "Recurring runs, and tools you run on command.",
      agents: "Workspaces, tools, identities.",
      skills: "Skills and API keys.",
      nodes: "Paired devices and commands.",
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
    expect(tabFromPath("/pending-actions")).toBe("adminbot");
    expect(tabFromPath("/registrations")).toBe("adminbotRegistrations");
    expect(tabFromPath("/badges")).toBe("adminbotBadges");
    expect(tabFromPath("/settings")).toBe("adminbotSettings");
    expect(tabFromPath("/members")).toBe("adminbotMembers");
    expect(tabFromPath("/papers")).toBe("adminbotPapers");
    expect(tabFromPath("/announcements")).toBe("adminbotAnnouncements");
    expect(tabFromPath("/deadlines")).toBe("adminbotDeadlines");
    expect(tabFromPath("/workshop-nudges")).toBe("adminbotWorkshopNudges");
    expect(tabFromPath("/activity")).toBe("activity");
    expect(tabFromPath("/sessions")).toBe("sessions");
  });

  // Every URL these pages used to have is in somebody's bookmarks, in Slack threads and in mail
  // that has already been sent. Dropping the prefix must not 404 any of them, so the whole set is
  // asserted rather than a sample: a path added to TAB_PATHS without its alias fails here.
  it("still resolves every pre-rename /adminbot path", () => {
    const renamed: Record<string, string> = {
      "/adminbot": "adminbot",
      "/adminbot/registrations": "adminbotRegistrations",
      "/adminbot/badges": "adminbotBadges",
      "/adminbot/onboarding": "adminbotOnboarding",
      "/adminbot/reimbursements": "adminbotReimbursements",
      "/adminbot/settings": "adminbotSettings",
      "/adminbot/members": "adminbotMembers",
      "/adminbot/opportunities": "adminbotOpportunities",
      "/adminbot/profile-overview": "adminbotProfileOverview",
      "/adminbot/professor": "adminbotProfessor",
      "/adminbot/time-availability": "adminbotTimeAvailability",
      "/adminbot/meetings": "adminbotMeetings",
      "/adminbot/signatures": "adminbotSignatures",
      "/adminbot/rec-letters": "adminbotRecLetters",
      "/adminbot/meeting-requests": "adminbotMeetingRequests",
      "/adminbot/papers": "adminbotPapers",
      "/adminbot/workshop-nudges": "adminbotWorkshopNudges",
      "/adminbot/announcements": "adminbotAnnouncements",
      "/adminbot/conference-papers": "adminbotConferencePapers",
      "/adminbot/calendar": "adminbotCalendar",
      "/adminbot/deadlines": "adminbotDeadlines",
      // The tab that became three, aliased long before the prefix was dropped.
      "/adminbot/logistics": "adminbotSignatures",
    };
    for (const [path, tab] of Object.entries(renamed)) {
      expect(tabFromPath(path), path).toBe(tab);
    }
  });

  // The canonical path is the short one: an old link resolves, but nothing generates it.
  it("generates only unprefixed paths", () => {
    for (const tab of ALL_TABS) {
      expect(pathForTab(tab).startsWith("/adminbot"), tab).toBe(false);
    }
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
      "myInfo",
      "labSharing",
      "requestsToZhijing",
      "generalTools",
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

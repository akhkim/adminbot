// Control UI module implements navigation behavior.
import { t } from "../i18n/index.ts";
import type { IconName } from "./icons.js";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

// The sidebar is organised by what a person came here to do, not by which system owns the screen.
// Five member groups answer "where do I stand / my record / my work / the shared tools / the lab",
// and the two privileged groups sit below them: `admin` for lab governance, `openclaw` for the
// operator surfaces inherited from upstream. A group whose every tab is out of reach renders no
// section at all (app-render.ts), so a plain member never sees an "Admin" heading and a visitor
// sees only the two open tools inside "General Tools".
export const TAB_GROUPS = [
  { label: "home", tabs: ["dashboard"] },
  // "My Info" is everything the viewer holds about themselves: the record, the schedule they keep
  // on it, and the work it is attached to. Time Availability sits here rather than in the shared
  // tools because it is the viewer's own schedule that they edit, and only incidentally other
  // people's that they read.
  { label: "myInfo", tabs: ["profile", "adminbotTimeAvailability", "myWork"] },
  // Lab Members sits with Lab Sharing, not in the shared tools: the roster is who the lab is,
  // which is what someone browsing the lab's shared surface came to look at.
  { label: "labSharing", tabs: ["labSharing", "adminbotMeetings", "adminbotMembers"] },
  // The three logistics templates, each with its own heading. They used to be one "Logistics
  // Requests" tab whose first screen was a picker between them, which meant every request started
  // with a step that carried no information -- the member already knew which of the three they
  // came for. Naming them in the sidebar makes that choice the click that opens the form, and it
  // names the person the request actually goes to.
  {
    label: "requestsToZhijing",
    tabs: ["adminbotSignatures", "adminbotRecLetters", "adminbotMeetingRequests"],
  },
  // Ordered by how often a member reaches for them. Chat is not here any more: asking AdminBot
  // something is now the second half of the guidebook surface (`adminbotGuidebook`), which the
  // sidebar footer offers in place of the old external docs link.
  {
    label: "generalTools",
    tabs: [
      "adminbotReimbursements",
      "adminbotDeadlines",
      "adminbotOpportunities",
      "adminbotConferencePapers",
    ],
  },
  // Only the landing tab of each multi-tab page is listed (see TAB_PAGES): the sidebar names the
  // job -- Nudges, Membership -- and the page names the surfaces inside it. Ten entries here read
  // as ten unrelated tools; seven read as what an administrator actually does.
  {
    label: "admin",
    tabs: [
      // First in the group, because it is the page that says which of the others to open.
      "adminbotProfessor",
      "adminbotPapers",
      "adminbotAnnouncements",
      "adminbotRegistrations",
      "adminbotCalendar",
      // Tasks & Tools (the `cron` tab) sits with lab governance rather than under OpenClaw: what
      // it actually lists here is the lab's own scheduled passes -- the OpenReview cadence, the
      // daily Slack timezone sync, the CV digest -- plus the on-demand jobs an admin presses. An
      // admin looking for "when does the nudge go out" was looking under Admin and finding an
      // operator heading instead.
      "cron",
      // Pending Actions sits below Tasks & Tools, next to the settings it is really a sibling of:
      // it is the approval queue, which is something you visit when something is waiting, not a
      // place a sweep starts. Near the top it read as the first stop in the group.
      "adminbot",
      "adminbotSettings",
    ],
  },
  // Upstream OpenClaw's own operator surfaces. Every one of these is already admin-only in
  // access.ts, so collapsing the former control/agent/settings groups into one heading changes
  // where they sit, never who can reach them.
  //
  // Workboard, Instances and Dreams are deliberately absent: this deployment runs one gateway on
  // one host for one lab, so there is no second instance to switch between and no board of agent
  // work to keep; dreaming is an upstream idle-time feature nobody here uses. Their views still
  // exist and their routes still resolve -- this only takes them out of the sidebar. Nodes stays:
  // it is where paired devices are approved, which this deployment does use.
  {
    label: "openclaw",
    tabs: ["overview", "activity", "sessions", "usage", "agents", "skills", "nodes", "config"],
  },
] as const;

/**
 * Tabs that share one page, shown as a tab bar inside it rather than as sidebar siblings.
 *
 * Each remains a real tab with its own path, so every existing link keeps working and the sub-tab
 * is simply where you are -- no extra view state, and the browser's back button still steps between
 * them. The first entry is where the sidebar lands, and it is the only one the sidebar lists.
 *
 * The two groups are the two jobs that were spread across the widest: everything AdminBot sends to
 * members, and everything about who is in the lab. Announcements and workshop nudges were the same
 * decision -- "which members should hear from us, and about what" -- reached from two sidebar
 * entries; requests, onboarding and profile completeness are three views of one person's arrival.
 */
export const TAB_PAGES = [
  // Where the lab stands, in its two halves. Profile Completeness is not a smaller version of
  // Active Papers: it counts a member's own fields, their timeline entries and how many of their
  // papers carry an update they wrote themselves, while Active Papers is the pipeline across every
  // paper in the lab. Neither answers the other's question, and an administrator taking stock wants
  // both, so they sit on one page rather than two entries that look interchangeable and are not.
  { page: "labOverview", tabs: ["adminbotPapers", "adminbotProfileOverview"] },
  { page: "nudges", tabs: ["adminbotAnnouncements", "adminbotWorkshopNudges"] },
  { page: "membership", tabs: ["adminbotRegistrations", "adminbotOnboarding"] },
] as const satisfies ReadonlyArray<{ page: string; tabs: readonly Tab[] }>;

type TabPage = (typeof TAB_PAGES)[number];

/** The page a tab belongs to, or undefined when it is a page of its own. */
export function pageForTab(tab: Tab): TabPage | undefined {
  return TAB_PAGES.find((page) => (page.tabs as readonly Tab[]).includes(tab));
}

/**
 * The sibling tabs to draw as a tab bar on this tab's page, or an empty list when it stands alone.
 *
 * Unfiltered by role on purpose: the caller holds the viewer's role and filters, because a bar that
 * silently dropped a tab here would also drop it from the type that says the page has siblings.
 */
export function pageTabsFor(tab: Tab): readonly Tab[] {
  return pageForTab(tab)?.tabs ?? [];
}

/** The tab the sidebar lists for this one: the page's landing tab, or the tab itself. */
export function sidebarTabFor(tab: Tab): Tab {
  return pageForTab(tab)?.tabs[0] ?? tab;
}

/**
 * What the sidebar entry and the page heading say.
 *
 * A page's landing tab keeps its own `tabs.*` label for the bar inside the page -- "Announcements"
 * is still what that surface is -- while the sidebar and heading name the page as a whole.
 */
export function pageTitleForTab(tab: Tab) {
  const page = pageForTab(tab);
  return page && page.tabs[0] === tab ? t(`pages.${page.page}`) : titleForTab(tab);
}

// Tabs that hold a place in the sidebar for a tool nobody has built yet. They render greyed out
// and refuse clicks, so the slot is visible without routing anyone at a view that does not exist.
// Delete the entry — not the tab — when the real surface lands.
//
// Empty today: Social Media Bot was the only one, and it is gone rather than built. Drafting the
// post is a step of a paper, so it lives on that paper's card in My Projects & Papers -- a tab of
// its own would have been a second place to start the same job, with no paper in hand.
export const UNIMPLEMENTED_TABS: readonly Tab[] = [];

/**
 * Whether an arbitrary string names a tab.
 *
 * For values that arrive from the service rather than from this file -- a notification says which
 * tab it is about, and the service has no reason to know the UI's tab list. Rather than casting and
 * routing at a view that does not exist, the caller checks first and simply does not offer a link.
 */
export function isKnownTab(value: string | undefined): value is Tab {
  return value !== undefined && value in TAB_PATHS;
}

export function isTabImplemented(tab: Tab): boolean {
  return !UNIMPLEMENTED_TABS.includes(tab);
}

export type Tab =
  | "agents"
  | "dashboard"
  | "profile"
  | "myWork"
  | "labSharing"
  | "activity"
  | "adminbot"
  | "adminbotRegistrations"
  | "adminbotOnboarding"
  | "adminbotReimbursements"
  | "adminbotSettings"
  | "adminbotMembers"
  | "adminbotOpportunities"
  | "adminbotProfileOverview"
  | "adminbotProfessor"
  | "adminbotTimeAvailability"
  | "adminbotMeetings"
  | "adminbotSignatures"
  | "adminbotRecLetters"
  | "adminbotMeetingRequests"
  | "adminbotPapers"
  | "adminbotWorkshopNudges"
  | "adminbotAnnouncements"
  | "adminbotConferencePapers"
  | "adminbotCalendar"
  | "adminbotDeadlines"
  | "overview"
  | "channels"
  | "sessions"
  | "usage"
  | "cron"
  | "skills"
  | "nodes"
  | "chat"
  | "config"
  | "communications"
  | "appearance"
  | "automation"
  | "mcp"
  | "infrastructure"
  | "aiAgents"
  | "debug"
  | "logs";

/**
 * Which request form each of the three "Requests to Zhijing" tabs opens.
 *
 * The template is still one piece of view state on the logistics surface (it decides which form is
 * drawn and which draft is saved); what changed is that the sidebar sets it instead of a picker
 * inside the page. Keeping the mapping here rather than in app-render keeps "these three tabs are
 * the same view" a fact about navigation, which is what it is.
 */
export const LOGISTICS_TAB_TEMPLATES = {
  adminbotSignatures: "documentSignature",
  adminbotRecLetters: "recommendationLetters",
  adminbotMeetingRequests: "bookMeeting",
} as const satisfies Partial<Record<Tab, string>>;

export type LogisticsTab = keyof typeof LOGISTICS_TAB_TEMPLATES;

/** The inverse: which tab holds a given form, for anything that has a template and needs a route. */
export const LOGISTICS_TAB_FOR_TEMPLATE = Object.fromEntries(
  Object.entries(LOGISTICS_TAB_TEMPLATES).map(([tab, template]) => [template, tab as LogisticsTab]),
) as Record<(typeof LOGISTICS_TAB_TEMPLATES)[LogisticsTab], LogisticsTab>;

export function isLogisticsTab(tab: Tab): tab is LogisticsTab {
  return tab in LOGISTICS_TAB_TEMPLATES;
}

export const SETTINGS_TABS = [
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
] as const satisfies readonly Tab[];

const TAB_PATHS: Record<Tab, string> = {
  agents: "/agents",
  dashboard: "/dashboard",
  profile: "/profile",
  myWork: "/my-work",
  labSharing: "/lab-sharing",
  activity: "/activity",
  adminbot: "/pending-actions",
  adminbotRegistrations: "/registrations",
  adminbotOnboarding: "/onboarding",
  adminbotReimbursements: "/reimbursements",
  adminbotSettings: "/settings",
  adminbotMembers: "/members",
  adminbotOpportunities: "/opportunities",
  adminbotProfileOverview: "/profile-overview",
  adminbotProfessor: "/professor",
  adminbotTimeAvailability: "/time-availability",
  adminbotMeetings: "/meetings",
  adminbotSignatures: "/signatures",
  adminbotRecLetters: "/rec-letters",
  adminbotMeetingRequests: "/meeting-requests",
  adminbotPapers: "/papers",
  adminbotWorkshopNudges: "/workshop-nudges",
  adminbotAnnouncements: "/announcements",
  adminbotConferencePapers: "/conference-papers",
  adminbotCalendar: "/calendar",
  adminbotDeadlines: "/deadlines",
  overview: "/overview",
  channels: "/channels",
  sessions: "/sessions",
  usage: "/usage",
  cron: "/cron",
  skills: "/skills",
  nodes: "/nodes",
  chat: "/chat",
  config: "/config",
  communications: "/communications",
  appearance: "/appearance",
  automation: "/automation",
  mcp: "/mcp",
  infrastructure: "/infrastructure",
  aiAgents: "/ai-agents",
  debug: "/debug",
  logs: "/logs",
};

// Old paths that must keep resolving.
//
// The first is the one tab that became three. The rest are the `/adminbot/*` prefix these pages
// used to carry: the segment said nothing a member needed — every page under it was AdminBot —
// and it cost a word in every link. Dropping it changes URLs that live in members' bookmarks, in
// Slack threads, in onboarding mail and in already-sent nudges, so every one of them is aliased
// here rather than left to 404. These are permanent, not a migration window.
const PATH_ALIASES: Record<string, Tab> = {
  "/adminbot/logistics": "adminbotSignatures",
  "/adminbot": "adminbot",
  "/adminbot/announcements": "adminbotAnnouncements",
  "/adminbot/calendar": "adminbotCalendar",
  "/adminbot/conference-papers": "adminbotConferencePapers",
  "/adminbot/deadlines": "adminbotDeadlines",
  "/adminbot/meeting-requests": "adminbotMeetingRequests",
  "/adminbot/meetings": "adminbotMeetings",
  "/adminbot/members": "adminbotMembers",
  "/adminbot/onboarding": "adminbotOnboarding",
  "/adminbot/opportunities": "adminbotOpportunities",
  "/adminbot/papers": "adminbotPapers",
  "/adminbot/professor": "adminbotProfessor",
  "/adminbot/profile-overview": "adminbotProfileOverview",
  "/adminbot/rec-letters": "adminbotRecLetters",
  "/adminbot/registrations": "adminbotRegistrations",
  "/adminbot/reimbursements": "adminbotReimbursements",
  "/adminbot/settings": "adminbotSettings",
  "/adminbot/signatures": "adminbotSignatures",
  "/adminbot/time-availability": "adminbotTimeAvailability",
  "/adminbot/workshop-nudges": "adminbotWorkshopNudges",
};

const PATH_TO_TAB = new Map<string, Tab>([
  ...Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as Tab] as const),
  ...Object.entries(PATH_ALIASES),
]);

export function normalizeBasePath(basePath: string): string {
  if (!basePath) {
    return "";
  }
  let base = basePath.trim();
  if (!base.startsWith("/")) {
    base = `/${base}`;
  }
  if (base === "/") {
    return "";
  }
  if (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  return base;
}

export function normalizePath(path: string): string {
  if (!path) {
    return "/";
  }
  let normalized = path.trim();
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function pathForTab(tab: Tab, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  const path = TAB_PATHS[tab];
  return base ? `${base}${path}` : path;
}

export function isSettingsTab(tab: Tab): boolean {
  return (SETTINGS_TABS as readonly Tab[]).includes(tab);
}

export function isTabInGroup(group: (typeof TAB_GROUPS)[number], tab: Tab): boolean {
  // A tab inside a multi-tab page counts as its page's landing tab, so opening Workshop Nudges
  // keeps the Nudges entry lit rather than lighting nothing.
  if ((group.tabs as readonly Tab[]).includes(sidebarTabFor(tab))) {
    return true;
  }
  // Nested settings slices (channels/appearance/...) render inside the settings page, so they keep
  // their sidebar group active even though only its top-level tab (`config`) is listed. That page
  // now hangs off the OpenClaw group, which is where `config` moved.
  return group.label === "openclaw" && isSettingsTab(tab);
}

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
  const base = normalizeBasePath(basePath);
  let path = pathname || "/";
  if (base) {
    if (path === base) {
      path = "/";
    } else if (path.startsWith(`${base}/`)) {
      path = path.slice(base.length);
    }
  }
  let normalized = normalizeLowercaseStringOrEmpty(normalizePath(path));
  if (normalized.endsWith("/index.html")) {
    normalized = "/";
  }
  // The root is home: the dashboard for anyone signed in. Because a visitor may not see it, the
  // coercion in app-render turns the same resolution into the landing page for them.
  if (normalized === "/") {
    return "dashboard";
  }
  return PATH_TO_TAB.get(normalized) ?? null;
}

export function inferBasePathFromPathname(pathname: string): string {
  let normalized = normalizePath(pathname);
  if (normalized.endsWith("/index.html")) {
    normalized = normalizePath(normalized.slice(0, -"/index.html".length));
  }
  if (normalized === "/") {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }
  for (let i = 0; i < segments.length; i++) {
    const candidate = normalizeLowercaseStringOrEmpty(`/${segments.slice(i).join("/")}`);
    if (PATH_TO_TAB.has(candidate)) {
      const prefix = segments.slice(0, i);
      return prefix.length ? `/${prefix.join("/")}` : "";
    }
  }
  return `/${segments.join("/")}`;
}

export function iconForTab(tab: Tab): IconName {
  switch (tab) {
    case "agents":
      return "folder";
    case "dashboard":
      return "barChart";
    case "profile":
      return "user";
    case "myWork":
      return "book";
    case "labSharing":
      return "link";
    case "chat":
      return "messageSquare";
    case "overview":
      return "barChart";
    case "activity":
      return "activity";
    case "adminbot":
      return "brain";
    // The landing tab of the Membership page: who is in the lab, not just who is waiting.
    case "adminbotRegistrations":
      return "user";
    case "adminbotOnboarding":
      return "send";
    case "adminbotReimbursements":
      return "fileText";
    case "adminbotSettings":
      return "settings";
    case "adminbotProfileOverview":
      return "check";
    case "adminbotProfessor":
      return "lobster";
    case "adminbotMembers":
      return "folder";
    case "adminbotTimeAvailability":
      return "clock";
    case "adminbotMeetings":
      return "play";
    case "adminbotSignatures":
      return "penLine";
    case "adminbotRecLetters":
      return "fileText";
    case "adminbotMeetingRequests":
      return "clock";
    // The landing tab of the Lab Overview page, so this is where the lab stands as a whole.
    case "adminbotPapers":
      return "barChart";
    case "adminbotWorkshopNudges":
      return "send";
    // The landing tab of the Nudges page, so this is the whole page's icon: what AdminBot sends.
    case "adminbotAnnouncements":
      return "send";
    case "adminbotConferencePapers":
      return "fileText";
    case "adminbotCalendar":
      return "clock";
    case "adminbotDeadlines":
      return "loader";
    case "adminbotOpportunities":
      return "zap";
    case "channels":
      return "link";
    case "sessions":
      return "fileText";
    case "usage":
      return "barChart";
    case "cron":
      return "loader";
    case "skills":
      return "zap";
    case "nodes":
      return "monitor";
    case "config":
      return "settings";
    case "communications":
      return "send";
    case "appearance":
      return "spark";
    case "automation":
      return "terminal";
    case "mcp":
      return "wrench";
    case "infrastructure":
      return "globe";
    case "aiAgents":
      return "brain";
    case "debug":
      return "bug";
    case "logs":
      return "scrollText";
    default:
      return "folder";
  }
}

export function titleForTab(tab: Tab) {
  if (tab === "config") {
    return t("nav.settings");
  }
  return t(`tabs.${tab}`);
}

export function subtitleForTab(tab: Tab) {
  return t(`subtitles.${tab}`);
}

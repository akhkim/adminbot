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
  { label: "myProfile", tabs: ["profile"] },
  { label: "myProjects", tabs: ["myWork"] },
  {
    label: "generalTools",
    tabs: [
      "chat",
      "adminbotDeadlines",
      "adminbotReimbursements",
      "adminbotMembers",
      "adminbotTimeAvailability",
      "adminbotLogistics",
    ],
  },
  { label: "labSharing", tabs: ["labSharing"] },
  {
    label: "admin",
    tabs: [
      "adminbot",
      "adminbotPapers",
      "adminbotRegistrations",
      "adminbotOnboarding",
      "adminbotAnnouncements",
      "adminbotSettings",
    ],
  },
  // Upstream OpenClaw's own operator surfaces. Every one of these is already admin-only in
  // access.ts, so collapsing the former control/agent/settings groups into one heading changes
  // where they sit, never who can reach them.
  {
    label: "openclaw",
    tabs: [
      "overview",
      "activity",
      "workboard",
      "instances",
      "sessions",
      "usage",
      "cron",
      "agents",
      "skills",
      "nodes",
      "dreams",
      "config",
    ],
  },
] as const;

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
  | "adminbotTimeAvailability"
  | "adminbotLogistics"
  | "adminbotPapers"
  | "adminbotAnnouncements"
  | "adminbotDeadlines"
  | "overview"
  | "workboard"
  | "channels"
  | "instances"
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
  | "logs"
  | "dreams";

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
  adminbot: "/adminbot",
  adminbotRegistrations: "/adminbot/registrations",
  adminbotOnboarding: "/adminbot/onboarding",
  adminbotReimbursements: "/adminbot/reimbursements",
  adminbotSettings: "/adminbot/settings",
  adminbotMembers: "/adminbot/members",
  adminbotTimeAvailability: "/adminbot/time-availability",
  adminbotLogistics: "/adminbot/logistics",
  adminbotPapers: "/adminbot/papers",
  adminbotAnnouncements: "/adminbot/announcements",
  adminbotDeadlines: "/adminbot/deadlines",
  overview: "/overview",
  workboard: "/workboard",
  channels: "/channels",
  instances: "/instances",
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
  dreams: "/dreaming",
};

const PATH_ALIASES: Record<string, Tab> = {
  "/dreams": "dreams",
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
  if ((group.tabs as readonly Tab[]).includes(tab)) {
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
    case "adminbotRegistrations":
      return "check";
    case "adminbotOnboarding":
      return "send";
    case "adminbotReimbursements":
      return "fileText";
    case "adminbotSettings":
      return "settings";
    case "adminbotMembers":
      return "folder";
    case "adminbotTimeAvailability":
      return "clock";
    case "adminbotLogistics":
      return "paperclip";
    case "adminbotPapers":
      return "fileText";
    case "adminbotAnnouncements":
      return "activity";
    case "adminbotDeadlines":
      return "loader";
    case "workboard":
      return "folder";
    case "channels":
      return "link";
    case "instances":
      return "radio";
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
    case "dreams":
      return "moon";
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

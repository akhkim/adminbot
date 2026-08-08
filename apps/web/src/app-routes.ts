export type AppAudience = "public" | "member" | "administrator" | "governance";
export type AppRouteGroup = "public" | "workspace" | "operations";
export type PortStatus = "live" | "backend_pending";
export type PreviewKind = "cards" | "composer" | "queue" | "table" | "timeline";

export type AppRouteId =
  | "overview"
  | "signIn"
  | "access"
  | "reimbursements"
  | "deadlines"
  | "members"
  | "availability"
  | "papers"
  | "registrations"
  | "onboarding"
  | "actions"
  | "announcements"
  | "settings";

type AppRouteDefinition = {
  id: AppRouteId;
  path: string;
  label: string;
  shortLabel: string;
  eyebrow: string;
  description: string;
  audience: AppAudience;
  group: AppRouteGroup | null;
  preview: PreviewKind;
  columns?: readonly string[];
  legacyBehavior: string;
};

export type LiveAppRoute = Readonly<
  AppRouteDefinition & {
    status: "live";
    nextBoundary?: never;
  }
>;

export type PendingAppRoute = Readonly<
  AppRouteDefinition & {
    status: "backend_pending";
    nextBoundary: string;
  }
>;

export type AppRoute = LiveAppRoute | PendingAppRoute;

export const APP_ROUTES: readonly AppRoute[] = [
  {
    id: "overview",
    path: "/",
    label: "Overview",
    shortLabel: "Overview",
    eyebrow: "Lab operations",
    description: "A focused home for the lab workflows being moved out of OpenClaw.",
    audience: "public",
    group: null,
    status: "live",
    preview: "cards",
    legacyBehavior: "Summarized proposals, members, papers, nudges, and freshness.",
  },
  {
    id: "signIn",
    path: "/sign-in",
    label: "Sign in",
    shortLabel: "Sign in",
    eyebrow: "Identity",
    description: "Restore a secure member or administrator session.",
    audience: "public",
    group: "public",
    status: "live",
    preview: "cards",
    legacyBehavior: "Members signed in, restored their session, and signed out from the UI.",
  },
  {
    id: "access",
    path: "/access",
    label: "Request access",
    shortLabel: "Access",
    eyebrow: "Identity",
    description: "Claim a roster profile or apply as a new collaborator.",
    audience: "public",
    group: "public",
    status: "live",
    preview: "cards",
    legacyBehavior: "Claim and signup forms submitted requests for administrator review.",
  },
  {
    id: "reimbursements",
    path: "/adminbot/reimbursements",
    label: "Reimbursements",
    shortLabel: "Reimbursements",
    eyebrow: "Public utility",
    description: "Prepare reimbursement forms from receipts without sending private data remotely.",
    audience: "public",
    group: "public",
    status: "live",
    preview: "composer",
    legacyBehavior: "A local-only assistant extracted receipts and generated canonical forms.",
  },
  {
    id: "deadlines",
    path: "/adminbot/deadlines",
    label: "Conference deadlines",
    shortLabel: "Deadlines",
    eyebrow: "Public directory",
    description: "Browse a curated, timezone-aware board of research deadlines.",
    audience: "public",
    group: "public",
    status: "live",
    preview: "timeline",
    legacyBehavior: "A bundled deadline snapshot offered a filterable public board.",
  },
  {
    id: "members",
    path: "/adminbot/members",
    label: "Lab members",
    shortLabel: "Members",
    eyebrow: "Workspace",
    description: "Find people, responsibilities, projects, and permitted profile details.",
    audience: "member",
    group: "workspace",
    status: "backend_pending",
    preview: "table",
    columns: ["Person", "Status", "Research branch", "Projects", "Availability"],
    legacyBehavior: "Members saw a roster; administrators could edit governance-owned fields.",
    nextBoundary: "Login, sessions, member projections, and field-level authorization are required.",
  },
  {
    id: "availability",
    path: "/adminbot/time-availability",
    label: "Time & availability",
    shortLabel: "Availability",
    eyebrow: "Workspace",
    description: "Review capacity, time off, and project allocation over a selected interval.",
    audience: "member",
    group: "workspace",
    status: "live",
    preview: "timeline",
    legacyBehavior: "A member timeline combined availability ranges, time off, and task allocation.",
  },
  {
    id: "papers",
    path: "/adminbot/papers",
    label: "Publication pipeline",
    shortLabel: "Papers",
    eyebrow: "Workspace",
    description: "Track papers, owners, milestones, parallel work, and publication artifacts.",
    audience: "member",
    group: "workspace",
    status: "live",
    preview: "timeline",
    legacyBehavior: "A filterable Gantt view showed paper progress and workflow branches.",
  },
  {
    id: "registrations",
    path: "/adminbot/registrations",
    label: "Registration review",
    shortLabel: "Registrations",
    eyebrow: "Administration",
    description: "Review pending roster claims and new-collaborator applications.",
    audience: "administrator",
    group: "operations",
    status: "live",
    preview: "queue",
    legacyBehavior: "Administrators approved or denied pending requests after inspecting details.",
  },
  {
    id: "onboarding",
    path: "/adminbot/onboarding",
    label: "Onboarding",
    shortLabel: "Onboarding",
    eyebrow: "Administration",
    description: "Prepare, preview, and track a member's onboarding plan.",
    audience: "administrator",
    group: "operations",
    status: "backend_pending",
    preview: "queue",
    legacyBehavior: "Administrators previewed welcome messages and tracked required checklist steps.",
    nextBoundary: "The onboarding plan aggregate and proposed-message workflow must be ported first.",
  },
  {
    id: "actions",
    path: "/adminbot/actions",
    label: "Actions & approvals",
    shortLabel: "Actions",
    eyebrow: "Governance",
    description: "Inspect immutable proposals, approvals, execution state, and evidence.",
    audience: "governance",
    group: "operations",
    status: "live",
    preview: "queue",
    legacyBehavior: "The proposal queue displayed risk, payload hashes, approvals, and execution controls.",
  },
  {
    id: "announcements",
    path: "/adminbot/announcements",
    label: "Announcements",
    shortLabel: "Announcements",
    eyebrow: "Communications",
    description: "Select an audience, preview a message, and propose delivery by channel.",
    audience: "administrator",
    group: "operations",
    status: "backend_pending",
    preview: "composer",
    legacyBehavior: "Administrators filtered recipients and sent Slack or email nudges.",
    nextBoundary: "Recipient previews and proposal-first communication actions must be ported first.",
  },
  {
    id: "settings",
    path: "/adminbot/settings",
    label: "Policy settings",
    shortLabel: "Settings",
    eyebrow: "Administration",
    description: "Manage reviewed defaults, privacy routing, and connector policy.",
    audience: "administrator",
    group: "operations",
    status: "live",
    preview: "cards",
    legacyBehavior: "Administrators edited policy defaults and local sensitive-information guidance.",
  },
] as const;

const ROUTES_BY_ID = new Map(APP_ROUTES.map((route) => [route.id, route]));
const ROUTES_BY_PATH = new Map(APP_ROUTES.map((route) => [route.path, route]));

const PATH_ALIASES = new Map<string, AppRouteId>([["/adminbot", "overview"]]);

export const NAV_GROUPS: readonly Readonly<{
  id: AppRouteGroup;
  label: string;
}>[] = [
  { id: "public", label: "Public" },
  { id: "workspace", label: "Workspace" },
  { id: "operations", label: "Operations" },
];

export function appRoute(id: AppRouteId): AppRoute {
  const route = ROUTES_BY_ID.get(id);
  if (route === undefined) throw new Error(`Unknown application route: ${id}`);
  return route;
}

export function routesInGroup(group: AppRouteGroup): readonly AppRoute[] {
  return APP_ROUTES.filter((route) => route.group === group);
}

export function resolveAppRoute(pathname: string): AppRoute {
  const path = normalizePath(pathname);
  const direct = ROUTES_BY_PATH.get(path);
  if (direct !== undefined) return direct;
  const alias = PATH_ALIASES.get(path);
  return alias === undefined ? appRoute("overview") : appRoute(alias);
}

function normalizePath(pathname: string): string {
  const withoutQuery = pathname.split(/[?#]/u, 1)[0] ?? "/";
  if (withoutQuery === "") return "/";
  const withLeadingSlash = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/u, "") : withLeadingSlash;
}

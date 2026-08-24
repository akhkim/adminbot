// Who may see which surface, in one table.
//
// Three roles, ordered least to most privileged. `anonymous` is a real role rather than the
// absence of one: the Control UI opens without a session, and the two surfaces reachable that way
// (the reimbursement assistant and the deadline board) are declared here like everything else, so
// "what can a visitor see" is answered by reading one table instead of by tracing render guards.
//
// This is a visibility contract, not a security boundary. The AdminBot service re-checks every
// privileged route against the authenticated session (`requireMemberPrivileged` in
// mock-service.ts), and the gateway rejects the shared service principal on approval routes. A
// hidden tab is a UI affordance; the server is what actually says no.

import type { Tab } from "../navigation.ts";

export const ACCESS_ROLES = ["anonymous", "member", "admin"] as const;

export type AccessRole = (typeof ACCESS_ROLES)[number];

function rank(role: AccessRole): number {
  return ACCESS_ROLES.indexOf(role);
}

// AdminBot privilege levels that carry governance rights. `admin` alone, matching the service's
// sole approver class (AdminBotApproverRole in service-core.ts); anything below is a plain member.
// The retired `core_member` tier used to sit here too — its access grants folded into `member`,
// its governance rights did not.
const ADMIN_PRIVILEGE_LEVELS = new Set(["admin"]);

export function resolveAccessRole(params: {
  signedIn: boolean;
  privilegeLevel: string | null;
  // A live gateway connection with no member session is the break-glass operator path: whoever
  // holds a gateway credential already has full RPC access, so hiding tabs from them would be
  // theatre. It stays an admin view, exactly as it was before visitors could get in at all.
  gatewayConnected?: boolean;
}): AccessRole {
  if (!params.signedIn) {
    return params.gatewayConnected ? "admin" : "anonymous";
  }
  return ADMIN_PRIVILEGE_LEVELS.has(params.privilegeLevel ?? "") ? "admin" : "member";
}

// Minimum role each tab needs. Every tab is listed: a new tab has to state its audience here or
// the type check fails, so adding a surface can never silently expose it to visitors.
const TAB_MINIMUM_ROLE: Record<Tab, AccessRole> = {
  // Open to visitors. The reimbursement assistant is self-scoped — it only ever sees what the
  // person in front of it typed — and the deadline board is a bundled public snapshot.
  adminbotReimbursements: "anonymous",
  adminbotDeadlines: "anonymous",

  // Members. The roster is lab-internal but not a governance surface, and chat is how members talk
  // to AdminBot at all.
  adminbotMembers: "member",
  // Every member has a schedule page, but it is only ever their own: holidays, courses, other jobs
  // and the note they wrote for the admins are planning data for the people who plan, so reading
  // someone else's is an admin act. The tab is member-level because your own schedule is yours; the
  // service strips the schedule fields from every other member's record on the way out
  // (adminBotScheduleMemberFields), and writing was already restricted to your own record.
  adminbotTimeAvailability: "member",
  // Recordings of the lab's own meetings, for the lab's own members. The tab is member-level
  // because the recording and the summary are what someone who missed the meeting came for; the
  // attendance roster inside it is not, and the service hands a member only their own line and a
  // headcount (listMeetingsForMember). Reading who else was there is an admin act.
  adminbotMeetings: "member",
  // Each of the three request forms starts a request made in the viewer's own name, so each needs
  // an account behind it -- a visitor has no identity for AdminBot to route the signature, the
  // letter or the meeting back to.
  adminbotSignatures: "member",
  adminbotRecLetters: "member",
  adminbotMeetingRequests: "member",
  chat: "member",
  // Nothing behind it yet; member-level so the placeholder sits with the tools it will join.
  // Home for anyone signed in. Every card on it is gated on the viewer's own role, so the page
  // never needs privilege beyond having an account.
  dashboard: "member",
  // Your own record and your own work. Both are scoped to the viewer, so neither needs privilege
  // beyond having an account.
  profile: "member",
  myWork: "member",
  // Lab Sharing is the collaboration surface for every member -- ask for help, answer invites,
  // browse open projects. No data on it requires operator privilege.
  labSharing: "member",

  // Everything else is an operator or governance surface.
  // Active Papers is the lab-wide pipeline across every author, not the viewer's own work -- that
  // is My Work, which stays member-visible and is scoped to them.
  adminbotPapers: "admin",
  adminbotWorkshopNudges: "admin",
  adminbot: "admin",
  adminbotRegistrations: "admin",
  // Everybody's completeness at once, which is a governance read; the service re-checks it.
  adminbotProfileOverview: "admin",
  adminbotOnboarding: "admin",
  adminbotSettings: "admin",
  adminbotAnnouncements: "admin",
  // Reads the lab calendar and spends model time on drafting, and every button on it files a
  // governance-gated action. Admin, and the service re-checks both routes independently.
  // Members. It reads a public conference programme and the viewer's own interests, and writes
  // nothing; the index it searches is the same for everybody.
  adminbotConferencePapers: "member",
  adminbotCalendar: "admin",
  activity: "admin",
  agents: "admin",
  aiAgents: "admin",
  appearance: "admin",
  automation: "admin",
  channels: "admin",
  communications: "admin",
  config: "admin",
  cron: "admin",
  debug: "admin",
  infrastructure: "admin",
  logs: "admin",
  mcp: "admin",
  nodes: "admin",
  overview: "admin",
  sessions: "admin",
  skills: "admin",
  usage: "admin",
};

export function minimumRoleForTab(tab: Tab): AccessRole {
  return TAB_MINIMUM_ROLE[tab];
}

export function canAccessTab(tab: Tab, role: AccessRole): boolean {
  return rank(role) >= rank(TAB_MINIMUM_ROLE[tab]);
}

export function visibleTabsForRole(tabs: readonly Tab[], role: AccessRole): Tab[] {
  return tabs.filter((tab) => canAccessTab(tab, role));
}

// Where a role lands when it has no tab of its own choosing — a fresh visit, or a tab that is no
// longer allowed after signing out. Deliberately the least privileged surface that role can see.
export function defaultTabForRole(role: AccessRole): Tab {
  return role === "anonymous" ? "adminbotDeadlines" : "dashboard";
}

// The tab to actually render: the requested one when the role may see it, otherwise that role's
// default. Signing out mid-session lands on a permitted surface rather than an empty panel.
export function resolveAccessibleTab(tab: Tab, role: AccessRole): Tab {
  return canAccessTab(tab, role) ? tab : defaultTabForRole(role);
}

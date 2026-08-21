// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  canAccessTab,
  defaultTabForRole,
  minimumRoleForTab,
  resolveAccessRole,
  resolveAccessibleTab,
  visibleTabsForRole,
} from "./adminbot/access.ts";
import { TAB_GROUPS, type Tab } from "./navigation.ts";

const ALL_TABS = TAB_GROUPS.flatMap((group) => group.tabs) as readonly Tab[];

describe("resolveAccessRole", () => {
  it("treats a missing session as anonymous however privileged the stale level looks", () => {
    expect(resolveAccessRole({ signedIn: false, privilegeLevel: null })).toBe("anonymous");
    expect(resolveAccessRole({ signedIn: false, privilegeLevel: "admin" })).toBe("anonymous");
  });

  // Regression: the app state carries these fields as undefined before any session is loaded, so
  // a nullish check that only compares against null read "signed in" and demoted a connected
  // operator to a member — which then rewrote their tab out from under them.
  it("treats absent session fields as no session at all", () => {
    expect(
      resolveAccessRole({
        signedIn: Boolean(undefined),
        privilegeLevel: null,
        gatewayConnected: true,
      }),
    ).toBe("admin");
    expect(
      resolveAccessRole({
        signedIn: Boolean(undefined),
        privilegeLevel: null,
        gatewayConnected: false,
      }),
    ).toBe("anonymous");
  });

  it("keeps the break-glass gateway operator on the admin view", () => {
    // Holding a gateway credential already grants full RPC access; hiding tabs would be theatre.
    expect(
      resolveAccessRole({
        signedIn: false,
        privilegeLevel: null,
        gatewayConnected: true,
      }),
    ).toBe("admin");
    expect(
      resolveAccessRole({
        signedIn: false,
        privilegeLevel: null,
        gatewayConnected: false,
      }),
    ).toBe("anonymous");
  });

  it("gives governance levels admin and everything else member", () => {
    expect(resolveAccessRole({ signedIn: true, privilegeLevel: "admin" })).toBe("admin");
    expect(resolveAccessRole({ signedIn: true, privilegeLevel: "member" })).toBe("member");
    expect(resolveAccessRole({ signedIn: true, privilegeLevel: "trial" })).toBe("member");
    expect(
      resolveAccessRole({
        signedIn: true,
        privilegeLevel: "external_collaborator",
      }),
    ).toBe("member");
    // Privilege still loading: a signed-in session is a member until the level says otherwise, so
    // admin controls never flash before the answer arrives.
    expect(resolveAccessRole({ signedIn: true, privilegeLevel: null })).toBe("member");
  });
});

describe("visibleTabsForRole", () => {
  it("shows a visitor the reimbursement assistant and the deadline board, and nothing else", () => {
    // Unchanged by the sidebar rework: the two open tools moved into the "General Tools" group,
    // but a visitor's reachable set is still exactly these two.
    expect(visibleTabsForRole(ALL_TABS, "anonymous")).toEqual([
      "adminbotReimbursements",
      "adminbotDeadlines",
    ]);
  });

  it("adds the roster and the shared tools for a member", () => {
    // Sidebar order: the dashboard, then the profile, then own work, then the shared tools, then
    // Lab Sharing with the roster under it. `chat` is absent because no group lists it -- it
    // renders in the pinned sidebar footer instead.
    expect(visibleTabsForRole(ALL_TABS, "member")).toEqual([
      "dashboard",
      "profile",
      // Your own schedule, next to your own record.
      "adminbotTimeAvailability",
      "myWork",
      "adminbotLogistics",
      "adminbotReimbursements",
      "adminbotDeadlines",
      // Reads a public conference programme against the viewer's own interests, and writes
      // nothing.
      "adminbotConferencePapers",
      "adminbotSocialBot",
      "labSharing",
      // Recordings of the lab's own meetings sit with Lab Sharing, above the roster.
      "adminbotMeetings",
      "adminbotMembers",
    ]);
  });

  it("keeps governance and operator surfaces out of a member's sidebar", () => {
    const member = visibleTabsForRole(ALL_TABS, "member");
    for (const tab of [
      "adminbot",
      "adminbotSettings",
      "adminbotAnnouncements",
      // Writes to the shared calendar and mails people, with no approval queue behind it.
      "adminbotCalendar",
      "cron",
      "config",
    ]) {
      expect(member).not.toContain(tab);
    }
  });

  it("shows an admin everything", () => {
    expect(visibleTabsForRole(ALL_TABS, "admin")).toEqual([...ALL_TABS]);
  });
});

// The Calendar tab sends for real — a member or a visitor reaching it, even by typing the path,
// would be looking at controls that mail the lab.
describe("the Calendar tab", () => {
  it("is admin-only in the table", () => {
    expect(minimumRoleForTab("adminbotCalendar")).toBe("admin");
  });

  it("sends a visitor and a plain member somewhere else when they deep-link to it", () => {
    expect(resolveAccessibleTab("adminbotCalendar", "anonymous")).not.toBe("adminbotCalendar");
    expect(resolveAccessibleTab("adminbotCalendar", "member")).not.toBe("adminbotCalendar");
    expect(resolveAccessibleTab("adminbotCalendar", "admin")).toBe("adminbotCalendar");
  });

  it("is not in a visitor's or a member's sidebar", () => {
    expect(visibleTabsForRole(ALL_TABS, "anonymous")).not.toContain("adminbotCalendar");
    expect(visibleTabsForRole(ALL_TABS, "member")).not.toContain("adminbotCalendar");
  });
});

describe("the access table", () => {
  // A new tab with no entry is a type error, but an entry that defaults to "anonymous" by accident
  // would silently publish a surface. Pin the open set so widening it has to be deliberate.
  it("opens exactly two surfaces to visitors", () => {
    const open = ALL_TABS.filter((tab) => minimumRoleForTab(tab) === "anonymous");
    expect(open).toEqual(["adminbotReimbursements", "adminbotDeadlines"]);
  });

  it("is monotonic: anything a lesser role sees, a greater role sees too", () => {
    const anonymous = visibleTabsForRole(ALL_TABS, "anonymous");
    const member = visibleTabsForRole(ALL_TABS, "member");
    const admin = visibleTabsForRole(ALL_TABS, "admin");
    expect(member).toEqual(expect.arrayContaining(anonymous));
    expect(admin).toEqual(expect.arrayContaining(member));
  });
});

describe("resolveAccessibleTab", () => {
  it("keeps a tab the role may see", () => {
    expect(resolveAccessibleTab("adminbotDeadlines", "anonymous")).toBe("adminbotDeadlines");
    expect(resolveAccessibleTab("adminbotMembers", "member")).toBe("adminbotMembers");
    expect(resolveAccessibleTab("config", "admin")).toBe("config");
  });

  // Signing out of an admin tab, or deep-linking into one, must land somewhere real rather than
  // rendering a privileged panel with no data behind it.
  it("falls back to the role's default when the tab is out of reach", () => {
    expect(resolveAccessibleTab("config", "anonymous")).toBe("adminbotDeadlines");
    expect(resolveAccessibleTab("adminbotSettings", "member")).toBe("dashboard");
    expect(canAccessTab(defaultTabForRole("anonymous"), "anonymous")).toBe(true);
    expect(canAccessTab(defaultTabForRole("member"), "member")).toBe(true);
  });
});

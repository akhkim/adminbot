// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  canAccessTab,
  defaultTabForRole,
  minimumRoleForTab,
  resolveAccessRole,
  resolveAccessibleTab,
  visibleTabsForRole,
} from "./access.ts";
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
      resolveAccessRole({ signedIn: false, privilegeLevel: null, gatewayConnected: true }),
    ).toBe("admin");
    expect(
      resolveAccessRole({ signedIn: false, privilegeLevel: null, gatewayConnected: false }),
    ).toBe("anonymous");
  });

  it("gives governance levels admin and everything else member", () => {
    expect(resolveAccessRole({ signedIn: true, privilegeLevel: "admin" })).toBe("admin");
    expect(resolveAccessRole({ signedIn: true, privilegeLevel: "member" })).toBe("member");
    expect(resolveAccessRole({ signedIn: true, privilegeLevel: "trial" })).toBe("member");
    expect(resolveAccessRole({ signedIn: true, privilegeLevel: "external_collaborator" })).toBe(
      "member",
    );
    // Privilege still loading: a signed-in session is a member until the level says otherwise, so
    // admin controls never flash before the answer arrives.
    expect(resolveAccessRole({ signedIn: true, privilegeLevel: null })).toBe("member");
  });
});

describe("visibleTabsForRole", () => {
  it("shows a visitor the reimbursement assistant and the deadline board, and nothing else", () => {
    expect(visibleTabsForRole(ALL_TABS, "anonymous")).toEqual([
      "adminbotReimbursements",
      "adminbotDeadlines",
    ]);
  });

  it("adds the roster, availability, paper list, and chat for a member", () => {
    expect(visibleTabsForRole(ALL_TABS, "member")).toEqual([
      "dashboard",
      "profile",
      "myWork",
      "chat",
      "adminbotReimbursements",
      "adminbotMembers",
      "adminbotTimeAvailability",
      "adminbotPapers",
      "adminbotDeadlines",
    ]);
  });

  it("keeps governance and operator surfaces out of a member's sidebar", () => {
    const member = visibleTabsForRole(ALL_TABS, "member");
    for (const tab of ["adminbot", "adminbotSettings", "adminbotAnnouncements", "cron", "config"]) {
      expect(member).not.toContain(tab);
    }
  });

  it("shows an admin everything", () => {
    expect(visibleTabsForRole(ALL_TABS, "admin")).toEqual([...ALL_TABS]);
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
    expect(resolveAccessibleTab("adminbotPapers", "member")).toBe("adminbotPapers");
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

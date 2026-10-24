// @vitest-environment jsdom
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPLETE_PROFILE,
  withCompleteProfile,
} from "../../../extensions/adminbot/src/contracts/profile-completion.test-helpers.js";
import {
  clearStoredMemberSession,
  loadStoredMemberSession,
  saveStoredMemberSession,
} from "./adminbot/auth/session.ts";
import { pendingAdminBotLoad } from "./adminbot/controllers/admin.ts";
import { renderApp } from "./app-render.ts";
import { setTab } from "./app-settings.ts";
import type { AppViewState } from "./app-view-state.ts";
import { OpenClawApp } from "./app.ts";

describe("Meeting Recordings entry", () => {
  it("loads papers when a gateway operator leaves a previously loaded non-paper page", async () => {
    clearStoredMemberSession();
    const calls: string[] = [];
    const app = new OpenClawApp();
    app.connected = true;
    app.tab = "adminbotPapers";
    app.adminBotData = { ...app.adminBotData, loadedAt: Date.now(), papersLoadedAt: null };
    app.client = {
      request: async (_method: string, params: { name?: string }) => {
        const name = params?.name ?? "";
        calls.push(name);
        return { ok: true, output: name === "adminbot_list_papers" ? { papers: [] } : {} };
      },
    } as never;
    const container = document.createElement("div");
    render(renderApp(app as unknown as AppViewState), container);
    await vi.waitFor(() => expect(app.adminBotData.papersLoadedAt).not.toBeNull());
    expect(calls).toContain("adminbot_list_papers");
  });

  afterEach(() => {
    clearStoredMemberSession();
    vi.restoreAllMocks();
  });

  it("shows a neutral status while a stored session is being verified, then the gate on failure", () => {
    saveStoredMemberSession({
      sessionToken: "synthetic-session",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    const app = new OpenClawApp();
    app.tab = "adminbotMeetings";
    app.authGateVisible = true;
    const container = document.createElement("div");

    render(renderApp(app as unknown as AppViewState), container);
    expect(container.querySelector('[data-testid="session-restore-pending"]')).toBeTruthy();
    expect(container.querySelector(".login-gate__form")).toBeNull();
    expect(container.querySelector(".landing")).toBeNull();
    expect(container.querySelector(".meetings")).toBeNull();

    app.memberAuthFailure = { kind: "adminbot-unreachable" };
    render(renderApp(app as unknown as AppViewState), container);
    expect(container.querySelector('[data-testid="session-restore-pending"]')).toBeNull();
    expect(container.querySelector(".login-gate__form")).toBeTruthy();
  });

  it("keeps a verified member on their profile when the gateway is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    saveStoredMemberSession({
      sessionToken: "synthetic-session",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    const app = new OpenClawApp();
    app.tab = "profile";
    app.memberId = "synthetic-member";
    app.memberPrivilegeLevel = "member";
    const container = document.createElement("div");

    render(renderApp(app as unknown as AppViewState), container);
    expect(container.querySelector('[data-testid="session-restore-pending"]')).toBeNull();
    expect(container.querySelector(".login-gate__form")).toBeNull();

    app.lastError = "Synthetic gateway failure";
    render(renderApp(app as unknown as AppViewState), container);
    expect(container.querySelector('[data-testid="session-restore-pending"]')).toBeNull();
    expect(container.querySelector(".login-gate__form")).toBeNull();
    await vi.waitFor(() => expect(app.adminBotLoading).toBe(false));
  });

  it("loads meetings from the member session before gateway, roster, or papers", async () => {
    saveStoredMemberSession({
      sessionToken: "synthetic-session",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ meetings: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const app = new OpenClawApp();
    app.tab = "adminbotMeetings";
    app.connected = false;
    app.memberId = "synthetic-member";
    app.memberPrivilegeLevel = "member";
    // The profile gate has already read this member's own row and found it complete; without it
    // the page holds on that read instead of drawing Meetings.
    app.adminBotData = {
      ...app.adminBotData,
      members: [withCompleteProfile({ id: "synthetic-member", privilege_level: "member" })],
    } as typeof app.adminBotData;
    app.adminBotNotifications = [];
    app.adminBotBroadcast = null;
    // The Travel opt-in is read once per session on any tab; already read here, so the only request
    // this render makes is the one under test.
    app.labTravelSharingCheckedFor = "synthetic-session";
    const container = document.createElement("div");

    render(renderApp(app as unknown as AppViewState), container);

    expect(container.querySelector(".meetings")).toBeTruthy();
    expect(container.querySelector(".login-gate")).toBeNull();
    expect(app.adminBotLoading).toBe(false);
    await vi.waitFor(() => expect(app.adminBotMeetingSeries).toEqual([]));
    // The meetings index, and the sidebar's own project list -- the one read every signed-in page
    // makes. Not the roster, the lab's papers, or the gateway; and with no series there is no
    // series to read.
    expect(fetchSpy.mock.calls.map(([url]) => String(url)).toSorted()).toEqual([
      expect.stringContaining("/meetings/series"),
      expect.stringContaining("/my/projects"),
    ]);
  });

  it("shows an admin the meetings list while fetching only the attendance roster", async () => {
    saveStoredMemberSession({
      sessionToken: "synthetic-session",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ self: { id: "synthetic-admin", name: "Admin" }, members: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    const app = new OpenClawApp();
    app.tab = "adminbotMeetings";
    app.connected = false;
    app.memberId = "synthetic-admin";
    app.memberPrivilegeLevel = "admin";
    app.adminBotMeetingsLoading = true;
    app.adminBotNotifications = [];
    app.adminBotBroadcast = null;
    // The Travel opt-in is read once per session on any tab; already read here, so the only request
    // this render makes is the one under test.
    app.labTravelSharingCheckedFor = "synthetic-session";
    const container = document.createElement("div");

    render(renderApp(app as unknown as AppViewState), container);

    expect(container.querySelector(".meetings")).toBeTruthy();
    expect(container.querySelector('[data-testid="adminbot-roster-state"]')).toBeTruthy();
    await vi.waitFor(() => expect(app.adminBotRosterLoadedAt).not.toBeNull());
    expect(fetchSpy.mock.calls.map(([url]) => String(url)).toSorted()).toEqual([
      expect.stringContaining("/lab/members?view=summary"),
      expect.stringContaining("/my/projects"),
    ]);
  });
});

// Exercise the same member controls and read clients together, with no gateway socket.
describe("View as followed by a first paper-page read", () => {
  const ADMIN = "synthetic-view-as-admin";
  const MEMBER = "synthetic-view-as-member";
  const QUEUES = [
    "/proposals/pending",
    "/automation/email/review",
    "/papers/nudges",
    "/papers/conference-rosters",
    "/settings",
    "/sensitive-info",
  ];
  const admin = {
    ...COMPLETE_PROFILE,
    id: "root",
    name: "Ada Admin",
    privilege_level: "admin",
    member_type: "adminbot-admin",
  };
  const member = {
    ...COMPLETE_PROFILE,
    id: "beta",
    name: "Beta Example",
    privilege_level: "member",
    member_type: "full",
  };

  function fixture(refuse = false) {
    const calls: string[] = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === "/auth/impersonate") {
        return refuse
          ? json({ error: { message: "admin privileges required" } }, 403)
          : json({
              session_token: MEMBER,
              expires_at: "2099-01-01",
              member,
              impersonated_by: { id: admin.id, name: admin.name },
            });
      }
      if (path === "/auth/impersonate/stop") {
        return json({ ended: true });
      }
      if (path === "/auth/device-token") {
        return json({ token: "synthetic-device", scopes: ["operator.read"] });
      }
      if (path === "/auth/session") {
        return json({ member: admin, expires_at: "2099-01-01" });
      }
      if (path === "/lab/members/self") {
        return json({
          member: loadStoredMemberSession()?.sessionToken === MEMBER ? member : admin,
        });
      }
      if (path === "/papers") {
        return json({ papers: [] });
      }
      if (QUEUES.includes(path)) {
        return loadStoredMemberSession()?.sessionToken === MEMBER
          ? json({ error: { message: "admin privileges required" } }, 403)
          : json({});
      }
      return json({});
    });
    saveStoredMemberSession({ sessionToken: ADMIN, expiresAt: "2099-01-01" });
    const app = new OpenClawApp();
    app.settings = {
      ...app.settings,
      adminBotUrl: "http://fixture.example",
      gatewayUrl: "ws://fixture.example",
    };
    app.connected = true;
    app.client = { request: vi.fn(async () => ({ ok: true, output: {} })), stop: vi.fn() } as never;
    app.connect = vi.fn();
    app.memberId = admin.id;
    app.memberPrivilegeLevel = "admin";
    app.authGateVisible = false;
    app.landedWithoutATab = false;
    app.tab = "adminbotMembers";
    app.adminBotData = {
      ...app.adminBotData,
      members: [admin, member] as never,
      loadedAt: 1,
      papersLoadedAt: 1,
    };
    app.adminBotMemberList = {
      ...app.adminBotMemberList,
      rows: [admin, member] as never,
      loadedAt: 1,
      total: 2,
    };
    app.adminBotRosterLoadedAt = 1;
    app.setTab = (tab) => setTab(app, tab);
    const container = document.createElement("div");
    const draw = () => render(renderApp(app), container);
    const button = (label: string) =>
      [...container.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === label,
      );
    draw();
    return { app, calls, container, draw, button };
  }

  afterEach(() => {
    clearStoredMemberSession();
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("uses member reads after the real View as control, then restores admin reads on return", async () => {
    const f = fixture();
    expect(f.button("View as")).toBeTruthy();
    f.button("View as")!.click();
    await vi.waitFor(() => expect(f.app.memberImpersonationBusy).toBe(false));
    expect(f.app.memberId).toBe(member.id);
    expect(f.app.adminBotData.members).toEqual([]);
    expect(loadStoredMemberSession()?.impersonator?.sessionToken).toBe(ADMIN);
    f.draw();
    await pendingAdminBotLoad(f.app);
    f.draw();
    expect(
      f.container.querySelector('[data-testid="impersonation-banner"]')?.textContent,
    ).toContain("Beta Example");
    expect(f.app.adminBotData.papersLoadedAt).toBeNull();
    f.calls.length = 0;
    f.app.setTab("adminbotPapers");
    await pendingAdminBotLoad(f.app);
    expect(f.calls).toContain("/papers");
    expect(f.calls.filter((path) => QUEUES.includes(path))).toEqual([]);
    expect(f.app.adminBotData.members.map((row) => row.id)).toEqual([member.id]);
    f.draw();
    f.button("Back to my account")!.click();
    await vi.waitFor(() => expect(f.app.memberImpersonationBusy).toBe(false));
    expect(f.app.memberPrivilegeLevel).toBe("admin");
    expect(loadStoredMemberSession()?.impersonator).toBeUndefined();
    f.calls.length = 0;
    f.app.setTab("adminbotPapers");
    await pendingAdminBotLoad(f.app);
    expect(f.calls.filter((path) => QUEUES.includes(path))).toEqual(QUEUES);
  });

  it("keeps the admin session and reports refusal when View as is denied", async () => {
    const f = fixture(true);
    f.button("View as")!.click();
    await vi.waitFor(() => expect(f.app.memberImpersonationBusy).toBe(false));
    f.draw();
    expect(f.app.memberImpersonationError).toBeTruthy();
    expect(
      f.container.querySelector('[data-testid="impersonation-error"][role="alert"]')?.textContent,
    ).toContain("Only admins can view as another member");
    expect(f.app.memberId).toBe(admin.id);
    expect(loadStoredMemberSession()?.sessionToken).toBe(ADMIN);
    expect(f.container.querySelector('[data-testid="impersonation-banner"]')).toBeNull();
    expect(f.calls.filter((path) => QUEUES.includes(path))).toEqual([]);
  });
  it("shows an unreachable View as service without discarding the admin session", async () => {
    const f = fixture();
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("synthetic service offline"));
    f.button("View as")!.click();
    await vi.waitFor(() => expect(f.app.memberImpersonationBusy).toBe(false));
    f.draw();
    expect(
      f.container.querySelector('[data-testid="impersonation-error"][role="alert"]')?.textContent,
    ).toContain("AdminBot is unreachable");
    expect(f.app.memberId).toBe(admin.id);
    expect(loadStoredMemberSession()?.sessionToken).toBe(ADMIN);
  });
});

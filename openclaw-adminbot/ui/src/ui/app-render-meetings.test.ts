// @vitest-environment jsdom
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearStoredMemberSession, saveStoredMemberSession } from "./adminbot/auth/session.ts";
import { renderApp } from "./app-render.ts";
import type { AppViewState } from "./app-view-state.ts";
import { OpenClawApp } from "./app.ts";

describe("Meeting Recordings entry", () => {
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

  it("keeps a verified member off the sign-in form while the gateway connects", () => {
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
    expect(container.querySelector('[data-testid="session-restore-pending"]')).toBeTruthy();
    expect(container.querySelector(".login-gate__form")).toBeNull();

    app.lastError = "Synthetic gateway failure";
    render(renderApp(app as unknown as AppViewState), container);
    expect(container.querySelector('[data-testid="session-restore-pending"]')).toBeNull();
    expect(container.querySelector(".login-gate__form")).toBeTruthy();
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
    app.adminBotNotifications = [];
    app.adminBotBroadcast = null;
    const container = document.createElement("div");

    render(renderApp(app as unknown as AppViewState), container);

    expect(container.querySelector(".meetings")).toBeTruthy();
    expect(container.querySelector(".login-gate")).toBeNull();
    expect(app.adminBotLoading).toBe(false);
    await vi.waitFor(() => expect(app.adminBotMeetings).toEqual([]));
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/meetings"),
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
    const container = document.createElement("div");

    render(renderApp(app as unknown as AppViewState), container);

    expect(container.querySelector(".meetings")).toBeTruthy();
    expect(container.querySelector('[data-testid="adminbot-roster-state"]')).toBeTruthy();
    await vi.waitFor(() => expect(app.adminBotRosterLoadedAt).not.toBeNull());
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/lab/members?view=summary"),
    ]);
  });
});

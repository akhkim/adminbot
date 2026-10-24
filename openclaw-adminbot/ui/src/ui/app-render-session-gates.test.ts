// @vitest-environment jsdom
//
// The render pass starts member reads, then re-renders when they settle. Every such loader reads
// the stored session and returns at once without one, leaving its "not asked yet" state in place.
// So a render that opened a gate on the in-memory member alone -- signed out in another tab, or a
// session the browser refused to store -- would ask, settle, re-render and ask again for ever.
// Only reachable with the gateway connected: without it, renderApp shows the login gate first.
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearStoredMemberSession } from "./adminbot/auth/session.ts";
import { renderApp } from "./app-render.ts";
import type { AppViewState } from "./app-view-state.ts";
import { OpenClawApp } from "./app.ts";

function signedInWithoutStoredSession(tab: string, privilege: "admin" | "member") {
  clearStoredMemberSession();
  const app = new OpenClawApp();
  app.tab = tab as never;
  app.connected = true;
  app.memberId = "synthetic-member";
  app.memberPrivilegeLevel = privilege;
  app.adminBotNotifications = [];
  app.adminBotBroadcast = null;
  return app;
}

describe("render-pass reads without a stored session", () => {
  afterEach(() => {
    clearStoredMemberSession();
    vi.restoreAllMocks();
  });

  it("does not ask for the location prompt on the profile", () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const app = signedInWithoutStoredSession("profile", "member");
    const ask = vi.fn(async () => {});
    app.loadLocationPrompt = ask;
    render(renderApp(app as unknown as AppViewState), document.createElement("div"));
    expect(ask).not.toHaveBeenCalled();
  });

  it("does not ask for location drifts on the calendar", () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const app = signedInWithoutStoredSession("adminbotCalendar", "admin");
    const ask = vi.fn(async () => {});
    app.loadLocationDrifts = ask;
    render(renderApp(app as unknown as AppViewState), document.createElement("div"));
    expect(ask).not.toHaveBeenCalled();
  });
});

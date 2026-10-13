import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { COMPLETE_PROFILE } from "../../../../../extensions/adminbot/src/contracts/profile-completion.test-helpers.js";
import { renderTab } from "../../app-render.helpers.ts";
import { renderApp } from "../../app-render.ts";
import type { AppViewState } from "../../app-view-state.ts";
import * as admin from "../controllers/admin.ts";
import { isProfileBlocked, profileAccessState } from "./profile-gate.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function state(member = { ...COMPLETE_PROFILE, location: "" }): AppViewState {
  return {
    memberId: member.id,
    tab: "profile",
    basePath: "",
    settings: { navCollapsed: false },
    setTab: vi.fn(),
    memberPrivilegeLevel: member.privilege_level,
    adminBotData: { members: [member], papers: [], proposals: [] },
    profileAccountChecks: {},
    adminBotPhotoVariants: [],
    adminBotSettings: {},
    signOutMember: vi.fn(),
  } as unknown as AppViewState;
}
it("gates regular members only and honors conditional requirements", () => {
  const host = state();
  expect(isProfileBlocked(host)).toBe(true);
  host.adminBotData.members = [COMPLETE_PROFILE as never];
  expect(isProfileBlocked(host)).toBe(false);
  host.adminBotData.members = [];
  expect(isProfileBlocked(host)).toBe(false);
  expect(profileAccessState(host)).toBe("loading");
  for (const role of ["external_collaborator", "trial", "admin"] as const) {
    host.memberPrivilegeLevel = role;
    expect(isProfileBlocked(host)).toBe(false);
  }
  host.memberId = null;
  expect(isProfileBlocked(host)).toBe(false);
});
it("disables other tabs without links, keeps My Profile active, and unlocks on completion", () => {
  const host = state();
  const container = document.createElement("div");
  document.body.append(container);
  render(renderTab(host, "dashboard"), container);
  expect(container.querySelector('[aria-disabled="true"]')).not.toBeNull();
  expect(container.querySelector("a")).toBeNull();
  container.querySelector<HTMLElement>(".nav-item")?.click();
  expect(host.setTab).not.toHaveBeenCalled();
  render(renderTab(host, "profile"), container);
  expect(container.querySelector("a.nav-item--active")).not.toBeNull();
  host.adminBotData.members = [COMPLETE_PROFILE as never];
  render(renderTab(host, "dashboard"), container);
  expect(container.querySelector("a")).not.toBeNull();
  host.memberPrivilegeLevel = "admin";
  host.adminBotData.members = [];
  render(renderTab(host, "dashboard"), container);
  expect(container.querySelector("a")).not.toBeNull();
});

it("loads the profile without rendering the requested feature or changing its route", () => {
  const host = state();
  host.tab = "dashboard";
  host.adminBotData.members = [];
  const load = vi.spyOn(admin, "loadAdminBot").mockImplementation(async () => {
    host.adminBotLoading = true;
  });
  const container = document.createElement("div");
  render(renderApp(host), container);
  expect(load).toHaveBeenCalledWith(host, "general", false);
  expect(container.querySelector('[data-testid="profile-loading"]')).not.toBeNull();
  expect(host.setTab).not.toHaveBeenCalled();
  expect(host.tab).toBe("dashboard");
  render(renderApp(host), container);
  expect(load).toHaveBeenCalledTimes(1);
  host.adminBotData.members = [COMPLETE_PROFILE as never];
  expect(profileAccessState(host)).toBe("ready");
  expect(host.tab).toBe("dashboard");
});

it("keeps a failed profile load blocked and offers retry without redirecting", () => {
  const host = state();
  host.tab = "dashboard";
  host.adminBotData.members = [];
  host.adminBotError = "Unable to load your profile.";
  const load = vi.spyOn(admin, "loadAdminBot").mockResolvedValue();
  const container = document.createElement("div");
  render(renderApp(host), container);
  expect(container.textContent).toContain(host.adminBotError);
  expect(load).not.toHaveBeenCalled();
  const retry = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Try again"),
  );
  retry?.click();
  expect(load).toHaveBeenCalledWith(host, "general", false);
  expect(host.setTab).not.toHaveBeenCalled();
});

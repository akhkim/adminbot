// @vitest-environment jsdom
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { clearStoredMemberSession, saveStoredMemberSession } from "./adminbot/auth/session.ts";
import { renderApp } from "./app-render.ts";
import type { AppViewState } from "./app-view-state.ts";
import { OpenClawApp } from "./app.ts";

afterEach(() => {
  clearStoredMemberSession();
  vi.restoreAllMocks();
});

it("opens PI review from its queue without loading the full paper list", () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("synthetic offline"));
  saveStoredMemberSession({ sessionToken: "synthetic-session", expiresAt: "2099-01-01T00:00:00Z" });
  const app = new OpenClawApp();
  app.tab = "adminbotProfessor";
  app.memberId = "pi";
  app.memberPrivilegeLevel = "admin";
  app.adminBotData = {
    papers: [],
    members: [],
    settings: { head_professor_member_id: "pi" },
  } as never;
  app.adminBotPiReview = [
    {
      paperId: "p1",
      title: "Synthetic queued paper",
      authors: ["Test Author"],
      packageComplete: false,
    },
  ];
  app.adminBotProfileOverviewLoadedAt = Date.now();
  app.adminBotRosterLoadedAt = Date.now();
  app.adminBotLoading = true;
  const container = document.createElement("div");
  render(renderApp(app as unknown as AppViewState), container);
  expect(container.querySelector('[data-testid="paper-card-dialog"]')).toBeNull();
  Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent?.includes("Synthetic queued paper"))!
    .click();
  render(renderApp(app as unknown as AppViewState), container);
  const dialog = container.querySelector('[data-testid="paper-card-dialog"]');
  expect(dialog?.getAttribute("aria-label")).toBe("Review Synthetic queued paper");
  expect(dialog?.textContent).toContain("Loading paper review");
  expect(app.adminBotData.papers).toEqual([]);
});

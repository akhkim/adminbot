// @vitest-environment jsdom
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { clearStoredMemberSession } from "./adminbot/auth/session.ts";
import * as admin from "./adminbot/controllers/admin.ts";
import { renderApp } from "./app-render.ts";
import type { AppViewState } from "./app-view-state.ts";
import { OpenClawApp } from "./app.ts";

afterEach(() => {
  clearStoredMemberSession();
  vi.restoreAllMocks();
});

it("loads and refreshes reviewers for a gateway-only admin and displays loading/errors", async () => {
  clearStoredMemberSession();
  const app = new OpenClawApp();
  app.connected = true;
  app.tab = "adminbotArrReviewers";
  const load = vi.spyOn(admin, "loadAdminBot").mockImplementation(async (host) => {
    host.adminBotLoading = true;
  });
  const roster = vi.spyOn(admin, "loadAdminBotRoster");
  const container = document.createElement("div");
  const draw = () => render(renderApp(app as unknown as AppViewState), container);

  draw();
  expect(load).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Loading reviewers");
  expect(container.textContent).not.toContain("No users have confirmed");

  app.adminBotLoading = false;
  app.adminBotError = "Synthetic gateway failure";
  draw();
  expect(container.textContent).toContain("Synthetic gateway failure");
  expect(container.textContent).not.toContain("No users have confirmed");

  load.mockImplementation(async (host) => {
    host.adminBotError = null;
    host.adminBotData = {
      ...host.adminBotData,
      loadedAt: Date.now(),
      members: [
        {
          id: "reviewer",
          name: "Test Reviewer",
          arr_reviewer_qualified: true,
          arr_review_capacity: 2,
        },
      ],
    };
  });
  const refresh = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Refresh",
  );
  expect(refresh).toBeTruthy();
  refresh!.click();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(roster).not.toHaveBeenCalled();
  draw();
  expect(container.textContent).toContain("Test Reviewer");
  expect(container.textContent).not.toContain("Synthetic gateway failure");
});

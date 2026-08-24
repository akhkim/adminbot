import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import { createEmptyAdminBotReimbursementState } from "../controllers/admin.ts";
import { renderPublicShell } from "./public-shell.ts";

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    tab: "adminbotDeadlines",
    basePath: "",
    settings: { adminBotUrl: "http://127.0.0.1:8765" },
    adminBotReimbursement: createEmptyAdminBotReimbursementState(),
    authGateVisible: false,
    ...overrides,
  } as unknown as AppViewState;
}

function renderShell(state: AppViewState): HTMLElement {
  const container = document.createElement("div");
  render(renderPublicShell(state), container);
  return container;
}

describe("renderPublicShell", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = renderShell(createState());
  });

  it("offers a visitor exactly the two open surfaces", () => {
    const items = [...container.querySelectorAll(".sidebar-nav .nav-item")];
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      "/adminbot/reimbursements",
      "/adminbot/deadlines",
    ]);
  });

  it("puts a sign-in button in the topbar rather than a gate in front of the page", () => {
    const signIn = container.querySelector('[data-testid="public-shell-sign-in"]');
    expect(signIn).not.toBeNull();
    expect(signIn?.textContent?.trim()).toContain("Sign in");
    expect(signIn?.closest(".topbar")).not.toBeNull();
    expect(signIn?.closest(".sidebar")).toBeNull();
  });

  it("opens the sign-in gate on demand", () => {
    const state = createState();
    const host = renderShell(state);
    host.querySelector<HTMLButtonElement>('[data-testid="public-shell-sign-in"]')?.click();
    expect(state.authGateVisible).toBe(true);
  });

  it("navigates between the two surfaces in place", () => {
    const state = createState();
    const host = renderShell(state);
    const reimbursements = host.querySelector<HTMLAnchorElement>(
      '.nav-item[href="/adminbot/reimbursements"]',
    );
    reimbursements?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(state.tab).toBe("adminbotReimbursements");
    expect(window.location.pathname).toBe("/adminbot/reimbursements");
  });

  // Leaving the open surface is the same move as opening the root: an anonymous visitor with a
  // non-open tab resolves to the landing page, so the back control hands control back there.
  it("returns to the landing page from an open surface", () => {
    const state = createState();
    const host = renderShell(state);
    host.querySelector<HTMLAnchorElement>('[data-testid="public-shell-back"]')?.click();
    expect(state.tab).toBe("chat");
  });

  // The deadline board is a bundled snapshot, so it has to render with no gateway and no session.
  it("renders the deadline board without a session behind it", async () => {
    document.body.append(container);
    const view = container.querySelector("adminbot-deadlines-view") as {
      updateComplete?: Promise<unknown>;
    };
    await view.updateComplete;
    container.remove();
    expect(container.textContent).toContain("Upcoming conference & workshop deadlines.");
    expect(container.querySelector(".content--public-deadlines > .adminbot-card")).toBeNull();
  });
});

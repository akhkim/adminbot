/* @vitest-environment jsdom */

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

  // The whole General Tools group, in the sidebar's own order. Read off TAB_GROUPS rather than
  // listed here twice, which is what let the shell keep rendering two after the access table
  // opened four.
  it("offers a visitor every open surface", () => {
    const items = [...container.querySelectorAll(".sidebar-nav .nav-item")];
    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      "/reimbursements",
      "/deadlines",
      "/opportunities",
      "/conference-papers",
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
      '.nav-item[href="/reimbursements"]',
    );
    reimbursements?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(state.tab).toBe("adminbotReimbursements");
    expect(window.location.pathname).toBe("/reimbursements");
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
    expect(container.textContent).toContain("Past and upcoming conference & workshop deadlines.");
    expect(container.querySelector(".content--public-deadlines > .adminbot-card")).toBeNull();
  });
});

// Light and dark are the one preference that is purely about the person looking at the page, and
// the controls for it live in Appearance and Settings -- both admin-only. A visitor had no way to
// change the theme at all.
describe("public shell theme toggle", () => {
  function toggleIn(state: AppViewState): HTMLButtonElement {
    const container = renderShell(state);
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="public-shell-theme"]',
    );
    expect(button).not.toBeNull();
    return button as HTMLButtonElement;
  }

  it("offers dark mode without an account", () => {
    const modes: string[] = [];
    const state = createState({
      themeResolved: "dark",
      setThemeMode: (mode: string) => modes.push(mode),
    } as unknown as Partial<AppViewState>);
    const button = toggleIn(state);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    button.click();
    // Dark now, so the toggle offers light.
    expect(modes).toEqual(["light"]);
  });

  it("switches back the other way", () => {
    const modes: string[] = [];
    const state = createState({
      themeResolved: "light",
      setThemeMode: (mode: string) => modes.push(mode),
    } as unknown as Partial<AppViewState>);
    const button = toggleIn(state);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    button.click();
    expect(modes).toEqual(["dark"]);
  });

  it("sits in the topbar, next to the sign-in button", () => {
    const state = createState({
      themeResolved: "dark",
      setThemeMode: () => undefined,
    } as unknown as Partial<AppViewState>);
    const container = renderShell(state);
    const button = container.querySelector('[data-testid="public-shell-theme"]');
    expect(button?.closest(".topbar")).not.toBeNull();
  });
});

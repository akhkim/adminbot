import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import { renderLanding } from "./landing.ts";

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    tab: "chat",
    basePath: "",
    authGateVisible: false,
    ...overrides,
  } as unknown as AppViewState;
}

function renderPage(state: AppViewState): HTMLElement {
  const container = document.createElement("div");
  render(renderLanding(state), container);
  return container;
}

describe("renderLanding", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = renderPage(createState());
  });

  it("names the lab", () => {
    expect(container.querySelector(".landing__wordmark")?.textContent?.replace(/\s+/gu, "")).toBe(
      "JinesisLab",
    );
  });

  it("opens the sign-in gate from the primary action", () => {
    const state = createState();
    const host = renderPage(state);
    const cta = host.querySelector<HTMLButtonElement>('[data-testid="landing-sign-in"]');
    expect(cta?.textContent?.trim()).toBe("Sign in or sign up");
    cta?.click();
    expect(state.authGateVisible).toBe(true);
  });

  it("opens the same gate from the header action", () => {
    const state = createState();
    const host = renderPage(state);
    const action = host.querySelector<HTMLButtonElement>(
      '[data-testid="signed-out-header-sign-in"]',
    );
    expect(action?.textContent?.trim()).toBe("Sign in");
    action?.click();
    expect(state.authGateVisible).toBe(true);
  });

  // The offer the landing page makes has to match the access table, or a visitor follows a link
  // into a surface that then bounces them somewhere else.
  it("links only to the surfaces a visitor can open without an account", () => {
    const links = [...container.querySelectorAll<HTMLAnchorElement>(".landing__surface")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/adminbot/reimbursements",
      "/adminbot/deadlines",
    ]);
  });

  it("navigates into an open surface in place", () => {
    const state = createState();
    const host = renderPage(state);
    host
      .querySelector<HTMLAnchorElement>('.landing__surface[href="/adminbot/deadlines"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(state.tab).toBe("adminbotDeadlines");
  });
});

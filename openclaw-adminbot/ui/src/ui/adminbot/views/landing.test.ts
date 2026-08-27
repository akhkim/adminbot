import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
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
    expect(cta?.textContent?.trim()).toBe("Log In or Sign Up");
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

  // The offer the landing page makes has to match the access table, or a visitor follows the
  // guest link into a surface that then bounces them somewhere else.
  it("offers a single guest entry point into a surface a visitor can open without an account", () => {
    const guest = container.querySelector<HTMLAnchorElement>(
      '[data-testid="landing-continue-as-guest"]',
    );
    expect(guest?.textContent?.trim()).toBe("Continue as a guest");
    expect(guest?.getAttribute("href")).toBe("/reimbursements");
  });

  it("navigates into the guest surface in place", () => {
    const state = createState();
    const host = renderPage(state);
    host
      .querySelector<HTMLAnchorElement>('[data-testid="landing-continue-as-guest"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(state.tab).toBe("adminbotReimbursements");
  });
});

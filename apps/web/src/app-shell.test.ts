// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminBotAppShell } from "./app-shell.js";
import { THEME_STORAGE_KEY } from "./theme.js";

if (!customElements.get("adminbot-app")) {
  customElements.define("adminbot-app", AdminBotAppShell);
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("AdminBotAppShell", () => {
  it("renders an AdminBot-only product shell with dark mode by default", async () => {
    const element = mountShell();
    await element.updateComplete;

    const content = element.shadowRoot?.textContent ?? "";
    expect(content).toContain("A quieter way to run the lab");
    expect(content).not.toContain("OpenClaw");
    expect(element.getAttribute("data-theme")).toBeNull();
    expect(
      element.shadowRoot?.querySelector('[aria-label="Switch to light mode"]'),
    ).not.toBeNull();
  });

  it("uses the centralized route registry for in-place navigation", async () => {
    const element = mountShell();
    await element.updateComplete;

    element.shadowRoot
      ?.querySelector<HTMLAnchorElement>('a[href="/adminbot/members"]')
      ?.click();
    await element.updateComplete;

    expect(window.location.pathname).toBe("/adminbot/members");
    expect(element.shadowRoot?.querySelector("h1")?.textContent).toBe("Lab members");
    expect(element.shadowRoot?.textContent).toContain(
      "data and commands are not connected",
    );
    expect(document.title).toBe("Lab members · AdminBot");
  });

  it("persists only the selected color theme", async () => {
    const element = mountShell();
    await element.updateComplete;

    element.shadowRoot
      ?.querySelector<HTMLButtonElement>('[aria-label="Switch to light mode"]')
      ?.click();
    await element.updateComplete;

    expect(element.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(window.localStorage.length).toBe(1);
  });

  it("mounts the connected registration flow at the public access route", async () => {
    window.history.replaceState({}, "", "/access");
    const element = mountShell();
    await element.updateComplete;

    expect(element.shadowRoot?.querySelector("adminbot-registration-app")).not.toBeNull();
    expect(document.title).toBe("Request access · AdminBot");
  });
});

function mountShell(): AdminBotAppShell {
  const element = document.createElement("adminbot-app") as AdminBotAppShell;
  document.body.append(element);
  return element;
}

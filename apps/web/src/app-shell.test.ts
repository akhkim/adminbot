// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminBotAppShell } from "./app-shell.js";
import type { SessionClient } from "./api-client.js";
import { SESSION_CHANGED_EVENT } from "./identity-events.js";
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
      ?.querySelector<HTMLAnchorElement>('a[href="/adminbot/reimbursements"]')
      ?.click();
    await element.updateComplete;

    expect(window.location.pathname).toBe("/adminbot/reimbursements");
    expect(element.shadowRoot?.querySelector("h1")?.textContent).toBe("Reimbursements");
    expect(element.shadowRoot?.textContent).toContain(
      "data and commands are not connected",
    );
    expect(document.title).toBe("Reimbursements · AdminBot");
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

  it("restores an administrator session and exposes only authorized navigation", async () => {
    const element = mountShell({
      restore: vi.fn(async () => session()),
      login: vi.fn(),
      logout: vi.fn(async () => undefined),
    });
    await vi.waitFor(() => {
      expect(element.shadowRoot?.querySelector('a[href="/adminbot/registrations"]')).not.toBeNull();
    });
    expect(element.shadowRoot?.querySelector('a[href="/sign-in"]')).toBeNull();
    expect(element.shadowRoot?.textContent).toContain("Synthetic Administrator");
  });

  it("accepts a safe session event from the login component and signs out through the API", async () => {
    window.history.replaceState({}, "", "/sign-in");
    const logout = vi.fn(async () => undefined);
    const element = mountShell({ restore: vi.fn(async () => undefined), login: vi.fn(), logout });
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector("adminbot-login-app")).not.toBeNull());
    element.dispatchEvent(new CustomEvent(SESSION_CHANGED_EVENT, {
      detail: { session: session() },
      bubbles: true,
      composed: true,
    }));
    await element.updateComplete;
    expect(window.location.pathname).toBe("/");
    [...(element.shadowRoot?.querySelectorAll<HTMLButtonElement>(".topbar .icon-button") ?? [])]
      .find((button) => button.textContent?.trim() === "Sign out")
      ?.click();
    await vi.waitFor(() => expect(logout).toHaveBeenCalledOnce());
    expect(window.location.pathname).toBe("/sign-in");
  });
});

function mountShell(client: SessionClient = {
  restore: vi.fn(async () => undefined),
  login: vi.fn(),
  logout: vi.fn(async () => undefined),
}): AdminBotAppShell {
  const element = document.createElement("adminbot-app") as AdminBotAppShell;
  element.sessionClient = client;
  document.body.append(element);
  return element;
}

function session() {
  return {
    sessionId: "40000000-0000-4000-8000-000000000001",
    expiresAt: "2026-08-09T12:00:00.000Z",
    authenticationLevel: "recent_reauthentication" as const,
    person: {
      id: "20000000-0000-4000-8000-000000000001",
      organizationId: "10000000-0000-4000-8000-000000000001",
      displayName: "Synthetic Administrator",
      status: "active" as const,
      version: 1,
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    },
    roles: ["administrator" as const],
  };
}

// @vitest-environment happy-dom

import type { LoginInput, SessionView } from "@adminbot/api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminBotApiError, type SessionClient } from "./api-client.js";
import { SESSION_CHANGED_EVENT } from "./identity-events.js";
import { AdminBotLoginApp } from "./login-app.js";

if (!customElements.get("adminbot-login-app")) customElements.define("adminbot-login-app", AdminBotLoginApp);

afterEach(() => document.body.replaceChildren());

describe("AdminBotLoginApp", () => {
  it("shows password visibility and emits the server session after sign-in", async () => {
    const login = vi.fn(async (_input: LoginInput) => session());
    const element = mount({ login, restore: vi.fn(), logout: vi.fn() });
    const changed = vi.fn();
    element.addEventListener(SESSION_CHANGED_EVENT, changed);
    await element.updateComplete;
    element.shadowRoot?.querySelector<HTMLButtonElement>(".reveal")?.click();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector<HTMLInputElement>('[name="password"]')?.type).toBe("text");
    setValue(element, "email", "admin@example.com");
    setValue(element, "password", "correct horse battery staple");
    element.shadowRoot?.querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(login).toHaveBeenCalledWith({ email: "admin@example.com", password: "correct horse battery staple" });
  });

  it("distinguishes a verified pending registration without creating a session", async () => {
    const login = vi.fn(async () => { throw new AdminBotApiError(403, "account_pending_approval", "account pending approval"); });
    const element = mount({ login, restore: vi.fn(), logout: vi.fn() });
    await element.updateComplete;
    setValue(element, "email", "pending@example.com");
    setValue(element, "password", "correct horse battery staple");
    element.shadowRoot?.querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector(".pending-notice")).not.toBeNull());
  });
});

function mount(client: SessionClient): AdminBotLoginApp {
  const element = document.createElement("adminbot-login-app") as AdminBotLoginApp;
  element.client = client;
  document.body.append(element);
  return element;
}
function setValue(element: AdminBotLoginApp, name: string, value: string): void {
  const input = element.shadowRoot?.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (input === null || input === undefined) throw new Error(`missing test input: ${name}`);
  input.value = value;
}

function session(): SessionView {
  return {
    sessionId: "40000000-0000-4000-8000-000000000001",
    expiresAt: "2026-08-09T12:00:00.000Z",
    authenticationLevel: "recent_reauthentication",
    person: {
      id: "20000000-0000-4000-8000-000000000001",
      organizationId: "10000000-0000-4000-8000-000000000001",
      displayName: "Synthetic Administrator",
      status: "active",
      version: 1,
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    },
    roles: ["administrator"],
  };
}

// @vitest-environment happy-dom

import type {
  ClaimRegistrationInput,
  SignupRegistrationInput,
} from "@adminbot/api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegistrationClient } from "./api-client.js";
import { AdminBotRegistrationApp } from "./registration-app.js";

const PERSON_ID = "20000000-0000-4000-8000-000000000001";

if (!customElements.get("adminbot-registration-app")) {
  customElements.define("adminbot-registration-app", AdminBotRegistrationApp);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("AdminBotRegistrationApp", () => {
  it("renders a searchable claim roster and a pending-only completion state", async () => {
    const client = fakeClient();
    const element = document.createElement(
      "adminbot-registration-app",
    ) as AdminBotRegistrationApp;
    element.client = client;
    document.body.append(element);
    await element.updateComplete;
    await vi.waitFor(() => {
      expect(element.shadowRoot?.querySelector('[role="option"]')?.textContent).toContain(
        "Synthetic Member",
      );
    });

    (element.shadowRoot?.querySelector('[role="option"]') as HTMLButtonElement).click();
    await element.updateComplete;
    setValue(element, "email", "member@example.com");
    setValue(element, "password", "correct horse battery staple");
    setValue(element, "passwordConfirmation", "correct horse battery staple");
    const form = element.shadowRoot?.querySelector("form");
    form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(element.shadowRoot?.querySelector(".pending")?.textContent).toContain(
        "No account session has been created yet",
      );
    });
    expect(client.submitClaim).toHaveBeenCalledWith({
      personId: PERSON_ID,
      email: "member@example.com",
      password: "correct horse battery staple",
    });
  });

  it("submits the new-member form through the registration client", async () => {
    const client = fakeClient();
    const element = document.createElement(
      "adminbot-registration-app",
    ) as AdminBotRegistrationApp;
    element.client = client;
    document.body.append(element);
    await element.updateComplete;
    const tabs = element.shadowRoot?.querySelectorAll<HTMLButtonElement>(".tabs button");
    tabs?.[1]?.click();
    await element.updateComplete;
    setValue(element, "displayName", "Synthetic Applicant");
    setValue(element, "email", "applicant@example.com");
    setValue(element, "password", "correct horse battery staple");
    setValue(element, "passwordConfirmation", "correct horse battery staple");
    element.shadowRoot
      ?.querySelector("form")
      ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(client.submitSignup).toHaveBeenCalledOnce());
    expect(client.submitSignup).toHaveBeenCalledWith({
      email: "applicant@example.com",
      password: "correct horse battery staple",
      profile: { displayName: "Synthetic Applicant" },
    });
  });
});

function fakeClient(): RegistrationClient & {
  submitClaim: ReturnType<typeof vi.fn<RegistrationClient["submitClaim"]>>;
  submitSignup: ReturnType<typeof vi.fn<RegistrationClient["submitSignup"]>>;
} {
  const submitClaim = vi.fn(async (_input: ClaimRegistrationInput) => ({
    registrationId: "30000000-0000-4000-8000-000000000001",
    state: "submitted" as const,
  }));
  const submitSignup = vi.fn(async (_input: SignupRegistrationInput) => ({
    registrationId: "30000000-0000-4000-8000-000000000002",
    state: "submitted" as const,
  }));
  return {
    listClaimablePeople: vi.fn(async () => [
      { personId: PERSON_ID, displayName: "Synthetic Member" },
    ]),
    submitClaim,
    submitSignup,
  };
}

function setValue(element: AdminBotRegistrationApp, name: string, value: string): void {
  const input = element.shadowRoot?.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (input === null || input === undefined) throw new Error(`missing test input: ${name}`);
  input.value = value;
}

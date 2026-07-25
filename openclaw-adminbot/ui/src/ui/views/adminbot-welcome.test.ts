/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { MemberOnboarding } from "../adminbot-auth.ts";
import type { AppViewState } from "../app-view-state.ts";
import { renderAdminBotWelcome } from "./adminbot-welcome.ts";

function createState(onboarding: MemberOnboarding | null): AppViewState {
  return {
    basePath: "",
    memberId: "pat",
    adminBotOnboarding: onboarding,
    adminBotWelcomeVisible: true,
  } as unknown as AppViewState;
}

describe("renderAdminBotWelcome", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("renders nothing when there is no onboarding checklist", () => {
    const container = document.createElement("div");
    render(renderAdminBotWelcome(createState(null)), container);
    expect(container.textContent?.trim()).toBe("");
  });

  it("renders every step with its label, detail, and status", () => {
    const container = document.createElement("div");
    const onboarding: MemberOnboarding = {
      current_step: {
        id: "profile_photo",
        label: "Upload a professional profile photo",
        status: "current",
        required: true,
        detail: "Add a headshot.",
      },
      completed: [
        {
          id: "calendar_invite",
          label: "Lab calendar access",
          status: "complete",
          required: true,
          detail: "Already granted.",
        },
      ],
      remaining: [
        {
          id: "profile_photo",
          label: "Upload a professional profile photo",
          status: "current",
          required: true,
          detail: "Add a headshot.",
        },
      ],
      steps: [
        {
          id: "calendar_invite",
          label: "Lab calendar access",
          status: "complete",
          required: true,
          detail: "Already granted.",
        },
        {
          id: "profile_photo",
          label: "Upload a professional profile photo",
          status: "current",
          required: true,
          detail: "Add a headshot.",
        },
      ],
    };
    render(renderAdminBotWelcome(createState(onboarding)), container);

    expect(container.textContent).toContain("Lab calendar access");
    expect(container.textContent).toContain("Already granted.");
    expect(container.textContent).toContain("Upload a professional profile photo");
    expect(container.textContent).toContain("Add a headshot.");
    expect(container.querySelectorAll(".adminbot-welcome__step")).toHaveLength(2);
  });

  it("dismiss button hides the welcome screen and remembers it was seen", () => {
    const container = document.createElement("div");
    const state = createState({
      completed: [],
      remaining: [],
      steps: [{ id: "x", label: "X", status: "current", required: true }],
    });
    render(renderAdminBotWelcome(state), container);

    container.querySelector<HTMLButtonElement>(".adminbot-welcome__dismiss")?.click();
    expect(state.adminBotWelcomeVisible).toBe(false);
  });
});

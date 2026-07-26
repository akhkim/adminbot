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

  it("renders every step with its label, detail, and status, grouped under its category", () => {
    const container = document.createElement("div");
    const onboarding: MemberOnboarding = {
      current_step: {
        id: "profile_photo",
        label: "Upload a professional profile photo",
        status: "current",
        category: "Getting started",
        required: true,
        detail: "Add a headshot.",
      },
      completed: [
        {
          id: "calendar_invite",
          label: "Lab calendar access",
          status: "complete",
          category: "Getting started",
          required: true,
          detail: "Already granted.",
        },
      ],
      remaining: [
        {
          id: "profile_photo",
          label: "Upload a professional profile photo",
          status: "current",
          category: "Getting started",
          required: true,
          detail: "Add a headshot.",
        },
      ],
      steps: [
        {
          id: "calendar_invite",
          label: "Lab calendar access",
          status: "complete",
          category: "Getting started",
          required: true,
          detail: "Already granted.",
        },
        {
          id: "profile_photo",
          label: "Upload a professional profile photo",
          status: "current",
          category: "Getting started",
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
    const categoryTitles = [...container.querySelectorAll(".adminbot-welcome__category-title")].map(
      (el) => el.textContent,
    );
    expect(categoryTitles).toEqual(["Getting started"]);
  });

  it("groups steps into separate category sections in a fixed order", () => {
    const container = document.createElement("div");
    const onboarding: MemberOnboarding = {
      completed: [],
      remaining: [],
      steps: [
        {
          id: "twitter",
          label: "Follow X",
          status: "remaining",
          category: "Social media",
          required: false,
        },
        {
          id: "profile_photo",
          label: "Photo",
          status: "current",
          category: "Getting started",
          required: true,
        },
      ],
    };
    render(renderAdminBotWelcome(createState(onboarding)), container);

    const categoryTitles = [...container.querySelectorAll(".adminbot-welcome__category-title")].map(
      (el) => el.textContent,
    );
    // Fixed category order wins regardless of the input steps' order.
    expect(categoryTitles).toEqual(["Getting started", "Social media"]);
  });

  it("renders bullets as a list and links as clickable buttons", () => {
    const container = document.createElement("div");
    const onboarding: MemberOnboarding = {
      completed: [],
      remaining: [],
      steps: [
        {
          id: "linkedin",
          label: "Connect on LinkedIn",
          status: "current",
          category: "Social media",
          required: true,
          bullets: ["Update your headline", "Join the company page"],
          links: [{ label: "Connect with Zhijing", url: "https://linkedin.com/in/zhijing-jin/" }],
        },
      ],
    };
    render(renderAdminBotWelcome(createState(onboarding)), container);

    const bullets = [...container.querySelectorAll(".adminbot-welcome__step-bullets li")].map(
      (li) => li.textContent,
    );
    expect(bullets).toEqual(["Update your headline", "Join the company page"]);

    const link = container.querySelector<HTMLAnchorElement>(".adminbot-welcome__step-link");
    expect(link?.textContent?.trim()).toBe("Connect with Zhijing");
    expect(link?.getAttribute("href")).toBe("https://linkedin.com/in/zhijing-jin/");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("dismiss button hides the welcome screen and remembers it was seen", () => {
    const container = document.createElement("div");
    const state = createState({
      completed: [],
      remaining: [],
      steps: [{ id: "x", label: "X", status: "current", category: "Questions", required: true }],
    });
    render(renderAdminBotWelcome(state), container);

    container.querySelector<HTMLButtonElement>(".adminbot-welcome__dismiss")?.click();
    expect(state.adminBotWelcomeVisible).toBe(false);
  });
});

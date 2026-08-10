/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import type { MemberOnboarding } from "../auth/session.ts";
import { hasUnacknowledgedOnboarding, renderOnboardingChecklist } from "./onboarding-checklist.ts";

function createState(
  onboarding: MemberOnboarding | null,
  overrides: Partial<AppViewState> = {},
): AppViewState {
  return {
    basePath: "",
    memberId: "pat",
    adminBotOnboarding: onboarding,
    adminBotOnboardingAcknowledged: false,
    adminBotOnboardingBusyStepId: null,
    adminBotOnboardingError: null,
    ...overrides,
  } as unknown as AppViewState;
}

describe("renderOnboardingChecklist", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("renders nothing when there is no onboarding checklist", () => {
    const container = document.createElement("div");
    render(renderOnboardingChecklist(createState(null)), container);
    expect(container.textContent?.trim()).toBe("");
  });

  it("renders nothing once the member has already acknowledged it", () => {
    const container = document.createElement("div");
    const onboarding: MemberOnboarding = {
      completed: [],
      remaining: [],
      steps: [{ id: "x", label: "X", status: "current", category: "Questions", required: true }],
    };
    render(
      renderOnboardingChecklist(createState(onboarding, { adminBotOnboardingAcknowledged: true })),
      container,
    );
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
    render(renderOnboardingChecklist(createState(onboarding)), container);

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
    render(renderOnboardingChecklist(createState(onboarding)), container);

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
          bullets: [
            { text: "Update your headline" },
            { text: "Join the company page", points: ["Search for Jinesis Lab", "Hit follow"] },
          ],
          links: [{ label: "Connect with Zhijing", url: "https://linkedin.com/in/example-pi/" }],
        },
      ],
    };
    render(renderOnboardingChecklist(createState(onboarding)), container);

    const bullets = [...container.querySelectorAll(".adminbot-welcome__step-bullets > li")].map(
      (li) => li.querySelector(".adminbot-welcome__bullet-text")?.textContent,
    );
    expect(bullets).toEqual(["Update your headline", "Join the company page"]);

    const points = [...container.querySelectorAll(".adminbot-welcome__step-points li")].map(
      (li) => li.textContent,
    );
    expect(points).toEqual(["Search for Jinesis Lab", "Hit follow"]);

    const link = container.querySelector<HTMLAnchorElement>(".adminbot-welcome__step-link");
    expect(link?.textContent?.trim()).toBe("Connect with Zhijing");
    expect(link?.getAttribute("href")).toBe("https://linkedin.com/in/example-pi/");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("the acknowledge button flips the flag and persists it, so the card would not render again", () => {
    const container = document.createElement("div");
    const state = createState({
      completed: [],
      remaining: [],
      steps: [{ id: "x", label: "X", status: "current", category: "Questions", required: true }],
    });
    render(renderOnboardingChecklist(state), container);

    expect(hasUnacknowledgedOnboarding(state)).toBe(true);
    container
      .querySelector<HTMLButtonElement>('[data-testid="dashboard-onboarding-acknowledge"]')
      ?.click();
    expect(state.adminBotOnboardingAcknowledged).toBe(true);
    expect(hasUnacknowledgedOnboarding(state)).toBe(false);
  });

  // Completion is self-attested through "Mark done"; acknowledging the card is a separate act
  // entirely, so leftover steps never block it.
  it("acknowledging works with steps still outstanding", () => {
    const container = document.createElement("div");
    const state = createState({
      completed: [],
      remaining: [],
      steps: [
        { id: "linkedin", label: "Connect on LinkedIn", status: "current", category: "Social media", required: true },
        { id: "twitter", label: "Follow X", status: "remaining", category: "Social media", required: false },
      ],
    });
    render(renderOnboardingChecklist(state), container);

    container
      .querySelector<HTMLButtonElement>('[data-testid="dashboard-onboarding-acknowledge"]')
      ?.click();
    expect(state.adminBotOnboardingAcknowledged).toBe(true);
  });
});

// The header counts what is finished; nothing here is gated on the per-step "Mark done" toggle.
describe("renderOnboardingChecklist progress", () => {
  const step = (overrides: Partial<MemberOnboarding["steps"][number]>) => ({
    id: "linkedin",
    label: "Connect on LinkedIn",
    status: "current" as const,
    category: "Social media",
    required: true,
    ...overrides,
  });

  function renderSteps(steps: MemberOnboarding["steps"]): HTMLElement {
    const container = document.createElement("div");
    render(
      renderOnboardingChecklist(createState({ completed: [], remaining: [], steps })),
      container,
    );
    return container;
  }

  it("counts the steps that are done", () => {
    const container = renderSteps([
      step({ id: "calendar_invite", status: "complete" }),
      step({ id: "linkedin", status: "complete" }),
      step({ id: "twitter", status: "current" }),
    ]);

    expect(container.querySelector(".adminbot-welcome__progress")?.textContent?.trim()).toBe(
      "2 of 3 done",
    );
  });

  it("celebrates once every step is done", () => {
    const container = renderSteps([step({ status: "complete" })]);

    const progress = container.querySelector(".adminbot-welcome__progress");
    expect(progress?.getAttribute("data-complete")).toBe("true");
    expect(progress?.textContent?.trim()).toBe("Every step is done — welcome aboard.");
  });
});

describe("onboarding step toggle", () => {
  const onboarding: MemberOnboarding = {
    current_step: undefined,
    completed: [],
    remaining: [],
    steps: [
      {
        id: "calendar_invite",
        label: "Lab calendar access",
        status: "complete",
        category: "Getting started",
        required: true,
      },
      {
        id: "linkedin",
        label: "Connect on LinkedIn",
        status: "current",
        category: "Social media",
        required: true,
      },
      {
        id: "twitter",
        label: "Follow the lab on X/Twitter",
        status: "complete",
        category: "Social media",
        required: false,
      },
    ],
  };

  it("offers Mark done on open steps, Undo on completed ones, and nothing on auto-granted ones", () => {
    const container = document.createElement("div");
    render(renderOnboardingChecklist(createState(onboarding)), container);

    const buttons = [...container.querySelectorAll(".adminbot-welcome__step-toggle")];
    // calendar_invite is granted by the server at approval time; a self-attestation
    // toggle there would only invite people to un-record something they never did.
    expect(buttons).toHaveLength(2);
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Mark done", "Undo"]);
  });

  it("disables the toggles and shows progress while a save is in flight", () => {
    const container = document.createElement("div");
    const state = createState(onboarding);
    (state as { adminBotOnboardingBusyStepId: string | null }).adminBotOnboardingBusyStepId =
      "linkedin";
    render(renderOnboardingChecklist(state), container);

    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>(".adminbot-welcome__step-toggle"),
    ];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons[0]?.textContent?.trim()).toBe("Saving…");
  });

  it("surfaces a save failure next to the acknowledge button", () => {
    const container = document.createElement("div");
    const state = createState(onboarding);
    (state as { adminBotOnboardingError: string | null }).adminBotOnboardingError =
      "Couldn't update this step — sign in again and retry.";
    render(renderOnboardingChecklist(state), container);

    expect(container.querySelector(".adminbot-welcome__error")?.textContent).toContain(
      "Couldn't update this step",
    );
  });
});

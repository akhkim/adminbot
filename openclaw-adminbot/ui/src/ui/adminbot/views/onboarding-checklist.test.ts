/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import type { MemberOnboarding, MemberOnboardingStep } from "../auth/session.ts";
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

function checklist(steps: MemberOnboardingStep[]): MemberOnboarding {
  return {
    completed: steps.filter((step) => step.status === "complete"),
    remaining: steps.filter((step) => step.status !== "complete"),
    steps,
  };
}

const CALENDAR: MemberOnboardingStep = {
  id: "calendar_invite",
  label: "Lab calendar access",
  status: "complete",
  category: "Getting started",
  required: true,
};

const PROFILE_PHOTO: MemberOnboardingStep = {
  id: "profile_photo",
  label: "Upload a professional profile photo",
  status: "current",
  category: "Getting started",
  required: true,
};

const LINKEDIN: MemberOnboardingStep = {
  id: "linkedin",
  label: "Connect on LinkedIn",
  status: "current",
  category: "Social media",
  required: true,
};

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
    render(
      renderOnboardingChecklist(
        createState(checklist([LINKEDIN]), { adminBotOnboardingAcknowledged: true }),
      ),
      container,
    );
    expect(container.textContent?.trim()).toBe("");
  });

  it("renders a single card at a time, opening on the first step that still needs the member", () => {
    const container = document.createElement("div");
    const onboarding = checklist([CALENDAR, PROFILE_PHOTO, LINKEDIN]);
    render(renderOnboardingChecklist(createState(onboarding)), container);

    // The auto-granted calendar step sits first in definition order but is already done, so the
    // walk opens on the next card -- the one the member actually has to act on.
    expect(container.querySelectorAll(".onboarding-step-card")).toHaveLength(1);
    expect(container.querySelector(".onboarding-step-card__label")?.textContent).toBe(
      "Upload a professional profile photo",
    );
    expect(container.querySelector(".onboarding-step-card__category")?.textContent).toBe(
      "Getting started",
    );
    expect(container.querySelector(".onboarding-step-card__count")?.textContent?.trim()).toBe(
      "2 / 3",
    );
    expect(container.querySelector(".onboarding-step-card__badge--status")?.textContent).toBe(
      "Start here",
    );
    // Not the very first step in definition order, so Back is already available (the member can
    // walk back to the done calendar card); the explicit-index test below pins the no-Back case.
    expect(container.querySelector(".onboarding-step-card__back")).not.toBeNull();
  });

  it("respects an explicit position, e.g. walking back to the auto-granted calendar step", () => {
    const container = document.createElement("div");
    const onboarding = checklist([CALENDAR, PROFILE_PHOTO]);
    render(
      renderOnboardingChecklist(createState(onboarding, { adminBotOnboardingStepIndex: 0 })),
      container,
    );

    expect(container.querySelector(".onboarding-step-card__label")?.textContent).toBe(
      "Lab calendar access",
    );
    expect(container.querySelector(".onboarding-step-card__count")?.textContent?.trim()).toBe(
      "1 / 2",
    );
    // Auto-granted steps carry no self-attestation toggle, so there is nothing to undo there.
    expect(container.querySelector(".onboarding-step-card__toggle")).toBeNull();
    // The very first card in definition order has no Back button.
    expect(container.querySelector(".onboarding-step-card__back")).toBeNull();
  });

  it("renders bullets as a list and links as clickable buttons", () => {
    const container = document.createElement("div");
    const linkedin = {
      ...LINKEDIN,
      bullets: [
        { text: "Update your headline" },
        { text: "Join the company page", points: ["Search for Jinesis Lab", "Hit follow"] },
      ],
      links: [{ label: "Connect with Zhijing", url: "https://linkedin.com/in/example-pi/" }],
    };
    render(renderOnboardingChecklist(createState(checklist([linkedin]))), container);

    const bullets = [...container.querySelectorAll(".onboarding-step-card__bullets > li")].map(
      (li) => li.querySelector(".onboarding-step-card__bullet-text")?.textContent,
    );
    expect(bullets).toEqual(["Update your headline", "Join the company page"]);

    const points = [...container.querySelectorAll(".onboarding-step-card__points li")].map(
      (li) => li.textContent,
    );
    expect(points).toEqual(["Search for Jinesis Lab", "Hit follow"]);

    const link = container.querySelector<HTMLAnchorElement>(".onboarding-step-card__link");
    expect(link?.textContent?.trim()).toBe("Connect with Zhijing");
    expect(link?.getAttribute("href")).toBe("https://linkedin.com/in/example-pi/");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("advances and retreats through the walk via Next and Back", () => {
    const container = document.createElement("div");
    const state = createState(
      checklist([
        { id: "twitter", label: "X", status: "current", category: "Social media", required: false },
        { id: "luma", label: "Luma", status: "remaining", category: "Social media", required: false },
        { id: "youtube", label: "YouTube", status: "remaining", category: "Social media", required: false },
      ]),
    );
    const rerender = () => {
      render(renderOnboardingChecklist(state), container);
    };
    rerender();

    expect(container.querySelector(".onboarding-step-card__label")?.textContent).toBe("X");

    container.querySelector<HTMLButtonElement>(".onboarding-step-card__next")?.click();
    rerender();
    expect(state.adminBotOnboardingStepIndex).toBe(1);
    expect(container.querySelector(".onboarding-step-card__label")?.textContent).toBe("Luma");
    expect(container.querySelector(".onboarding-step-card__back")).not.toBeNull();

    container.querySelector<HTMLButtonElement>(".onboarding-step-card__back")?.click();
    rerender();
    expect(state.adminBotOnboardingStepIndex).toBe(0);
    expect(container.querySelector(".onboarding-step-card__label")?.textContent).toBe("X");
  });

  it("the last step's Finish flips the flag and persists it, so the card would not render again", () => {
    const container = document.createElement("div");
    const state = createState(
      checklist([
        { id: "twitter", label: "X", status: "current", category: "Social media", required: false },
      ]),
    );
    render(renderOnboardingChecklist(state), container);

    expect(hasUnacknowledgedOnboarding(state)).toBe(true);
    const finish = container.querySelector<HTMLButtonElement>(".onboarding-step-card__next");
    expect(finish?.textContent?.trim()).toBe("Finish");
    finish?.click();
    expect(state.adminBotOnboardingAcknowledged).toBe(true);
    expect(hasUnacknowledgedOnboarding(state)).toBe(false);
  });

  it("a required incomplete step blocks Next until it is marked done", () => {
    const container = document.createElement("div");
    render(
      renderOnboardingChecklist(
        createState(
          checklist([
            PROFILE_PHOTO,
            { id: "twitter", label: "X", status: "remaining", category: "Social media", required: false },
          ]),
        ),
      ),
      container,
    );

    const next = container.querySelector<HTMLButtonElement>(".onboarding-step-card__next");
    expect(next?.disabled).toBe(true);
    expect(container.querySelector(".onboarding-step-card__blocked-note")?.textContent).toContain(
      "required",
    );
  });
});

describe("onboarding step toggle", () => {
  const onboarding = checklist([
    CALENDAR,
    {
      id: "linkedin",
      label: "Connect on LinkedIn",
      status: "current",
      category: "Social media",
      required: true,
    },
    { id: "twitter", label: "X", status: "complete", category: "Social media", required: false },
  ]);

  function toggleAt(overrides: Partial<AppViewState> = {}): { button: HTMLButtonElement | null } {
    const container = document.createElement("div");
    render(renderOnboardingChecklist(createState(onboarding, overrides)), container);
    return { button: container.querySelector<HTMLButtonElement>(".onboarding-step-card__toggle") };
  }

  it("offers Mark done on open steps, Undo on completed ones, and nothing on auto-granted ones", () => {
    // calendar_invite is granted by the server at approval time; a self-attestation
    // toggle there would only invite people to un-record something they never did.
    expect(toggleAt({ adminBotOnboardingStepIndex: 0 }).button).toBeNull();

    const open = toggleAt({ adminBotOnboardingStepIndex: 1 }).button;
    expect(open?.textContent?.trim()).toBe("Mark done");

    const done = toggleAt({ adminBotOnboardingStepIndex: 2 }).button;
    expect(done?.textContent?.trim()).toBe("Undo");
  });

  it("disables the toggle and shows progress while a save is in flight", () => {
    const { button } = toggleAt({
      adminBotOnboardingStepIndex: 1,
      adminBotOnboardingBusyStepId: "linkedin",
    });
    expect(button?.disabled).toBe(true);
    expect(button?.textContent?.trim()).toBe("Saving…");
  });

  it("surfaces a save failure on the card", () => {
    const container = document.createElement("div");
    const state = createState(onboarding, {
      adminBotOnboardingStepIndex: 1,
      adminBotOnboardingError: "Couldn't update this step — sign in again and retry.",
    });
    render(renderOnboardingChecklist(state), container);

    expect(container.querySelector(".onboarding-step-card__error")?.textContent).toContain(
      "Couldn't update this step",
    );
  });
});
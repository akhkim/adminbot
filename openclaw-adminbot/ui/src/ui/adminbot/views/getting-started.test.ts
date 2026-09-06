/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import type { MemberOnboarding, MemberOnboardingStep } from "../auth/session.ts";
import { outstandingOnboardingCount, renderGettingStarted } from "./getting-started.ts";

function createState(
  onboarding: MemberOnboarding | null,
  overrides: Partial<AppViewState> = {},
): AppViewState {
  return {
    basePath: "",
    memberId: "pat",
    adminBotOnboarding: onboarding,
    adminBotOnboardingBusyStepId: null,
    adminBotOnboardingError: null,
    adminBotData: { members: [{ id: "pat", name: "Pat", email: "pat@cs.toronto.edu" }] },
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
  status: "remaining",
  category: "Social media",
  required: false,
  detail: "Add the lab to your profile.",
  links: [{ label: "Open LinkedIn", url: "https://linkedin.com" }],
};

const draw = (state: AppViewState) => {
  const container = document.createElement("div");
  render(renderGettingStarted(state), container);
  return container;
};

describe("renderGettingStarted", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("says so plainly when the member has no checklist at all", () => {
    // Not an error state: a checklist is generated when a registration is approved, so a member
    // seeded onto the roster another way has none and never will.
    const container = draw(createState(null));
    expect(container.querySelector('[data-testid="getting-started-empty"]')).not.toBeNull();
  });

  it("shows every outstanding step at once, grouped by category", () => {
    const container = draw(createState(checklist([CALENDAR, PROFILE_PHOTO, LINKEDIN])));

    // The walk this replaces showed one card at a time, so ticking off the one thing you finished
    // this week meant pressing Next past everything you had not.
    expect(container.querySelector('[data-testid="step-profile_photo"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="step-linkedin"]')).not.toBeNull();
    const groups = [...container.querySelectorAll(".getting-started__group-title")].map((node) =>
      node.textContent?.trim(),
    );
    expect(groups).toEqual(["Getting started", "Social media"]);
  });

  it("counts progress across every step, and names how many are required", () => {
    const container = draw(createState(checklist([CALENDAR, PROFILE_PHOTO, LINKEDIN])));
    const progress = container.querySelector('[data-testid="getting-started-progress"]')!;

    expect(progress.textContent).toContain("1 of 3 done");
    // calendar_invite is auto-granted and LinkedIn is optional, so one required step is left.
    expect(progress.querySelector(".getting-started__required-left")?.textContent?.trim()).toBe(
      "1 required",
    );
  });

  it("folds finished steps away, keeping only the label and the way back out", () => {
    const container = draw(createState(checklist([CALENDAR, PROFILE_PHOTO])));
    const done = container.querySelector('[data-testid="getting-started-done"]')!;

    expect(done.querySelector("summary")?.textContent?.trim()).toBe("Already done (1)");
    const row = done.querySelector('[data-testid="done-calendar_invite"]')!;
    expect(row.textContent).toContain("Lab calendar access");
    // The detail and the links were instructions for doing it; re-reading them is not why anyone
    // opens this list.
    expect(row.querySelector(".onboarding-step-card__links")).toBeNull();
  });

  it("carries each step's own detail and links through from the checklist", () => {
    const container = draw(createState(checklist([LINKEDIN])));
    const card = container.querySelector('[data-testid="step-linkedin"]')!;

    expect(card.querySelector(".onboarding-step-card__detail")?.textContent?.trim()).toBe(
      "Add the lab to your profile.",
    );
    const link = card.querySelector<HTMLAnchorElement>(".onboarding-step-card__link");
    expect(link?.getAttribute("href")).toBe("https://linkedin.com");
    expect(link?.textContent?.trim()).toBe("Open LinkedIn");
  });

  it("says every step is done once nothing is outstanding", () => {
    const container = draw(createState(checklist([CALENDAR])));

    expect(container.querySelector('[data-testid="getting-started-remaining"]')).toBeNull();
    expect(container.textContent).toContain("Every step is done");
  });
});

describe("getting started step toggle", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  const onboarding = checklist([CALENDAR, PROFILE_PHOTO, LINKEDIN]);

  it("offers Mark done on open steps, Undo on completed ones, and nothing on auto-granted ones", () => {
    const container = draw(createState(onboarding));

    expect(
      container
        .querySelector('[data-testid="getting-started-toggle-profile_photo"]')
        ?.textContent?.trim(),
    ).toBe("Mark done");
    // calendar_invite is granted by the server at approval time; a self-attestation toggle there
    // would only invite people to un-record something they never did.
    expect(
      container.querySelector('[data-testid="getting-started-toggle-calendar_invite"]'),
    ).toBeNull();
  });

  it("keeps a way to undo a step that was marked done by mistake", () => {
    // Required only ever describes what the lab is waiting for -- never a one-way door on the
    // member's own answer.
    const container = draw(createState(checklist([{ ...PROFILE_PHOTO, status: "complete" }])));
    const undo = container.querySelector<HTMLButtonElement>(
      '[data-testid="getting-started-toggle-profile_photo"]',
    );
    expect(undo?.textContent?.trim()).toBe("Undo");
  });

  it("disables every toggle and shows progress while a save is in flight", () => {
    const container = draw(
      createState(onboarding, { adminBotOnboardingBusyStepId: "profile_photo" }),
    );
    const busy = container.querySelector<HTMLButtonElement>(
      '[data-testid="getting-started-toggle-profile_photo"]',
    );
    const other = container.querySelector<HTMLButtonElement>(
      '[data-testid="getting-started-toggle-linkedin"]',
    );

    expect(busy?.textContent?.trim()).toBe("Saving…");
    expect(busy?.disabled).toBe(true);
    // One save at a time: two in flight against the same record can land out of order.
    expect(other?.disabled).toBe(true);
  });

  it("surfaces a save failure on the page", () => {
    const container = draw(
      createState(onboarding, {
        adminBotOnboardingError: "Couldn't update this step — sign in again and retry.",
      }),
    );

    expect(container.querySelector(".onboarding-step-card__error")?.textContent).toContain(
      "Couldn't update this step",
    );
  });
});

describe("outstandingOnboardingCount", () => {
  it("counts what the member still owes, across both categories", () => {
    expect(
      outstandingOnboardingCount(createState(checklist([CALENDAR, PROFILE_PHOTO, LINKEDIN]))),
    ).toBe(2);
  });

  it("is zero without a checklist", () => {
    expect(outstandingOnboardingCount(createState(null))).toBe(0);
  });
});

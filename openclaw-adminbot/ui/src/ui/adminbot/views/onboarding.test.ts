/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import { renderAdminBotOnboarding } from "./onboarding.ts";

type OnboardingCall = { preview: boolean };

function renderView(overrides: Partial<AppViewState> = {}) {
  const calls: OnboardingCall[] = [];
  const state = {
    tab: "onboarding",
    onboardingTemplateId: "interview_invite",
    onboardingName: "Ada Lovelace",
    onboardingEmail: "ada@example.com",
    onboardingValues: {},
    sendOnboardingGuide: async (options: OnboardingCall) => {
      calls.push(options);
    },
    ...overrides,
  } as unknown as AppViewState;
  const container = document.createElement("div");
  document.body.append(container);
  const draw = () => render(renderAdminBotOnboarding(state), container);
  draw();
  return { state, container, draw, calls };
}

const PREVIEW = {
  template_id: "trial_phase",
  subject: "Next Steps: Trial Phase with the Jinesis Lab",
  body: "Hi Ada,\n\nGoogle Drive workspace: {drive_folder_link}.",
  sent: false,
};

describe("renderAdminBotOnboarding", () => {
  // Sending provisions a Drive folder and a Slack invite and mails a real person, so the operator
  // has to have read the words first. Send is not merely secondary here, it does not exist yet.
  it("offers no Send until a preview of this form state is on screen", () => {
    const { container, calls } = renderView();
    expect(container.querySelector('[data-testid="onboarding-send"]')).toBeNull();
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true }));
    expect(calls).toEqual([{ preview: true }]);
  });

  it("shows the previewed email as editable text and sends what is in the boxes", () => {
    const { container, state, calls } = renderView({
      onboardingTemplateId: "trial_phase",
      onboardingResult: PREVIEW,
      onboardingDraftSubject: PREVIEW.subject,
      onboardingDraftBody: PREVIEW.body,
    });
    const body = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="onboarding-draft-body"]',
    );
    expect(body?.value).toBe(PREVIEW.body);

    body!.value = "Hi Ada,\n\nEdited. Folder: {drive_folder_link}.";
    body!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.onboardingDraftBody).toBe("Hi Ada,\n\nEdited. Folder: {drive_folder_link}.");

    container.querySelector<HTMLElement>('[data-testid="onboarding-send"]')?.click();
    expect(calls).toEqual([{ preview: false }]);
  });

  // A preview of the previous recipient is worse than none: it reads as confirmation of something
  // that is no longer what Send would deliver.
  it("drops the preview and its edits when the form changes", () => {
    const { container, state, draw } = renderView({
      onboardingResult: PREVIEW,
      onboardingDraftBody: "edited",
    });
    const name = container.querySelector<HTMLInputElement>('input[name="name"]');
    name!.value = "Grace Hopper";
    name!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(state.onboardingResult).toBeNull();
    expect(state.onboardingDraftBody).toBe("");
    draw();
    expect(container.querySelector('[data-testid="onboarding-send"]')).toBeNull();
  });

  // A delivered email cannot be recalled, so it stops being a draft the moment it is sent.
  it("renders a sent email as a record rather than a draft", () => {
    const { container } = renderView({
      onboardingResult: { ...PREVIEW, sent: true },
    });
    expect(container.querySelector('[data-testid="onboarding-draft-body"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-send"]')).toBeNull();
    expect(container.textContent).toContain("Sent");
  });
});

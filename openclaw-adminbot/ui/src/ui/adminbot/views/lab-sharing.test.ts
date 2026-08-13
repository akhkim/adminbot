/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import { renderLabSharing } from "./lab-sharing.ts";

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    tab: "labSharing",
    ...overrides,
  } as unknown as AppViewState;
}

// The view's click handlers mutate module state and then call `state.requestUpdate()` to schedule a
// re-render. Wire that up to re-render into the same container so a test can click and read the
// result without re-rendering by hand.
function renderView(overrides: Partial<AppViewState> = {}) {
  const state = createState(overrides);
  const container = document.createElement("div");
  document.body.append(container);
  const draw = () => render(renderLabSharing(state), container);
  (state as AppViewState & { requestUpdate?: () => void }).requestUpdate = draw;
  draw();
  return { state, container, draw };
}

function click(container: HTMLElement, selector: string): void {
  container.querySelector<HTMLElement>(selector)?.click();
}

function text(container: HTMLElement, testId: string): string {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.textContent ?? "";
}

function input(container: HTMLElement, selector: string, value: string): void {
  const node = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!node) {
    throw new Error(`no input for ${selector}`);
  }
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("renderLabSharing", () => {
  it("renders every panel on the page", () => {
    const { container } = renderView();
    for (const testId of [
      "lab-sharing-director",
      "lab-sharing-invites",
      "lab-sharing-requests",
      "lab-sharing-seek-help",
      "lab-sharing-open-projects",
      "lab-sharing-announcements",
    ]) {
      expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
    }
  });

  it("shows the director's name and availability", () => {
    const { container } = renderView();
    expect(text(container, "lab-sharing-director")).toContain("Zhijing Jin");
    expect(text(container, "lab-sharing-director")).toContain("Available");
  });

  it("lists the invite sent to the member and opens its details dialog", () => {
    const { container } = renderView();
    expect(container.querySelector('[data-testid="lab-sharing-invite-inv1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lab-sharing-invite-dialog"]')).toBeNull();

    click(container, `[data-testid="lab-sharing-invite-inv1"] .lab-sharing-invite__view`);
    const dialog = container.querySelector('[data-testid="lab-sharing-invite-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Ada Lovelace");
    expect(dialog?.textContent).toContain("AdminBot");
  });

  it("responds to an invite and removes it from the list", () => {
    const { container } = renderView();
    click(container, `[data-testid="lab-sharing-invite-inv1"] .lab-sharing-invite__view`);
    click(container, `[data-testid="lab-sharing-invite-respond"]`);
    // The responded invite no longer renders; the dialog is gone.
    expect(container.querySelector('[data-testid="lab-sharing-invite-inv1"]')).toBeNull();
    expect(container.querySelector('[data-testid="lab-sharing-invite-dialog"]')).toBeNull();
  });

  it("seeks members only once the search query is non-empty", () => {
    const { state, container } = renderView({ labSharingSearchQuery: "" });
    expect(container.querySelector(".lab-sharing-seek__hint")).not.toBeNull();
    expect(container.querySelector(".lab-sharing-member")).toBeNull();

    state.labSharingSearchQuery = "ada";
    (state as AppViewState & { requestUpdate?: () => void }).requestUpdate?.();
    expect(container.querySelector(".lab-sharing-member")).not.toBeNull();
    expect(text(container, "lab-sharing-member-m1")).toContain("Ada Lovelace");
  });

  it("opens the member ask dialog with the form's project and comment", () => {
    const { container } = renderView({
      labSharingSearchQuery: "ada",
      labSharingAskComment: "Need help with traces.",
    });
    click(container, `[data-testid="lab-sharing-member-m1"] .lab-sharing-member__invite`);

    const dialog = container.querySelector('[data-testid="lab-sharing-ask-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("AdminBot");
    expect(dialog?.textContent).toContain("Need help with traces.");
    expect(dialog?.querySelector("#lab-sharing-ask-special-message")).not.toBeNull();
  });

  it("confirms a general call against the form contents before posting", () => {
    const { container } = renderView({
      labSharingAskComment: "Looking for reviewers.",
      labSharingAskMembers: 2,
      labSharingAskHours: 3,
      labSharingAskTags: ["QA", "causality"],
    });
    click(container, `[data-testid="lab-sharing-general-call"]`);

    const dialog = container.querySelector('[data-testid="lab-sharing-general-call-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("AdminBot");
    expect(dialog?.textContent).toContain("Looking for reviewers.");
    expect(dialog?.textContent).toContain("2");
    expect(dialog?.textContent).toContain("3");
    expect(dialog?.textContent).toContain("QA");
  });

  it("posts a general call into Your requests", () => {
    const { container } = renderView({
      labSharingAskProjectId: "proj-adminbot",
      labSharingAskComment: "Fresh request.",
    });
    click(container, `[data-testid="lab-sharing-general-call"]`);
    click(container, `[data-testid="lab-sharing-general-call-send"]`);

    expect(container.querySelector('[data-testid="lab-sharing-general-call-dialog"]')).toBeNull();
    const requestCards = [...container.querySelectorAll(".lab-sharing-request")];
    expect(requestCards.length).toBeGreaterThan(0);
    const posted = requestCards.find((card) => card.textContent?.includes("Fresh request."));
    expect(posted).not.toBeUndefined();
    expect(posted?.textContent).toContain("AdminBot");
  });

  it("deletes a request only after confirming, and cancels instead", () => {
    const { container } = renderView();
    const cardsBefore = [...container.querySelectorAll(".lab-sharing-request")].length;
    expect(cardsBefore).toBeGreaterThan(0);

    const firstId = container.querySelector<HTMLElement>(".lab-sharing-request")?.dataset
      .testid;
    const requestRow = `[data-testid="${firstId}"]`;
    click(container, `${requestRow} .lab-sharing-request__delete`);
    expect(container.querySelector(".lab-sharing-request__delete--confirm")).not.toBeNull();
    expect(container.querySelector(".lab-sharing-request__cancel")).not.toBeNull();

    click(container, `${requestRow} .lab-sharing-request__cancel`);
    expect(container.querySelector(".lab-sharing-request__delete--confirm")).toBeNull();
    expect([...container.querySelectorAll(".lab-sharing-request")].length).toBe(cardsBefore);

    click(container, `${requestRow} .lab-sharing-request__delete`);
    click(container, `${requestRow} .lab-sharing-request__delete--confirm`);
    expect([...container.querySelectorAll(".lab-sharing-request")].length).toBe(cardsBefore - 1);
  });

  it("navigates the open-projects deck with the prev/next arrows", () => {
    const { container } = renderView();
    const firstTitle = container.querySelector(".lab-sharing-project__title")?.textContent ?? "";
    expect(text(container, "lab-sharing-open-projects")).toContain("1 / 2");

    click(container, ".lab-sharing-projects__nav--next");
    const secondTitle = container.querySelector(".lab-sharing-project__title")?.textContent ?? "";
    expect(secondTitle).not.toBe(firstTitle);
    expect(text(container, "lab-sharing-open-projects")).toContain("2 / 2");

    click(container, ".lab-sharing-projects__nav--prev");
    expect(container.querySelector(".lab-sharing-project__title")?.textContent).toBe(firstTitle);
    expect(text(container, "lab-sharing-open-projects")).toContain("1 / 2");
  });

  it("composes and posts an announcement", () => {
    const { container } = renderView();
    click(container, `[data-testid="lab-sharing-announcement-add"]`);
    expect(
      container.querySelector('[data-testid="lab-sharing-announcement-compose"]'),
    ).not.toBeNull();

    input(container, '[data-testid="lab-sharing-announcement-compose"] textarea', "Heads up.");
    click(container, `[data-testid="lab-sharing-announcement-send"]`);
    expect(
      container.querySelector('[data-testid="lab-sharing-announcement-compose"]'),
    ).toBeNull();
    const feed = container.querySelector('[data-testid="lab-sharing-announcements"]');
    expect(feed?.textContent).toContain("Heads up.");
  });
});


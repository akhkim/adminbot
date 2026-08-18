/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocationDrift } from "../auth/session.ts";
import { renderLocationPrompt, type LocationPromptProps } from "./location-prompt.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const DRIFT: LocationDrift = {
  member_id: "m-ada",
  observed_country: "Germany",
  observed_label: "Germany",
  profile_location: "Toronto",
  profile_country: "Canada",
  since: "2026-08-10T09:00:00.000Z",
  observation_count: 4,
};

function renderView(overrides: Partial<LocationPromptProps> = {}): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderLocationPrompt({
      drift: DRIFT,
      saving: false,
      error: null,
      onConfirm: vi.fn(),
      onDismiss: vi.fn(),
      ...overrides,
    }),
    container,
  );
  return container;
}

describe("renderLocationPrompt", () => {
  it("renders nothing when there is nothing to ask", () => {
    expect(renderView({ drift: null }).textContent?.trim()).toBe("");
  });

  // It quotes the evidence rather than asserting the conclusion: the member is the one who knows.
  it("shows the evidence and what the profile currently says", () => {
    const text = renderView().textContent ?? "";
    expect(text).toContain("4 sign-ins");
    expect(text).toContain("Germany");
    expect(text).toContain("Toronto");
    // A member should know their sign-in country is observed at all.
    expect(text).toContain("never written to your profile");
  });

  // The point of the whole feature: a confirmed move has to carry the timezone, or the roster says
  // Berlin and the scheduler still says Toronto.
  it("derives the timezone from the confirmed location", () => {
    const onConfirm = vi.fn();
    const view = renderView({ onConfirm });
    view.querySelector<HTMLInputElement>("[name=current_city]")!.value = "Berlin";
    view.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onConfirm).toHaveBeenCalledWith({
      current_city: "Berlin",
      timezone: "Europe/Berlin",
    });
  });

  it("still confirms a place no timezone could be guessed for", () => {
    const onConfirm = vi.fn();
    const view = renderView({ onConfirm });
    view.querySelector<HTMLInputElement>("[name=current_city]")!.value = "a boat";
    view.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onConfirm).toHaveBeenCalledWith({ current_city: "a boat" });
  });

  // "No" has to be exactly as easy as "yes", or the banner collects agreement rather than fact.
  it("offers a one-click dismissal that sends no location", () => {
    const onDismiss = vi.fn();
    const view = renderView({ onDismiss });
    const buttons = [...view.querySelectorAll("button")];
    const no = buttons.find((button) => button.textContent?.includes("still in"));
    expect(no?.textContent).toContain("Toronto");
    no?.click();
    expect(onDismiss).toHaveBeenCalledWith();
  });

  it("does not submit an emptied field", () => {
    const onConfirm = vi.fn();
    const view = renderView({ onConfirm });
    view.querySelector<HTMLInputElement>("[name=current_city]")!.value = "  ";
    view.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("locks both answers while one is in flight", () => {
    const view = renderView({ saving: true });
    expect([...view.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });

  it("shows a save failure in place", () => {
    expect(renderView({ error: "Could not save that." }).textContent).toContain(
      "Could not save that.",
    );
  });
});

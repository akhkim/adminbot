/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWhereYouAre, type WhereYouAreProps } from "./time-availability.where-you-are.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

function renderView(overrides: Partial<WhereYouAreProps> = {}): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderWhereYouAre({
      member: { name: "Ada", location: "Toronto" },
      editable: true,
      saving: false,
      error: null,
      onSave: vi.fn(),
      ...overrides,
    }),
    container,
  );
  return container;
}

function typeInto(view: HTMLElement, name: string, value: string): void {
  const field = view.querySelector<HTMLInputElement>(`[name=${name}]`)!;
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("renderWhereYouAre", () => {
  it("renders nothing without a member", () => {
    expect(renderView({ member: undefined }).textContent?.trim()).toBe("");
  });

  // The card is about the next few weeks; the profile field is about where someone lives. Saying so
  // is what stops a member "correcting" their home address for a two-month trip.
  it("distinguishes itself from the home address on the profile", () => {
    const text = renderView().textContent ?? "";
    expect(text).toContain("separate from the home address");
    expect(text).toContain("Toronto");
  });

  it("guesses the timezone from the city as it is typed", () => {
    const view = renderView();
    typeInto(view, "current_city", "Berlin");
    expect(view.querySelector<HTMLInputElement>("[name=timezone]")?.value).toBe("Europe/Berlin");
  });

  // The guess is a starting point, not a correction: a member who picked a zone means it.
  it("never overwrites a timezone the member typed themselves", () => {
    const view = renderView();
    typeInto(view, "timezone", "Asia/Tokyo");
    typeInto(view, "current_city", "Berlin");
    expect(view.querySelector<HTMLInputElement>("[name=timezone]")?.value).toBe("Asia/Tokyo");
  });

  it("saves the city with its timezone", () => {
    const onSave = vi.fn();
    const view = renderView({ onSave });
    typeInto(view, "current_city", "Berlin");
    view.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onSave).toHaveBeenCalledWith({ current_city: "Berlin", timezone: "Europe/Berlin" });
  });

  it("saves a place no timezone could be guessed for", () => {
    const onSave = vi.fn();
    const view = renderView({ onSave, member: { location: "Toronto" } });
    typeInto(view, "current_city", "a boat");
    view.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onSave).toHaveBeenCalledWith({ current_city: "a boat" });
  });

  it("does not save an empty city", () => {
    const onSave = vi.fn();
    const view = renderView({ onSave });
    typeInto(view, "current_city", "   ");
    view.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onSave).not.toHaveBeenCalled();
  });

  // An admin reading someone else's schedule sees where they are and cannot edit it: the service
  // routes a member write to their own record, so an editable form here would only produce a 403.
  it("is read-only for anyone but the member themselves", () => {
    const view = renderView({
      editable: false,
      member: { current_city: "Berlin", timezone: "Europe/Berlin" },
    });
    expect(view.querySelector("form")).toBeNull();
    expect(view.textContent).toContain("Berlin");
    expect(view.textContent).toContain("Europe/Berlin");
  });

  it("says which field scheduling is actually reading", () => {
    const text = renderView({ member: { location: "Toronto" } }).textContent ?? "";
    expect(text).toContain("America/Toronto");
    expect(text).toContain("home location");
  });

  it("locks the form and shows a failure while saving", () => {
    const view = renderView({ saving: true, error: "Could not save that." });
    expect(view.querySelector<HTMLInputElement>("[name=current_city]")?.disabled).toBe(true);
    expect(view.textContent).toContain("Could not save that.");
  });
});

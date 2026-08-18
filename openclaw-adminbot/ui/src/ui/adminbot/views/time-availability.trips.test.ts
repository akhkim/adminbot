/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TripRow } from "../data/availability.ts";
import {
  EMPTY_TRIP_DRAFT,
  renderTrips,
  tripDraftError,
  type TripDraft,
  type TripsProps,
} from "./time-availability.trips.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const BERLIN: TripRow = {
  start: "2026-09-01",
  end: "2026-09-30",
  city: "Berlin",
  timezone: "Europe/Berlin",
  note: "Internship",
};

function renderView(overrides: Partial<TripsProps> = {}): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderTrips({
      trips: [BERLIN],
      homeLocation: "Toronto",
      draft: EMPTY_TRIP_DRAFT,
      onDraftChange: vi.fn(),
      editable: true,
      saving: false,
      onSave: vi.fn(),
      today: "2026-09-15",
      ...overrides,
    }),
    container,
  );
  return container;
}

function draft(overrides: Partial<TripDraft> = {}): TripDraft {
  return { ...EMPTY_TRIP_DRAFT, city: "Berlin", start: "2026-09-01", end: "2026-09-30", ...overrides };
}

describe("renderTrips", () => {
  it("renders as one of the tab's editor sections, like the three above it", () => {
    const view = renderView();
    expect(view.querySelector(".adminbot-time-availability__editor")).not.toBeNull();
    expect(view.querySelector(".adminbot-time-availability__form")).not.toBeNull();
    expect(view.querySelector("button.primary")?.textContent).toContain("Add trip");
    expect(view.querySelector(".card-title")?.textContent).toContain("Add a trip away from home");
  });

  it("lists a trip with its dates and zone, and says which one is running", () => {
    const text = renderView().textContent ?? "";
    expect(text).toContain("Berlin");
    expect(text).toContain("Europe/Berlin");
    expect(text).toContain("Internship");
    expect(text).toContain("Currently in Berlin");
    expect(renderView().querySelector(".adminbot-trips__row--active")).not.toBeNull();
  });

  it("marks nothing as current outside every trip", () => {
    const view = renderView({ today: "2026-10-15" });
    expect(view.textContent).not.toContain("Currently in");
    expect(view.querySelector(".adminbot-trips__row--active")).toBeNull();
  });

  it("names home, so a reader knows what away is away from", () => {
    expect(renderView().textContent).toContain("Home is Toronto");
  });

  it("says so when there is nothing logged", () => {
    expect(renderView({ trips: [] }).textContent).toContain("No trips logged");
  });

  it("adds a trip, sorted into the existing list by start date", () => {
    const onSave = vi.fn();
    const view = renderView({
      onSave,
      draft: draft({ city: "Vancouver", start: "2026-08-01", end: "2026-08-05" }),
    });
    view.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onSave).toHaveBeenCalledWith([
      // The new August trip sorts before the September one it was entered after.
      { start: "2026-08-01", end: "2026-08-05", city: "Vancouver", timezone: "America/Vancouver" },
      BERLIN,
    ]);
  });

  it("guesses the timezone from the city as it is typed", () => {
    const onDraftChange = vi.fn();
    const view = renderView({ onDraftChange });
    const city = view.querySelector<HTMLInputElement>('[data-testid="time-availability-trip-city"]')!;
    city.value = "Berlin";
    city.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ city: "Berlin", timezone: "Europe/Berlin" }),
    );
  });

  it("never overwrites a timezone the member typed", () => {
    const onDraftChange = vi.fn();
    const view = renderView({ onDraftChange, draft: draft({ timezone: "Asia/Tokyo", city: "" }) });
    const city = view.querySelector<HTMLInputElement>('[data-testid="time-availability-trip-city"]')!;
    city.value = "Berlin";
    city.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ city: "Berlin", timezone: "Asia/Tokyo" }),
    );
  });

  it("removes the row that was clicked, leaving the others", () => {
    const onSave = vi.fn();
    const second: TripRow = { start: "2026-11-01", end: "2026-11-05", city: "Vancouver" };
    const view = renderView({ trips: [BERLIN, second], onSave });
    view.querySelector<HTMLButtonElement>('[data-testid="time-availability-trip-remove-1"]')?.click();
    expect(onSave).toHaveBeenCalledWith([BERLIN]);
  });

  // An admin reading somebody else's schedule sees where they will be and cannot edit it: the
  // service routes a member write to their own record.
  it("is read-only for anyone but the member themselves", () => {
    const view = renderView({ editable: false });
    expect(view.querySelector("form")).toBeNull();
    expect(view.querySelector('[data-testid="time-availability-trip-remove-0"]')).toBeNull();
    expect(view.textContent).toContain("Berlin");
  });

  it("will not submit an incomplete draft", () => {
    const onSave = vi.fn();
    const view = renderView({ onSave, draft: draft({ end: "" }) });
    view.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(onSave).not.toHaveBeenCalled();
    expect(view.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
  });
});

describe("tripDraftError", () => {
  it("names the missing piece", () => {
    expect(tripDraftError(EMPTY_TRIP_DRAFT)).toMatch(/Where/u);
    expect(tripDraftError(draft({ start: "" }))).toMatch(/start and an end/u);
    expect(tripDraftError(draft({ start: "2026-09-30", end: "2026-09-01" }))).toMatch(/before/u);
    expect(tripDraftError(draft())).toBeNull();
  });
});

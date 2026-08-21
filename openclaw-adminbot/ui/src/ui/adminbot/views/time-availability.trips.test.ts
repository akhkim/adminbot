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
  return {
    ...EMPTY_TRIP_DRAFT,
    city: "Berlin",
    start: "2026-09-01",
    end: "2026-09-30",
    ...overrides,
  };
}

describe("editing a logged trip", () => {
  const TOKYO: TripRow = { start: "2026-11-01", end: "2026-11-10", city: "Tokyo" };

  it("loads the row it was pressed on into the form", () => {
    const onDraftChange = vi.fn();
    const container = renderView({ trips: [BERLIN, TOKYO], onDraftChange });

    container
      .querySelector<HTMLButtonElement>('[data-testid="time-availability-trip-edit-1"]')
      ?.click();

    expect(onDraftChange).toHaveBeenCalledWith({
      city: "Tokyo",
      start: "2026-11-01",
      end: "2026-11-10",
      timezone: "",
      note: "",
      editingIndex: 1,
    });
  });

  it("replaces that row on save instead of adding another", () => {
    const onSave = vi.fn();
    const container = renderView({
      trips: [BERLIN, TOKYO],
      draft: draft({ city: "Kyoto", start: "2026-11-02", end: "2026-11-12", editingIndex: 1 }),
      onSave,
    });

    container
      .querySelector<HTMLFormElement>('[data-testid="time-availability-trip-form"]')
      ?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    const saved = onSave.mock.calls[0]?.[0] as TripRow[];
    expect(saved).toHaveLength(2);
    expect(saved.map((row) => row.city)).toEqual(["Berlin", "Kyoto"]);
  });

  // An edit that moves a trip's dates has to re-sort for the same reason adding one does: the list
  // is read as a timeline.
  it("re-sorts when an edit moves the trip earlier", () => {
    const onSave = vi.fn();
    const container = renderView({
      trips: [BERLIN, TOKYO],
      draft: draft({ city: "Tokyo", start: "2026-08-01", end: "2026-08-10", editingIndex: 1 }),
      onSave,
    });

    container
      .querySelector<HTMLFormElement>('[data-testid="time-availability-trip-form"]')
      ?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    const saved = onSave.mock.calls[0]?.[0] as TripRow[];
    expect(saved.map((row) => row.city)).toEqual(["Tokyo", "Berlin"]);
  });

  it("offers a cancel that clears the draft, and only while editing", () => {
    const onDraftChange = vi.fn();
    const idle = renderView({ draft: EMPTY_TRIP_DRAFT });
    expect(idle.querySelector('[data-testid="time-availability-trip-cancel"]')).toBeNull();

    const editing = renderView({ draft: draft({ editingIndex: 0 }), onDraftChange });
    editing
      .querySelector<HTMLButtonElement>('[data-testid="time-availability-trip-cancel"]')
      ?.click();
    expect(onDraftChange).toHaveBeenCalledWith(EMPTY_TRIP_DRAFT);
  });

  // Removing the row under edit would otherwise leave the form pointed at an index that now holds
  // a different trip, so a later save would overwrite the wrong one.
  it("abandons the edit when the row being edited is removed", () => {
    const onDraftChange = vi.fn();
    const onSave = vi.fn();
    const container = renderView({
      trips: [BERLIN, TOKYO],
      draft: draft({ editingIndex: 1 }),
      onDraftChange,
      onSave,
    });

    container
      .querySelector<HTMLButtonElement>('[data-testid="time-availability-trip-remove-1"]')
      ?.click();

    expect(onSave).toHaveBeenCalledWith([BERLIN]);
    expect(onDraftChange).toHaveBeenCalledWith(EMPTY_TRIP_DRAFT);
  });

  it("leaves the edit alone when a different row is removed", () => {
    const onDraftChange = vi.fn();
    const container = renderView({
      trips: [BERLIN, TOKYO],
      draft: draft({ editingIndex: 1 }),
      onDraftChange,
    });

    container
      .querySelector<HTMLButtonElement>('[data-testid="time-availability-trip-remove-0"]')
      ?.click();

    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("marks the row that is being edited", () => {
    const container = renderView({ trips: [BERLIN, TOKYO], draft: draft({ editingIndex: 1 }) });
    const rows = [...container.querySelectorAll(".adminbot-trips__row")];
    expect(rows[0]?.className).not.toContain("adminbot-trips__row--editing");
    expect(rows[1]?.className).toContain("adminbot-trips__row--editing");
  });
});

describe("renderTrips", () => {
  it("renders as one of the tab's editor sections, like the three above it", () => {
    const view = renderView();
    expect(view.querySelector(".adminbot-time-availability__editor")).not.toBeNull();
    expect(view.querySelector(".adminbot-time-availability__form")).not.toBeNull();
    expect(view.querySelector("button.primary")?.textContent).toContain("Add trip");
    expect(view.querySelector(".card-title")?.textContent).toContain("Add a trip away from home");
  });

  it("lists a trip with its dates and zone, and marks the one running", () => {
    const text = renderView().textContent ?? "";
    expect(text).toContain("Berlin");
    expect(text).toContain("Europe/Berlin");
    expect(text).toContain("Internship");
    expect(renderView().querySelector(".adminbot-trips__row--active")).not.toBeNull();
  });

  it("marks nothing as running outside every trip", () => {
    expect(
      renderView({ today: "2026-10-15" }).querySelector(".adminbot-trips__row--active"),
    ).toBeNull();
  });

  // The running trip is stated on the chart above, beside the capacity pill. Repeating it here
  // would be the same fact twice on one screen.
  it("does not restate where the member currently is", () => {
    expect(renderView().textContent).not.toContain("Currently in");
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
    const city = view.querySelector<HTMLInputElement>(
      '[data-testid="time-availability-trip-city"]',
    )!;
    city.value = "Berlin";
    city.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ city: "Berlin", timezone: "Europe/Berlin" }),
    );
  });

  it("never overwrites a timezone the member typed", () => {
    const onDraftChange = vi.fn();
    const view = renderView({ onDraftChange, draft: draft({ timezone: "Asia/Tokyo", city: "" }) });
    const city = view.querySelector<HTMLInputElement>(
      '[data-testid="time-availability-trip-city"]',
    )!;
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
    view
      .querySelector<HTMLButtonElement>('[data-testid="time-availability-trip-remove-1"]')
      ?.click();
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

// The member-type filter, shared by Active Papers and Profile Completeness.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  ADMINBOT_MEMBER_TYPE_FILTERS,
  matchesMemberTypeFilter,
  renderMemberTypeFilter,
} from "./member-type-filter.ts";

function draw(selected: readonly string[], onChange = () => {}) {
  const container = document.createElement("div");
  render(
    renderMemberTypeFilter({
      selected,
      onChange,
      testIdPrefix: "test",
      label: "Member type",
    }),
    container,
  );
  return container;
}

// The group carried two class names with no rules behind them anywhere in the stylesheet, so it
// drew as a raw fieldset next to toolbars built from the app's chips.
describe("the filter's shape", () => {
  it("is a row of the app's own chips", () => {
    const container = draw([]);
    const group = container.querySelector('[data-testid="test-type-filter"]');
    expect(group?.classList.contains("chip-row")).toBe(true);
    const options = container.querySelectorAll(".profile-overview__type-option");
    expect(options).toHaveLength(ADMINBOT_MEMBER_TYPE_FILTERS.length);
    for (const option of options) {
      expect(option.classList.contains("chip")).toBe(true);
      // The checkbox stays: it is what makes the state readable without relying on colour.
      expect(option.querySelector('input[type="checkbox"]')).not.toBeNull();
    }
  });

  it("ticks the boxes that are selected", () => {
    const container = draw(["alumni"]);
    const alumni = container.querySelector<HTMLInputElement>('[data-testid="test-type-alumni"]');
    const full = container.querySelector<HTMLInputElement>('[data-testid="test-type-full"]');
    expect(alumni?.checked).toBe(true);
    expect(full?.checked).toBe(false);
  });

  it("offers Clear only once something is filtered", () => {
    expect(draw([]).querySelector('[data-testid="test-type-clear"]')).toBeNull();
    expect(draw(["full"]).querySelector('[data-testid="test-type-clear"]')).not.toBeNull();
  });

  it("adds to the selection rather than replacing it", () => {
    const onChange = vi.fn();
    const container = draw(["full"], onChange);
    const alumni = container.querySelector<HTMLInputElement>('[data-testid="test-type-alumni"]');
    alumni!.checked = true;
    alumni!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith(["full", "alumni"]);
  });
});

// An empty filter means "everything", not "nothing" -- the one rule a filter must never invert.
describe("matchesMemberTypeFilter", () => {
  it("keeps every row when nothing is picked", () => {
    expect(matchesMemberTypeFilter("alumni", [])).toBe(true);
    expect(matchesMemberTypeFilter(undefined, [])).toBe(true);
  });

  it("matches any one of a member's several types", () => {
    expect(matchesMemberTypeFilter("alumni, coauthor-major", ["coauthor-major"])).toBe(true);
    expect(matchesMemberTypeFilter("alumni, coauthor-major", ["full"])).toBe(false);
  });
});

import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { canAccessTab } from "../access.ts";
import { renderArrReviewers } from "./arr-reviewers.ts";

afterEach(() => document.body.replaceChildren());

function mount(overrides: Partial<Parameters<typeof renderArrReviewers>[0]> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  render(
    renderArrReviewers({
      members: [],
      loading: false,
      error: null,
      onRefresh: vi.fn(),
      ...overrides,
    }),
    host,
  );
  return host;
}

it("lists only confirmed reviewers, sorted by name, preserving zero and missing capacities", () => {
  const host = mount({
    members: [
      { id: "b", name: "Beta Reviewer", arr_reviewer_qualified: true, arr_review_capacity: 0 },
      { id: "a", name: "Alpha Reviewer", arr_reviewer_qualified: true, arr_review_capacity: 3 },
      { id: "c", name: "Charlie Reviewer", arr_reviewer_qualified: true },
      { id: "d", name: "Declined", arr_reviewer_qualified: false, arr_review_capacity: 5 },
      { id: "e", name: "Unanswered", arr_reviewer_qualified: null },
      { id: "f", name: "Unset" },
    ],
  });
  expect(
    [...host.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    ),
  ).toEqual([
    ["Alpha Reviewer", "3"],
    ["Beta Reviewer", "0"],
    ["Charlie Reviewer", "Not provided"],
  ]);
  expect(host.textContent).toContain("3 eligible reviewers");
});

it("shows empty, loading and error states and supports refresh", () => {
  expect(mount().textContent).toContain("No users have confirmed");
  const loading = mount({ loading: true });
  expect(loading.querySelector("button")!.disabled).toBe(true);
  expect(loading.textContent).toContain("Loading reviewers");
  expect(mount({ error: "Roster unavailable" }).querySelector('[role="alert"]')!.textContent).toBe(
    "Roster unavailable",
  );
  const onRefresh = vi.fn();
  mount({ onRefresh }).querySelector("button")!.click();
  expect(onRefresh).toHaveBeenCalledOnce();
});

it("makes the tab available to members and admins but not anonymous visitors", () => {
  expect(canAccessTab("adminbotArrReviewers", "member")).toBe(true);
  expect(canAccessTab("adminbotArrReviewers", "admin")).toBe(true);
  expect(canAccessTab("adminbotArrReviewers", "anonymous")).toBe(false);
});

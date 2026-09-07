// The multi-answer control shared by the roster editor and the member's profile page.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import {
  multiSelectOptionsFor,
  renderMultiSelectField,
  syncMultiSelectSummary,
} from "./multi-select-field.ts";

const ROLES = ["Undergraduate Student", "PhD Student", "Lab Manager"];

function draw(held: readonly string[]) {
  const container = document.createElement("div");
  render(
    renderMultiSelectField({
      name: "role",
      label: "Role",
      placeholder: "Not set",
      options: multiSelectOptionsFor(ROLES, held),
      selected: new Set(held.map((entry) => entry.toLowerCase())),
      rootClass: "profile__multi",
      optionClass: "profile__multi-option",
      legacyOptionClass: "profile__multi-option--legacy",
      testId: "profile-multi-role",
    }),
    container,
  );
  return container;
}

function summaryText(container: HTMLElement): string {
  return container.querySelector("[data-multi-select-value]")?.textContent?.trim() ?? "";
}

describe("the closed control", () => {
  it("starts closed, so the options are not a column standing open on the page", () => {
    const details = draw(["PhD Student"]).querySelector("details");
    expect(details?.open).toBe(false);
  });

  it("names the roles held rather than counting them", () => {
    expect(summaryText(draw(["PhD Student", "Lab Manager"]))).toBe("PhD Student, Lab Manager");
  });

  it("falls back to the placeholder when the record holds no role", () => {
    expect(summaryText(draw([]))).toBe("Not set");
  });

  // The menu's order, not the record's: a record listing "Lab Manager, PhD Student" and one
  // listing them the other way round are the same answer and must not read differently.
  it("lists the roles in the order the menu offers them", () => {
    expect(summaryText(draw(["Lab Manager", "PhD Student"]))).toBe("PhD Student, Lab Manager");
  });
});

describe("the options", () => {
  it("checks exactly the roles the record holds, case-insensitively", () => {
    const boxes = [...draw(["phd student"]).querySelectorAll<HTMLInputElement>("input")];
    expect(boxes.filter((box) => box.checked).map((box) => box.value)).toEqual(["PhD Student"]);
  });

  it("keeps an imported answer the vocabulary has no box for, and marks it", () => {
    const legacy = draw(["PhD Mentee / MSc"]).querySelector<HTMLInputElement>(
      ".profile__multi-option--legacy input",
    );
    expect(legacy?.value).toBe("PhD Mentee / MSc");
    expect(legacy?.checked).toBe(true);
  });

  // Every box shares the field key, which is what lets the forms read the answers back with
  // FormData.getAll -- the same wire shape the bare checkboxes had.
  it("names every box for the field", () => {
    const boxes = [...draw([]).querySelectorAll<HTMLInputElement>("input")];
    expect(boxes.every((box) => box.name === "role")).toBe(true);
  });
});

describe("the summary while the menu is open", () => {
  it("follows the boxes, since the forms around it do not redraw on every tick", () => {
    const container = draw(["PhD Student"]);
    const details = container.querySelector("details");
    const box = container.querySelector<HTMLInputElement>('input[value="Lab Manager"]');
    if (!details || !box) {
      throw new Error("control did not render");
    }
    box.checked = true;
    syncMultiSelectSummary({ currentTarget: details } as unknown as Event);
    expect(summaryText(container)).toBe("PhD Student, Lab Manager");
  });

  it("returns to the placeholder when the last box is cleared", () => {
    const container = draw(["PhD Student"]);
    const details = container.querySelector("details");
    const box = container.querySelector<HTMLInputElement>('input[value="PhD Student"]');
    if (!details || !box) {
      throw new Error("control did not render");
    }
    box.checked = false;
    syncMultiSelectSummary({ currentTarget: details } as unknown as Event);
    expect(summaryText(container)).toBe("Not set");
  });
});

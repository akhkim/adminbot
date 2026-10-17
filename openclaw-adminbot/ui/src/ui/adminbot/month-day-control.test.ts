import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { BirthdayPicker, renderMonthDayControl } from "./month-day-control.ts";

afterEach(() => {
  document.body.innerHTML = "";
});
async function setup(value = "03-14") {
  const form = document.createElement("form");
  document.body.append(form);
  render(renderMonthDayControl("birthday", value), form);
  const picker = form.querySelector<BirthdayPicker>("adminbot-birthday-picker")!;
  await picker.updateComplete;
  return { form, picker };
}

it("shows one month of day buttons, allows February 29, and saves only a complete MM-DD", async () => {
  const { form, picker } = await setup();
  const onInput = vi.fn();
  form.addEventListener("input", onInput);
  expect(picker.querySelector("[popover]")?.getAttribute("role")).toBe("dialog");
  expect(picker.querySelector("[popovertarget]")?.textContent).toContain("March 14");
  const month = picker.querySelector("select")!;
  month.value = "1";
  month.dispatchEvent(new Event("input", { bubbles: true }));
  await picker.updateComplete;
  expect(onInput).not.toHaveBeenCalled();
  expect(new FormData(form).get("birthday")).toBe("03-14");
  expect(picker.querySelectorAll(".birthday-picker__days button")).toHaveLength(29);
  picker.querySelector<HTMLButtonElement>('[aria-label="February 29"]')!.click();
  await picker.updateComplete;
  expect(new FormData(form).get("birthday")).toBe("02-29");
  expect(onInput).toHaveBeenCalledOnce();
  expect(picker.querySelector("[popovertarget]")?.textContent).toContain("February 29");
  expect(picker.textContent).not.toMatch(/\b\d{4}\b/);
});

it("handles short months, clearing, rerenders, and separate popup identities", async () => {
  const { form, picker } = await setup("01-31");
  const other = await setup("");
  expect(picker.querySelector("[popover]")!.id).not.toBe(
    other.picker.querySelector("[popover]")!.id,
  );
  const month = picker.querySelector("select")!;
  month.value = "3";
  month.dispatchEvent(new Event("input", { bubbles: true }));
  await picker.updateComplete;
  expect(picker.querySelectorAll(".birthday-picker__days button")).toHaveLength(30);
  render(renderMonthDayControl("birthday", "01-31"), form);
  await picker.updateComplete;
  expect(month.value).toBe("3");
  picker.querySelector<HTMLButtonElement>('[aria-label="April 30"]')!.click();
  await picker.updateComplete;
  render(renderMonthDayControl("birthday", "04-30"), form);
  await picker.updateComplete;
  expect(new FormData(form).get("birthday")).toBe("04-30");
  [...picker.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("Clear birthday"))!
    .click();
  await picker.updateComplete;
  expect(new FormData(form).get("birthday")).toBe("");
});

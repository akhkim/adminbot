/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { renderDeadlineTimezone } from "./deadlines.timezone.ts";
afterEach(() => {
  document.body.innerHTML = "";
});
it("searches named zones, supports keyboard selection and cancels edits with Escape", async () => {
  const change = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  render(renderDeadlineTimezone("local", change), container);
  const element = document.querySelector("adminbot-deadline-timezone") as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  await element.updateComplete;
  const input = element.querySelector("input")!;
  input.focus();
  await element.updateComplete;
  expect(element.querySelector('[role="option"]')?.textContent).toContain("Local");
  expect(element.querySelectorAll('[role="option"]').length).toBeGreaterThan(100);
  input.value = "toronto";
  input.dispatchEvent(new Event("input"));
  await element.updateComplete;
  expect(element.querySelectorAll('[role="option"]')).toHaveLength(1);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await element.updateComplete;
  expect(change).toHaveBeenLastCalledWith("America/Toronto");
  expect(input.value).toBe("Toronto (ET)");
  input.click();
  await element.updateComplete;
  input.value = "Tokyo";
  input.dispatchEvent(new Event("input"));
  await element.updateComplete;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await element.updateComplete;
  expect(input.value).toBe("Toronto (ET)");
  expect(input.getAttribute("aria-expanded")).toBe("false");
});
it("allows Original and AoE to be selected with a pointer", async () => {
  const change = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  render(renderDeadlineTimezone("local", change), container);
  const element = document.querySelector("adminbot-deadline-timezone") as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  await element.updateComplete;
  for (const [label, value] of [
    ["Original timezone", "original"],
    ["AoE — Anywhere on Earth (UTC−12)", "Etc/GMT+12"],
  ]) {
    element.querySelector("input")!.click();
    await element.updateComplete;
    const option = [...element.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent?.trim() === label,
    )!;
    option.click();
    await element.updateComplete;
    expect(change).toHaveBeenLastCalledWith(value);
    expect(element.querySelector("input")!.value).toBe(label);
  }
});

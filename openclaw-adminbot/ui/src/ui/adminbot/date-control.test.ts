import { html, render } from "lit";
import { expect, it, vi } from "vitest";
import { renderDateControl } from "./date-control.ts";

it("shows an unambiguous calendar date and updates before the parent rerenders", () => {
  const container = document.createElement("div");
  const onInput = vi.fn();
  render(
    renderDateControl(
      html`<input type="date" name="deadline" required .value=${"2026-11-03"} @input=${onInput} />`,
      "2026-11-03",
    ),
    container,
  );
  const input = container.querySelector("input")!;
  expect(container.textContent).toContain("Year–month–day");
  expect(container.querySelector("output")!.textContent).toBe("2026-11-03");
  input.value = "2026-03-11";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(onInput).toHaveBeenCalledOnce();
  expect(container.querySelector("output")!.textContent).toBe("2026-03-11");
  expect(input.name).toBe("deadline");
  expect(input.required).toBe(true);
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(container.querySelector("output")!.textContent).toBe("YYYY-MM-DD");
});

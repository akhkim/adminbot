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

// Regression: the input handler rewrote the <output>'s text directly, which deleted Lit's markers
// for a child text part, so the parent's next render threw and abandoned the rest of its update --
// a draft-backed form then never saw its own date and its submit button stayed disabled.
it("survives the parent re-rendering after the member types a date", () => {
  const container = document.createElement("div");
  const draw = (value: string) =>
    render(renderDateControl(html`<input type="date" .value=${value} />`, value), container);
  draw("");
  const input = container.querySelector("input")!;
  input.value = "2026-11-02";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(() => draw("2026-11-02")).not.toThrow();
  expect(() => draw("2026-11-05")).not.toThrow();
  expect(container.querySelector("output")!.textContent).toBe("2026-11-05");
});

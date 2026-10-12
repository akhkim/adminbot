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

// The label is updated on input, before the parent saves and redraws. That early write must leave
// the label where Lit can still reach it: when it did not, the next redraw threw at this control
// and every redraw after it stopped there, leaving the rest of the form -- including other date
// boxes and the handlers that hold the current rows -- on stale values that later overwrote what
// the member typed.
it("keeps redrawing after the label was updated on input", () => {
  const container = document.createElement("div");
  const draw = (value: string) =>
    render(
      html`${renderDateControl(html`<input type="date" .value=${value} />`, value)}
        <p>${value}</p>`,
      container,
    );
  draw("2026-11-03");
  const input = container.querySelector("input")!;
  input.value = "2026-11-14";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(() => draw("2026-11-14")).not.toThrow();
  expect(() => draw("2026-12-24")).not.toThrow();
  expect(container.querySelector("output")!.textContent).toBe("2026-12-24");
  // Rendered after the control: proof the redraw got past it.
  expect(container.querySelector("p")!.textContent).toBe("2026-12-24");
});

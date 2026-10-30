import { html, type TemplateResult } from "lit";

// Native pickers follow the browser locale, so 03/11 can read either way. Once a date is picked,
// echo it once as year-month-day underneath, without converting it through a time zone, including
// while a draft waits for its parent to save or rerender. An empty box shows only the browser's own
// placeholder: a second and third format hint under it was just noise.
//
// The label is a `.value` property binding, not text inside <output>, because the input handler
// updates it before the parent redraws. Writing text there removed the markers Lit keeps around a
// text binding, and every later redraw then threw at this control and stopped, leaving the rest of
// the form on stale rows that overwrote the dates people had typed.
export function renderDateControl(input: TemplateResult, value = "") {
  const label = (current: string) => (current ? current.replace("T", " ") : "");
  return html`<span
    style="display: grid; min-width: 0"
    @input=${(event: Event) => {
      const control = event.target;
      if (control instanceof HTMLInputElement) {
        (event.currentTarget as HTMLElement).querySelector("output")!.value = label(control.value);
      }
    }}
  >
    ${input}
    <output
      aria-label="Year–month–day"
      class="card-sub"
      style="display: block; margin: 4px 0 0; white-space: nowrap"
      .value=${label(value)}
    ></output>
  </span>`;
}

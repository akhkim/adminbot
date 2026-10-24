import { html, type TemplateResult } from "lit";

// Native pickers follow the browser locale. Keep the calendar value explicit without converting
// it through a time zone, including while a draft waits for its parent to save or rerender.
//
// The label is a `.value` property binding, not text inside <output>, because the input handler
// updates it before the parent redraws. Writing text there removed the markers Lit keeps around a
// text binding, and every later redraw then threw at this control and stopped, leaving the rest of
// the form on stale rows that overwrote the dates people had typed.
export function renderDateControl(input: TemplateResult, value = "") {
  const label = (current: string) => (current ? current.replace("T", " ") : "YYYY-MM-DD");
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
    <span class="card-sub" style="display: block; margin: 4px 0 0">Year–month–day</span>
    <output
      aria-label="Year–month–day"
      class="card-sub"
      style="display: block; margin: 0; white-space: nowrap"
      .value=${label(value)}
    ></output>
  </span>`;
}

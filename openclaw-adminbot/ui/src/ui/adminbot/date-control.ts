import { html, type TemplateResult } from "lit";

// Native pickers follow the browser locale. Keep the calendar value explicit without converting
// it through a time zone, including while a draft waits for its parent to save or rerender.
export function renderDateControl(input: TemplateResult, value = "") {
  const label = (current: string) => (current ? current.replace("T", " ") : "YYYY-MM-DD");
  return html`<span
    style="display: grid; min-width: 0"
    @input=${(event: Event) => {
      const control = event.target;
      if (control instanceof HTMLInputElement) {
        (event.currentTarget as HTMLElement).querySelector("output")!.textContent = label(
          control.value,
        );
      }
    }}
  >
    ${input}
    <span class="card-sub" style="display: block; margin: 4px 0 0">Year–month–day</span>
    <output
      aria-label="Year–month–day"
      class="card-sub"
      style="display: block; margin: 0; white-space: nowrap"
      >${label(value)}</output
    >
  </span>`;
}

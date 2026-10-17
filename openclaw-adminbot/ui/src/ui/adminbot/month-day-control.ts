import { LitElement, html } from "lit";
import { property, state } from "lit/decorators.js";

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const pad = (value: number) => String(value).padStart(2, "0");
let nextId = 0;

export class BirthdayPicker extends LitElement {
  @property() value = "";
  @state() private month = 0;
  private readonly panelId = `birthday-picker-${++nextId}`;

  override createRenderRoot() {
    return this;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("value")) this.month = Number(this.value.split("-")[0] || 1) - 1;
  }

  private choose(value: string) {
    this.value = value;
    this.querySelector<HTMLElement>("[popover]")?.hidePopover?.();
    this.querySelector<HTMLButtonElement>("[popovertarget]")?.focus();
    this.dispatchEvent(new CustomEvent("birthday-change", { detail: value, bubbles: true }));
  }

  override render() {
    const [month, day] = this.value.split("-");
    return html` <button
        type="button"
        class="input"
        popovertarget=${this.panelId}
        aria-haspopup="dialog"
        aria-label="Choose birthday"
        style=${`anchor-name: --${this.panelId}`}
      >
        ${this.value ? `${months[Number(month) - 1]} ${Number(day)}` : "Choose birthday"}
      </button>
      <div
        id=${this.panelId}
        popover="auto"
        role="dialog"
        aria-label="Choose birthday"
        class="birthday-picker__panel"
        style=${`position-anchor: --${this.panelId}`}
      >
        <select
          class="input"
          aria-label="Birthday month"
          @input=${(event: Event) => {
            event.stopPropagation();
            this.month = Number((event.target as HTMLSelectElement).value);
          }}
        >
          ${months.map(
            (name, index) =>
              html`<option value=${index} ?selected=${index === this.month}>${name}</option>`,
          )}
        </select>
        <div class="birthday-picker__days" role="group" aria-label=${`${months[this.month]} days`}>
          ${Array.from({ length: daysInMonth[this.month]! }, (_, index) => {
            const date = `${pad(this.month + 1)}-${pad(index + 1)}`;
            return html`<button
              type="button"
              class="btn btn--sm"
              aria-label=${`${months[this.month]} ${index + 1}`}
              aria-pressed=${this.value === date}
              @click=${() => this.choose(date)}
            >
              ${index + 1}
            </button>`;
          })}
        </div>
        <button type="button" class="btn btn--sm" @click=${() => this.choose("")}>
          Clear birthday
        </button>
      </div>`;
  }
}

if (!customElements.get("adminbot-birthday-picker")) {
  customElements.define("adminbot-birthday-picker", BirthdayPicker);
}

/** Keep the existing form/autosave contract: one MM-DD value, never a birth year. */
export function renderMonthDayControl(name: string, value: string) {
  return html`<span
    @birthday-change=${(event: CustomEvent<string>) => {
      event.stopPropagation();
      const input = (event.currentTarget as HTMLElement).querySelector("input")!;
      input.value = event.detail;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }}
  >
    <input type="hidden" name=${name} .value=${value} />
    <adminbot-birthday-picker .value=${value}></adminbot-birthday-picker>
  </span>`;
}

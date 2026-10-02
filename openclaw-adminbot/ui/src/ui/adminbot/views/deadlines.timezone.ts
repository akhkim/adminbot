import { html, nothing, LitElement } from "lit";
import { icons } from "../../icons.ts";
import { validDisplayTimezone } from "../data/deadline-display-time.ts";
import { localTimezone, timezoneOptions, timezoneOptionLabel } from "../data/timezones.ts";

let nextId = 0;
class DeadlineTimezoneSelect extends LitElement {
  static override properties = {
    value: { type: String },
    open: { state: true },
    query: { state: true },
    active: { state: true },
  };
  declare value: string;
  declare open: boolean;
  declare query: string;
  declare active: number;
  private readonly listId: string;
  private readonly zones = timezoneOptions("UTC").flatMap((group) =>
    group.options.map((option) => option.zone),
  );
  constructor() {
    super();
    nextId += 1;
    this.listId = `deadline-timezones-${nextId}`;
    this.value = "local";
    this.open = false;
    this.query = "";
    this.active = 0;
  }
  protected override createRenderRoot(): HTMLElement {
    return this;
  }
  private label(value: string): string {
    return value === "local"
      ? "Local timezone"
      : value === "original"
        ? "Original timezone"
        : timezoneOptionLabel(value);
  }
  private get options(): string[] {
    return [
      "local",
      "original",
      "Etc/GMT+12",
      ...this.zones.filter((zone) => zone !== "Etc/GMT+12"),
    ].filter((zone) =>
      `${this.label(zone)} ${zone}`
        .toLowerCase()
        .replaceAll("_", " ")
        .includes(this.query.toLowerCase().replaceAll("_", " ")),
    );
  }
  private commit(value: string): void {
    if (validDisplayTimezone(value)) {
      this.value = value;
      this.dispatchEvent(
        new CustomEvent<string>("timezone-change", { detail: value, bubbles: true }),
      );
    }
    this.open = false;
    this.query = "";
    const input = this.querySelector("input");
    if (input) {
      input.value = this.label(this.value);
    }
  }
  private commitText(event: Event): void {
    const text = (event.target as HTMLInputElement).value.trim();
    const value =
      text === this.label("local") || text.toLowerCase() === "local"
        ? "local"
        : text === this.label("original") || text.toLowerCase() === "original"
          ? "original"
          : text.toLowerCase() === "aoe"
            ? "Etc/GMT+12"
            : (this.zones.find((zone) => this.label(zone).toLowerCase() === text.toLowerCase()) ??
              text);
    this.commit(value);
  }
  private keydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.commit(this.value);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.active = this.open
        ? (this.active + step + this.options.length) % Math.max(this.options.length, 1)
        : 0;
      this.open = true;
    } else if (event.key === "Enter" && this.open) {
      event.preventDefault();
      const picked = this.options[this.active];
      if (picked) {
        this.commit(picked);
      }
    }
  }
  protected override updated(): void {
    if (this.open) {
      this.querySelector(".country-select__option--active")?.scrollIntoView?.({ block: "nearest" });
    }
  }
  protected override render() {
    const options = this.open ? this.options : [];
    return html`<div class="country-select deadline-board__facet deadline-board__timezone">
      <input
        id=${`${this.listId}-input`}
        aria-label="Display timezone"
        title=${this.value === "local"
          ? `Local timezone — ${localTimezone()}`
          : this.label(this.value)}
        role="combobox"
        aria-expanded=${String(this.open)}
        aria-controls=${this.listId}
        aria-autocomplete="list"
        aria-activedescendant=${this.open && options[this.active]
          ? `${this.listId}-${this.active}`
          : nothing}
        autocomplete="off"
        .value=${this.open ? this.query : this.label(this.value)}
        placeholder=${this.label(this.value)}
        @change=${(event: Event) => this.commitText(event)}
        @keydown=${(event: KeyboardEvent) => this.keydown(event)}
        @focus=${(event: Event) => {
          this.open = true;
          this.query = "";
          this.active = 0;
          (event.target as HTMLInputElement).select();
        }}
        @click=${() => {
          this.open = true;
        }}
        @input=${(event: Event) => {
          this.query = (event.target as HTMLInputElement).value;
          this.open = true;
          this.active = 0;
        }}
        @blur=${() => {
          this.open = false;
          this.query = "";
          const input = this.querySelector("input");
          if (input) {
            input.value = this.label(this.value);
          }
        }}
      />
      <span class="country-select__chevron" aria-hidden="true">${icons.chevronDown}</span>
      ${this.open
        ? html`<ul
            class="country-select__list"
            id=${this.listId}
            role="listbox"
            aria-label="Timezones"
          >
            ${options.map(
              (zone, index) => html`<li
                id=${`${this.listId}-${index}`}
                role="option"
                aria-selected=${String(zone === this.value)}
                class=${`country-select__option ${index === this.active ? "country-select__option--active" : ""}`}
                @pointerdown=${(event: PointerEvent) => event.preventDefault()}
                @click=${() => this.commit(zone)}
                @mouseenter=${() => {
                  this.active = index;
                }}
              >
                ${this.label(zone)}
              </li>`,
            )}
            ${options.length ? nothing : html`<li role="presentation">No matching timezone</li>`}
          </ul>`
        : nothing}
    </div>`;
  }
}
if (!customElements.get("adminbot-deadline-timezone")) {
  customElements.define("adminbot-deadline-timezone", DeadlineTimezoneSelect);
}
export function renderDeadlineTimezone(value: string, change: (value: string) => void) {
  return html`<adminbot-deadline-timezone
    .value=${value}
    @timezone-change=${(event: CustomEvent<string>) => change(event.detail)}
  ></adminbot-deadline-timezone>`;
}

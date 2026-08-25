import { html, LitElement } from "lit";
import { icons } from "../../icons.ts";

function normalize(value: string): string {
  return value.toLocaleLowerCase().trim();
}

class AdminbotDeadlineParentConferenceSelect extends LitElement {
  static override properties = {
    options: { attribute: false },
    value: { type: String },
    open: { state: true },
    active: { state: true },
  };

  declare options: readonly string[];
  declare value: string;
  declare open: boolean;
  declare active: number;

  constructor() {
    super();
    this.options = [];
    this.value = "";
    this.open = false;
    this.active = 0;
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  private get filtered(): readonly string[] {
    const query = normalize(this.value);
    return query
      ? this.options.filter((option) => normalize(option).includes(query))
      : this.options;
  }

  protected override updated(): void {
    if (this.open) {
      this.querySelector(".country-select__option--active")?.scrollIntoView?.({ block: "nearest" });
    }
  }

  private commit(option: string): void {
    this.value = option;
    this.open = false;
  }

  private onKeyDown(event: KeyboardEvent): void {
    const options = this.filtered;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.open = true;
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.active = (this.active + step + options.length) % Math.max(options.length, 1);
      return;
    }
    if (event.key === "Enter" && this.open) {
      const picked = options[this.active];
      if (picked) {
        event.preventDefault();
        this.commit(picked);
      }
      return;
    }
    if (event.key === "Escape" && this.open) {
      event.preventDefault();
      this.open = false;
    }
  }

  protected override render() {
    const options = this.filtered;
    const listId = "deadline-parent-conference-list";
    return html`
      <div class="country-select deadline-parent-conference-select">
        <input
          name="parentConference"
          type="text"
          autocomplete="off"
          role="combobox"
          aria-expanded=${this.open ? "true" : "false"}
          aria-controls=${listId}
          aria-autocomplete="list"
          aria-label="Parent conference"
          placeholder="Choose or enter a conference"
          .value=${this.value}
          @focus=${() => {
            this.open = true;
            this.active = 0;
          }}
          @input=${(event: Event) => {
            this.value = (event.target as HTMLInputElement).value;
            this.open = true;
            this.active = 0;
          }}
          @keydown=${this.onKeyDown}
          @blur=${() => {
            window.setTimeout(() => {
              this.open = false;
            }, 120);
          }}
        />
        <span class="country-select__chevron" aria-hidden="true">${icons.chevronDown}</span>
        ${this.open && options.length
          ? html`
              <ul class="country-select__list" id=${listId} role="listbox">
                ${options.map(
                  (option, index) => html`
                    <li
                      class=${`country-select__option ${
                        index === this.active ? "country-select__option--active" : ""
                      }`}
                      role="option"
                      aria-selected=${option === this.value ? "true" : "false"}
                      @mousedown=${(event: Event) => {
                        event.preventDefault();
                        this.commit(option);
                      }}
                      @mouseenter=${() => {
                        this.active = index;
                      }}
                    >
                      ${option}
                    </li>
                  `,
                )}
              </ul>
            `
          : null}
      </div>
    `;
  }
}

if (!customElements.get("adminbot-deadline-parent-conference-select")) {
  customElements.define(
    "adminbot-deadline-parent-conference-select",
    AdminbotDeadlineParentConferenceSelect,
  );
}

export function renderDeadlineParentConferenceSelect(params: {
  options: readonly string[];
  value: string;
}) {
  return html`
    <adminbot-deadline-parent-conference-select
      .options=${params.options}
      .value=${params.value}
    ></adminbot-deadline-parent-conference-select>
  `;
}

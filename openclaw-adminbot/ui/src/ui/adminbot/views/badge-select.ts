// The badge box in Assignments: type to search, click or arrow to pick.
//
// Same control as the member box beside it (member-select.ts), for the same reason: a
// `<select>` can only be searched by native type-ahead, which matches from the start of the
// option text, and the catalog grows past a comfortable scroll length as families gain tiers.
import { html, LitElement } from "lit";
import { icons } from "../../icons.ts";

export type BadgeOption = {
  id: string;
  name: string;
  /** Shown beside the name and searched alongside it -- the badge's category. */
  hint?: string;
};

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function matches(option: BadgeOption, query: string): boolean {
  const needle = normalize(query);
  if (!needle) {
    return true;
  }
  return normalize(option.name).includes(needle) || normalize(option.hint ?? "").includes(needle);
}

class AdminbotBadgeSelect extends LitElement {
  static override properties = {
    options: { attribute: false },
    value: { type: String },
    placeholder: { type: String },
    label: { type: String },
    disabled: { type: Boolean },
    onPick: { attribute: false },
    open: { state: true },
    query: { state: true },
    active: { state: true },
  };

  declare options: readonly BadgeOption[];
  /** The selected badge id, or "" for none. */
  declare value: string;
  declare placeholder: string;
  declare label: string;
  declare disabled: boolean;
  declare onPick: (badgeId: string) => void;
  declare open: boolean;
  declare query: string;
  declare active: number;

  constructor() {
    super();
    this.options = [];
    this.value = "";
    this.placeholder = "";
    this.label = "";
    this.disabled = false;
    this.onPick = () => {};
    this.open = false;
    this.query = "";
    this.active = 0;
  }

  // Light DOM, so the app's tokens and `.input` styles reach the control.
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  private get filtered(): readonly BadgeOption[] {
    return this.options.filter((option) => matches(option, this.query));
  }

  protected override updated(): void {
    if (!this.open) {
      return;
    }
    this.querySelector(".country-select__option--active")?.scrollIntoView?.({ block: "nearest" });
  }

  private get selectedName(): string {
    return this.options.find((option) => option.id === this.value)?.name ?? "";
  }

  private commit(option: BadgeOption): void {
    this.value = option.id;
    this.open = false;
    this.query = "";
    this.onPick(option.id);
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
    const listId = "adminbot-badge-select-list";
    return html`
      <div class="country-select">
        <input
          class="input"
          type="text"
          autocomplete="off"
          role="combobox"
          aria-expanded=${this.open ? "true" : "false"}
          aria-controls=${listId}
          aria-autocomplete="list"
          aria-label=${this.label}
          placeholder=${this.placeholder}
          ?disabled=${this.disabled}
          .value=${this.open ? this.query : this.selectedName}
          @focus=${() => {
            this.open = true;
            this.query = "";
            this.active = 0;
          }}
          @input=${(event: Event) => {
            this.query = (event.target as HTMLInputElement).value;
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
                      aria-selected=${option.id === this.value ? "true" : "false"}
                      @mousedown=${(event: Event) => {
                        event.preventDefault();
                        this.commit(option);
                      }}
                      @mouseenter=${() => {
                        this.active = index;
                      }}
                    >
                      <span class="country-select__name">${option.name}</span>
                      ${option.hint
                        ? html`<span class="member-select__hint">${option.hint}</span>`
                        : null}
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

if (!customElements.get("adminbot-badge-select")) {
  customElements.define("adminbot-badge-select", AdminbotBadgeSelect);
}

export function renderBadgeSelect(params: {
  options: readonly BadgeOption[];
  value: string;
  placeholder: string;
  label: string;
  disabled: boolean;
  onPick: (badgeId: string) => void;
}) {
  return html`
    <adminbot-badge-select
      .options=${params.options}
      .value=${params.value}
      .placeholder=${params.placeholder}
      .label=${params.label}
      .disabled=${params.disabled}
      .onPick=${params.onPick}
    ></adminbot-badge-select>
  `;
}

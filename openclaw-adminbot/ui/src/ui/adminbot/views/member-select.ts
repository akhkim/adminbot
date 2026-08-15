// The member box on Time Availability: type to search, click or arrow to pick.
//
// Same control as the country box beside a phone number (country-select.ts), for the same reason:
// a `<select>` can only be searched by native type-ahead, which matches from the start of the
// option text. With ~200 members on the roster, finding "Yahang Qi" meant scrolling, and anyone
// who thought to type "qi" got nothing. This is a text input plus a list the app draws itself,
// which is what buys both search and a list that looks like the page.
//
// It carries no form `name`: the picker reports through `onPick` and the tab holds the selected id
// in view state. The country box keeps a name because it sits inside a form whose autosave reads
// it through FormData; this one has no form to belong to.
import { html, LitElement } from "lit";
import { icons } from "../../icons.ts";

export type MemberOption = {
  id: string;
  name: string;
  /** Shown beside the name and searched alongside it -- the login email, where there is one. */
  hint?: string;
};

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

// Substring, not prefix: the roster holds "Xuanqiang Angelo Huang" and "Yen-Shan Chen (Lily)", and
// people search for the part of a name they remember rather than the part it starts with.
function matches(option: MemberOption, query: string): boolean {
  const needle = normalize(query);
  if (!needle) {
    return true;
  }
  return (
    normalize(option.name).includes(needle) || normalize(option.hint ?? "").includes(needle)
  );
}

class AdminbotMemberSelect extends LitElement {
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

  declare options: readonly MemberOption[];
  /** The selected member id, or "" for none. */
  declare value: string;
  declare placeholder: string;
  declare label: string;
  declare disabled: boolean;
  declare onPick: (memberId: string) => void;
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

  private get filtered(): readonly MemberOption[] {
    return this.options.filter((option) => matches(option, this.query));
  }

  // Arrowing past the edge of the panel has to bring the row with it, or the highlight walks off
  // screen and the list stops answering the keyboard.
  protected override updated(): void {
    if (!this.open) {
      return;
    }
    // Optional call: jsdom implements no scrolling at all.
    this.querySelector(".country-select__option--active")?.scrollIntoView?.({ block: "nearest" });
  }

  /** The text the box shows at rest: the picked member's name, or nothing. */
  private get selectedName(): string {
    return this.options.find((option) => option.id === this.value)?.name ?? "";
  }

  private commit(option: MemberOption): void {
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
    const listId = "time-availability-member-list";
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
          data-testid="time-availability-member-search"
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
            // After the row's mousedown, so picking from the list still lands.
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
                        // mousedown, not click: blur would close the list first.
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

if (!customElements.get("adminbot-member-select")) {
  customElements.define("adminbot-member-select", AdminbotMemberSelect);
}

export function renderMemberSelect(params: {
  options: readonly MemberOption[];
  value: string;
  placeholder: string;
  label: string;
  disabled: boolean;
  onPick: (memberId: string) => void;
}) {
  return html`
    <adminbot-member-select
      .options=${params.options}
      .value=${params.value}
      .placeholder=${params.placeholder}
      .label=${params.label}
      .disabled=${params.disabled}
      .onPick=${params.onPick}
    ></adminbot-member-select>
  `;
}

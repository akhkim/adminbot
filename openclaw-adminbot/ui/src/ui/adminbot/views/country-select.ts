// The country box beside a phone number: type to search, click or arrow to pick.
//
// It is a text input plus a list this app draws itself, rather than either of the two things the
// platform offers. A `<select>` cannot be searched by country name -- native type-ahead matches
// from the start of the option text, which here is the dial code -- and a `<datalist>` popup is
// drawn by the browser, at its own size and colours, with no way to style it into the rest of the
// page. Drawing the list is what buys both search and a list that looks like the app.
//
// The inner input keeps the field's real `name`, so it is still an ordinary form control that
// FormData collects and the form's own autosave sees; this element adds the list, not the value.
import { html, LitElement } from "lit";
import { t } from "../../../i18n/index.ts";
import {
  PHONE_COUNTRIES,
  phoneCountryLabel,
  type PhoneCountry,
} from "../data/phone-country-codes.ts";

// Enough of the list to show it is long and scrollable, few enough that the panel never covers the
// fields under it. Typing narrows the list rather than paging through it.
const VISIBLE_LIMIT = 8;

function matches(country: PhoneCountry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  // A leading + is how a dial code is written, not something anyone means to search for.
  const bare = needle.replace(/^\+/, "");
  return (
    country.name.toLowerCase().includes(needle) ||
    country.dial.replace("+", "").startsWith(bare) ||
    country.iso.toLowerCase() === needle
  );
}

class AdminbotCountrySelect extends LitElement {
  static override properties = {
    name: { type: String },
    value: { type: String },
    open: { state: true },
    query: { state: true },
    active: { state: true },
  };

  declare name: string;
  /** The stored dial code ("+44"), or "" when the field is empty. */
  declare value: string;
  declare open: boolean;
  declare query: string;
  declare active: number;

  constructor() {
    super();
    this.name = "";
    this.value = "";
    this.open = false;
    this.query = "";
    this.active = 0;
  }

  // Light DOM: the app's tokens and `.input` styles have to reach the control, and the value has
  // to be visible to the surrounding <form>.
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  private get filtered(): PhoneCountry[] {
    return PHONE_COUNTRIES.filter((country) => matches(country, this.query)).slice(
      0,
      VISIBLE_LIMIT,
    );
  }

  private get input(): HTMLInputElement | null {
    return this.querySelector("input");
  }

  /** The text the box shows at rest: the picked country, named, or whatever was typed. */
  private get label(): string {
    const picked = PHONE_COUNTRIES.find((country) => country.dial === this.value);
    return picked ? phoneCountryLabel(picked) : this.value;
  }

  private commit(country: PhoneCountry): void {
    this.value = country.dial;
    this.open = false;
    this.query = "";
    const input = this.input;
    if (input) {
      input.value = phoneCountryLabel(country);
      // The form autosaves on `input`, and a click on a list row is not one.
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
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
    const listId = `${this.name}-list`;
    return html`
      <div class="country-select">
        <input
          class="input profile__phone-code"
          name=${this.name}
          type="text"
          autocomplete="off"
          role="combobox"
          aria-expanded=${this.open ? "true" : "false"}
          aria-controls=${listId}
          aria-autocomplete="list"
          placeholder=${t("profile.basics.countryCodeNone")}
          aria-label=${t("profile.basics.countryCode")}
          .value=${this.open ? this.query : this.label}
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
            // After the click handler below, so picking from the list still lands.
            window.setTimeout(() => {
              this.open = false;
            }, 120);
          }}
        />
        ${this.open && options.length
          ? html`
              <ul class="country-select__list" id=${listId} role="listbox">
                ${options.map(
                  (country, index) => html`
                    <li
                      class=${`country-select__option ${
                        index === this.active ? "country-select__option--active" : ""
                      }`}
                      role="option"
                      aria-selected=${country.dial === this.value ? "true" : "false"}
                      @mousedown=${(event: Event) => {
                        // mousedown, not click: blur would close the list first.
                        event.preventDefault();
                        this.commit(country);
                      }}
                      @mouseenter=${() => {
                        this.active = index;
                      }}
                    >
                      <span class="country-select__dial">${country.dial}</span>
                      <span class="country-select__name">${country.name}</span>
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

if (!customElements.get("adminbot-country-select")) {
  customElements.define("adminbot-country-select", AdminbotCountrySelect);
}

export function renderCountrySelect(params: { name: string; value: string }) {
  return html`
    <adminbot-country-select
      .name=${params.name}
      .value=${params.value}
    ></adminbot-country-select>
  `;
}

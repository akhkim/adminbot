import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";

/** One choice in a filter. `label` is what the menu and the chip show. */
export type FilterBarOption = { value: string; label: string };

/** A filter behind the Filters control. `name` is the form field name the page already reads. */
export type FilterBarField = {
  name: string;
  label: string;
  options: FilterBarOption[];
  /** The value the page last applied; the DOM stays the source of truth between renders. */
  value?: string;
  /** Text for the empty choice. Defaults to "Any". */
  anyLabel?: string;
  disabled?: boolean;
};

let nextId = 0;
function nextPanelId() {
  nextId += 1;
  return `adminbot-filter-bar-${nextId}`;
}

/**
 * One search box, a Filters button that opens the rest, and a chip for each filter that is set.
 *
 * Renders into light DOM so its inputs belong to the surrounding `<form>`: the page keeps reading
 * them with FormData and listening for `input`/`change` on the form, as it did when the selects
 * sat in a row. Removing a chip clears its select and fires one bubbling `change`, so a page that
 * filters on change needs no new wiring.
 */
export class AdminBotFilterBar extends LitElement {
  @property({ attribute: false }) fields: FilterBarField[] = [];
  @property({ attribute: "search-name" }) searchName = "search";
  @property({ attribute: "search-label" }) searchLabel = "Search";
  @property() placeholder = "Search";
  @property({ attribute: false }) searchValue = "";
  @property({ type: Boolean }) disabled = false;
  @state() private selected: Record<string, string> = {};
  private readonly panelId = nextPanelId();

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("change", this.onFieldChange);
    // Draw the first time synchronously, as soon as the element is connected: the page reads these
    // fields with FormData in the same task it renders (a seeded search, a restored selection), so
    // they have to exist when the page's render returns, not a microtask later.
    if (!this.hasUpdated) {
      this.performUpdate();
    }
  }

  override disconnectedCallback() {
    this.removeEventListener("change", this.onFieldChange);
    super.disconnectedCallback();
  }

  private readonly onFieldChange = (event: Event) => {
    if (event.target instanceof HTMLSelectElement) {
      this.sync();
    }
  };

  /** Re-read the selects. Call after setting a select's value from outside. */
  sync() {
    const next: Record<string, string> = {};
    for (const select of this.querySelectorAll<HTMLSelectElement>("[data-filter-field]")) {
      if (select.value) {
        next[select.name] = select.value;
      }
    }
    const same =
      Object.keys(next).length === Object.keys(this.selected).length &&
      Object.entries(next).every(([key, value]) => this.selected[key] === value);
    if (!same) {
      this.selected = next;
    }
  }

  override updated() {
    this.sync();
  }

  private clear(names: string[]) {
    const selects = [...this.querySelectorAll<HTMLSelectElement>("[data-filter-field]")].filter(
      (select) => names.includes(select.name),
    );
    for (const select of selects) {
      select.value = "";
    }
    selects[0]?.dispatchEvent(new Event("change", { bubbles: true }));
    this.sync();
  }

  override render() {
    const active = this.fields.filter((field) => this.selected[field.name]);
    return html`
      <input
        class="adminbot-filter-bar__search"
        name=${this.searchName}
        type="search"
        aria-label=${this.searchLabel}
        placeholder=${this.placeholder}
        autocomplete="off"
        .value=${this.searchValue}
        ?disabled=${this.disabled}
      />
      ${this.fields.length
        ? html`<button
              type="button"
              class="btn btn--sm adminbot-filter-bar__toggle"
              popovertarget=${this.panelId}
              aria-haspopup="dialog"
              style=${`anchor-name: --${this.panelId}`}
            >
              Filters${active.length
                ? html`<span class="adminbot-filter-bar__count">${active.length}</span>`
                : nothing}
            </button>
            <div
              id=${this.panelId}
              popover="auto"
              role="dialog"
              aria-label="Filters"
              class="adminbot-filter-bar__panel"
              style=${`position-anchor: --${this.panelId}`}
            >
              ${this.fields.map(
                (field) =>
                  html`<label
                    ><span>${field.label}</span
                    ><select
                      data-filter-field
                      name=${field.name}
                      ?disabled=${this.disabled || field.disabled}
                    >
                      <option value="" .selected=${!field.value}>${field.anyLabel ?? "Any"}</option>
                      ${field.options.map(
                        (option) =>
                          html`<option
                            value=${option.value}
                            .selected=${option.value === field.value}
                          >
                            ${option.label}
                          </option>`,
                      )}
                    </select></label
                  >`,
              )}
              ${active.length
                ? html`<button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    @click=${() => this.clear(active.map((field) => field.name))}
                  >
                    Clear all
                  </button>`
                : nothing}
            </div>`
        : nothing}
      ${active.length
        ? html`<ul class="adminbot-filter-bar__chips" aria-label="Active filters">
            ${active.map((field) => {
              const value = this.selected[field.name]!;
              const label = field.options.find((option) => option.value === value)?.label ?? value;
              return html`<li>
                <button
                  type="button"
                  class="adminbot-filter-chip"
                  aria-label=${`Remove ${field.label}: ${label}`}
                  @click=${() => this.clear([field.name])}
                >
                  <span>${field.label}: ${label}</span><span aria-hidden="true">×</span>
                </button>
              </li>`;
            })}
          </ul>`
        : nothing}
    `;
  }
}

if (!customElements.get("adminbot-filter-bar")) {
  customElements.define("adminbot-filter-bar", AdminBotFilterBar);
}

declare global {
  interface HTMLElementTagNameMap {
    "adminbot-filter-bar": AdminBotFilterBar;
  }
}

/** Plain string options, labelled by a formatter (identity by default). */
export function filterOptions(
  values: readonly string[],
  label: (value: string) => string = (value) => value,
): FilterBarOption[] {
  return values.map((value) => ({ value, label: label(value) }));
}

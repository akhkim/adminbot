// The description block on the "create badge" form: by default a single badge with one
// description, but once the admin adds a tier it switches to one tier-name + description pair per
// row, since a tiered family (Level 1, Level 2, ...) needs a different description per tier. All
// inputs are real `<input>`/`<textarea>` elements in the light DOM, so the parent `<form>`'s
// FormData collects them via `formData.getAll("tier")` / `formData.getAll("description")`,
// index-aligned, with no extra wiring. Zero tier rows means `getAll("tier")` is empty and
// `getAll("description")` holds the single base description.
import { html, LitElement } from "lit";
import { t } from "../../../i18n/index.ts";

let nextRowId = 0;

class AdminbotBadgeTierRows extends LitElement {
  static override properties = {
    disabled: { type: Boolean },
    rowIds: { state: true },
  };

  declare disabled: boolean;
  declare rowIds: number[];

  constructor() {
    super();
    this.disabled = false;
    this.rowIds = [];
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  private addRow(): void {
    this.rowIds = [...this.rowIds, nextRowId++];
  }

  private removeRow(rowId: number): void {
    this.rowIds = this.rowIds.filter((id) => id !== rowId);
  }

  protected override render() {
    if (this.rowIds.length === 0) {
      return html`
        <div class="adminbot-badge-tier-rows">
          <label>
            <span
              >${t("adminbotBadges.field.description")}
              <span class="profile__mandatory" aria-hidden="true"></span
              ><span class="sr-only">${t("profile.basics.mandatory")}</span></span
            >
            <textarea
              class="input adminbot-badge-textarea--compact"
              name="description"
              rows="1"
              required
              ?disabled=${this.disabled}
            ></textarea>
          </label>
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${this.disabled}
            @click=${() => this.addRow()}
          >
            + ${t("adminbotBadges.addTier")}
          </button>
        </div>
      `;
    }
    return html`
      <div class="adminbot-badge-tier-rows">
        ${this.rowIds.map(
          (rowId) => html`
            <div class="adminbot-badge-tier-rows__row">
              <input
                class="input"
                name="tier"
                placeholder="e.g. Level 1"
                aria-label=${t("adminbotBadges.field.tier")}
                ?disabled=${this.disabled}
              />
              <textarea
                class="input adminbot-badge-textarea--compact"
                name="description"
                rows="1"
                required
                aria-label=${t("adminbotBadges.field.description")}
                placeholder=${t("adminbotBadges.field.description")}
                ?disabled=${this.disabled}
              ></textarea>
              <button
                class="btn btn--sm danger"
                type="button"
                ?disabled=${this.disabled}
                @click=${() => this.removeRow(rowId)}
              >
                &times;
              </button>
            </div>
          `,
        )}
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${this.disabled}
          @click=${() => this.addRow()}
        >
          + ${t("adminbotBadges.addTier")}
        </button>
      </div>
    `;
  }
}

if (!customElements.get("adminbot-badge-tier-rows")) {
  customElements.define("adminbot-badge-tier-rows", AdminbotBadgeTierRows);
}

export function renderBadgeTierRows(params: { disabled: boolean }) {
  return html`<adminbot-badge-tier-rows .disabled=${params.disabled}></adminbot-badge-tier-rows>`;
}

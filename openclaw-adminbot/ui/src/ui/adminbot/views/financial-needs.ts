// "Subscription or financial support needs" on My Profile: expenses a member has paid, or is paying,
// and plans to claim back, registered roughly so the PI can estimate the lab's spending by category
// before the claims arrive. Nothing here files or pays a claim.
//
// Its own section with its own Save, rather than rows inside the autosaving basics form: that form
// re-renders from the saved record after every keystroke pause, and a half-typed row (an amount
// with no description yet) would either be refused by the service or dropped by the re-render. Here
// the draft stays in the element until the member presses Save.
//
// The service validates the same shape (validateFinancialSupportNeeds in kernel/service.ts) and
// serves the field only to the member and admins (adminBotConfidentialMemberFields). The daily
// PeopleList export carries it as a column for the PI's review.
import { css, html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { MemberFinancialSupportNeed } from "../api/members.ts";

type Category = MemberFinancialSupportNeed["category"];

export const FINANCIAL_SUPPORT_CATEGORY_LABELS: Record<Category, string> = {
  ai_subscription: "AI agent or subscription",
  travel: "Travel",
  other: "Other",
};

// Mirrors ADMINBOT_MAX_FINANCIAL_SUPPORT_ROWS / _TEXT in contracts/actions.ts.
const MAX_ROWS = 20;
const MAX_TEXT = 500;

/** A row as typed: every box is text until Save turns it into the stored shape. */
export type FinancialNeedDraft = {
  category: Category;
  amount: string;
  currency: string;
  description: string;
  pi_permission: string;
};

const blankDraft = (): FinancialNeedDraft => ({
  category: "ai_subscription",
  amount: "",
  currency: "USD",
  description: "",
  pi_permission: "",
});

export function toDrafts(entries: unknown): FinancialNeedDraft[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .filter((row): row is MemberFinancialSupportNeed => Boolean(row) && typeof row === "object")
    .map((row) => ({
      category: row.category in FINANCIAL_SUPPORT_CATEGORY_LABELS ? row.category : "other",
      amount: typeof row.amount === "number" ? String(row.amount) : "",
      currency: row.currency ?? "",
      description: row.description ?? "",
      pi_permission: row.pi_permission ?? "",
    }));
}

/**
 * Turns the typed rows into what the service stores, or says what to fix.
 *
 * A row left completely empty is dropped: pressing "Add an expense" and changing your mind should
 * not need a Remove. A row with anything in it but no description is refused, because a number
 * without a "what for" is exactly the entry the PI cannot budget from.
 */
export function fromDrafts(
  drafts: readonly FinancialNeedDraft[],
): { ok: true; entries: MemberFinancialSupportNeed[] } | { ok: false; error: string } {
  const entries: MemberFinancialSupportNeed[] = [];
  for (const draft of drafts) {
    const description = draft.description.trim();
    const amountText = draft.amount.trim();
    const currency = draft.currency.trim().toUpperCase();
    const permission = draft.pi_permission.trim();
    if (!description && !amountText && !currency && !permission) {
      continue;
    }
    if (!description) {
      return { ok: false, error: "Add a short description to each expense." };
    }
    const amount = amountText ? Number(amountText) : undefined;
    if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) {
      return {
        ok: false,
        error: `"${amountText}" is not an amount. Use a number such as 240.`,
      };
    }
    if (amount !== undefined && !currency) {
      // The sheet totals per currency and never converts, so an amount needs its currency.
      return { ok: false, error: "Add the currency for each amount, such as USD or CAD." };
    }
    if (currency && !/^[A-Z]{3}$/.test(currency)) {
      return {
        ok: false,
        error: `Use a three-letter currency code such as USD or CAD.`,
      };
    }
    entries.push({
      category: draft.category,
      ...(amount !== undefined ? { amount } : {}),
      ...(currency ? { currency } : {}),
      description,
      ...(permission ? { pi_permission: permission } : {}),
    });
  }
  return { ok: true, entries };
}

export class FinancialNeedsSection extends LitElement {
  static override styles = css`
    :host {
      display: block;
      margin-bottom: var(--space-6);
    }
    /* A section of My Profile like its neighbours: no fill, no frame, no side inset, closed by a
       hairline (ui/DESIGN.md, "No grey boxes"). Rows are separated by hairlines too. */
    section {
      padding: 0 0 var(--space-6);
      border-bottom: 1px solid var(--border);
    }
    h3 {
      margin: 0 0 var(--space-1);
      font-size: 1rem;
    }
    .lede {
      margin: var(--space-1) 0 var(--space-3);
      color: var(--muted);
      font-size: 0.875rem;
      max-width: 62ch;
    }
    ol {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: grid;
      grid-template-columns: minmax(180px, 230px) 110px 80px minmax(0, 1fr);
      gap: var(--space-2) var(--space-3);
      padding: var(--space-3) 0;
      border-top: 1px solid var(--border);
    }
    li:last-child {
      border-bottom: 1px solid var(--border);
    }
    .wide {
      grid-column: 1 / -1;
    }
    .row-end {
      grid-column: 1 / -1;
      display: flex;
      justify-content: flex-end;
    }
    /* Controls copy the page's shared \`.input\` and \`.btn\` (styles/components.css) and the profile
       form's own rules (styles/layout.css): a shadow root cannot see those classes, so the values
       are repeated here rather than the section looking like a different form. */
    label {
      display: grid;
      gap: 6px;
      font-size: var(--control-ui-text-sm);
      font-weight: 500;
      letter-spacing: var(--tracking-tight);
      color: var(--text);
      min-width: 0;
    }
    input,
    select,
    textarea {
      font: inherit;
      font-size: var(--control-ui-text-md);
      font-weight: 400;
      letter-spacing: normal;
      line-height: 1.45;
      color: var(--text);
      min-height: var(--control-h-md);
      padding: 6px 10px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      background: transparent;
      min-width: 0;
      box-sizing: border-box;
      transition:
        background var(--duration-fast) var(--ease-out),
        border-color var(--duration-fast) var(--ease-out);
    }
    ::placeholder {
      color: var(--placeholder);
    }
    /* An empty box looks empty, like the basics form above. */
    input:placeholder-shown,
    textarea:placeholder-shown {
      background: var(--bg-muted);
    }
    input:hover:not(:focus),
    select:hover:not(:focus),
    textarea:hover:not(:focus) {
      border-color: var(--border-hover);
    }
    input:focus,
    select:focus,
    textarea:focus {
      outline: none;
      border-color: var(--accent);
      background: var(--bg-accent);
      box-shadow: 0 0 0 3px var(--focus);
    }
    textarea {
      min-height: 68px;
      resize: vertical;
    }
    .actions {
      display: flex;
      gap: var(--space-3);
      align-items: center;
      flex-wrap: wrap;
      margin-top: var(--space-3);
    }
    button {
      font: inherit;
      font-size: var(--control-ui-text-sm);
      font-weight: 500;
      letter-spacing: var(--tracking-tight);
      min-height: var(--control-h-md);
      padding: 0 14px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      background: transparent;
      color: var(--text);
      cursor: pointer;
      transition:
        background var(--duration-fast) var(--ease-out),
        border-color var(--duration-fast) var(--ease-out);
    }
    button:hover:not(:disabled) {
      background: var(--bg-hover);
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--primary-foreground);
    }
    button.primary:hover:not(:disabled) {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
    }
    button:disabled {
      opacity: 0.55;
      cursor: default;
    }
    button.link,
    button.link:hover {
      border: 0;
      padding: 0;
      min-height: 0;
      background: none;
      color: var(--muted);
      text-decoration: underline;
    }
    button.link:hover {
      color: var(--danger);
    }
    .empty {
      color: var(--muted);
      font-size: 0.875rem;
    }
    [role="alert"] {
      color: var(--danger);
      font-size: 0.875rem;
    }
    /* Mobile Safari zooms in on focused text under 16px. */
    @media (max-width: 768px) {
      input,
      select,
      textarea {
        font-size: var(--control-ui-input-text-size);
      }
    }
    @media (max-width: 640px) {
      li {
        grid-template-columns: 1fr 1fr;
      }
      li > label:first-child,
      li > label.description {
        grid-column: 1 / -1;
      }
    }
  `;

  /** The stored list, from the member's own record. */
  @property({ attribute: false }) entries: unknown = undefined;
  /** Writes the whole list; [] clears it. Resolves false when the service refused the save. */
  @property({ attribute: false }) onSave?: (
    entries: MemberFinancialSupportNeed[],
  ) => Promise<boolean> | boolean;

  @state() private drafts: FinancialNeedDraft[] = [];
  // The drafts as last loaded or saved. Save shows only while the rows differ from it, so adding a
  // row and removing it again leaves nothing to save.
  @state() private baseline = "[]";
  @state() private saving = false;
  @state() private error = "";

  protected override willUpdate(changed: Map<string, unknown>) {
    // A fresh record (first load, or the answer to our own save) replaces the drafts, unless the
    // member is in the middle of editing: their unsaved typing wins over a background refresh.
    if (changed.has("entries") && !this.dirty) {
      this.drafts = toDrafts(this.entries);
      this.baseline = JSON.stringify(this.drafts);
    }
  }

  private get dirty() {
    return JSON.stringify(this.drafts) !== this.baseline;
  }

  private edit(index: number, patch: Partial<FinancialNeedDraft>) {
    this.drafts = this.drafts.map((row, i) => (i === index ? { ...row, ...patch } : row));
    this.error = "";
  }

  private add() {
    if (this.drafts.length >= MAX_ROWS) {
      this.error = `Up to ${MAX_ROWS} expenses. Combine smaller ones into one line.`;
      return;
    }
    this.drafts = [...this.drafts, blankDraft()];
  }

  private removeRow(index: number) {
    this.drafts = this.drafts.filter((_, i) => i !== index);
    this.error = "";
  }

  private async save() {
    const result = fromDrafts(this.drafts);
    if (!result.ok) {
      this.error = result.error;
      return;
    }
    this.saving = true;
    this.error = "";
    try {
      const ok = (await this.onSave?.(result.entries)) ?? false;
      if (!ok) {
        // The reason is in the page notice; the rows stay so nothing typed is lost.
        this.error = "Not saved. See the message at the top of the page.";
        return;
      }
      this.drafts = toDrafts(result.entries);
      this.baseline = JSON.stringify(this.drafts);
    } catch {
      this.error = "Not saved. Check your connection and try again.";
    } finally {
      this.saving = false;
    }
  }

  private renderRow(row: FinancialNeedDraft, index: number) {
    const value = (event: Event) =>
      (event.currentTarget as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
    return html`<li data-testid="financial-need-row">
      <label
        >Category
        <select
          name="category"
          .value=${row.category}
          @change=${(event: Event) => this.edit(index, { category: value(event) as Category })}
        >
          ${(Object.keys(FINANCIAL_SUPPORT_CATEGORY_LABELS) as Category[]).map(
            (key) =>
              html`<option value=${key} ?selected=${key === row.category}>
                ${FINANCIAL_SUPPORT_CATEGORY_LABELS[key]}
              </option>`,
          )}
        </select>
      </label>
      <label
        >Rough amount
        <input
          name="amount"
          type="number"
          min="0"
          step="any"
          inputmode="decimal"
          placeholder="e.g. 240"
          .value=${row.amount}
          @input=${(event: Event) => this.edit(index, { amount: value(event) })}
        />
      </label>
      <label
        >Currency
        <input
          name="currency"
          maxlength="3"
          placeholder="e.g. CAD"
          autocomplete="off"
          .value=${row.currency}
          @input=${(event: Event) => this.edit(index, { currency: value(event) })}
        />
      </label>
      <label class="description"
        >What it is
        <input
          name="description"
          maxlength=${MAX_TEXT}
          placeholder="Claude Max for agent experiments, Sep–Nov"
          .value=${row.description}
          @input=${(event: Event) => this.edit(index, { description: value(event) })}
        />
      </label>
      <label class="wide"
        >What the PI said when allowing it
        <textarea
          name="pi_permission"
          rows="2"
          maxlength=${MAX_TEXT}
          placeholder="Paste or paraphrase the message, e.g. “Yes, go ahead and expense it” (Slack, 3 Oct)"
          .value=${row.pi_permission}
          @input=${(event: Event) => this.edit(index, { pi_permission: value(event) })}
        ></textarea>
      </label>
      <div class="row-end">
        <button type="button" class="link" @click=${() => this.removeRow(index)}>Remove</button>
      </div>
    </li>`;
  }

  override render() {
    return html`<section data-testid="financial-needs">
      <h3>Subscription or financial support needs</h3>
      <p class="lede">
        Costs you have paid and not been reimbursed for yet, but plan to claim: AI agent or
        subscription bills, travel, anything else. Rough numbers are fine. This helps the lab
        estimate its budget; it does not file a claim. Only you and the lab admins can see it.
      </p>
      ${this.drafts.length
        ? html`<ol>
            ${this.drafts.map((row, index) => this.renderRow(row, index))}
          </ol>`
        : html`<p class="empty">Nothing registered.</p>`}
      <div class="actions">
        <button type="button" @click=${() => this.add()}>Add an expense</button>
        ${this.dirty || this.saving
          ? html`<button
              type="button"
              class="primary"
              ?disabled=${this.saving}
              @click=${() => void this.save()}
            >
              ${this.saving ? "Saving…" : "Save"}
            </button>`
          : nothing}
        ${this.error ? html`<span role="alert">${this.error}</span>` : nothing}
      </div>
    </section>`;
  }
}

if (!customElements.get("adminbot-financial-needs")) {
  customElements.define("adminbot-financial-needs", FinancialNeedsSection);
}

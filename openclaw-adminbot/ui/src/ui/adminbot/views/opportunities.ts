// Control UI view renders the AdminBot Opportunities board: PhD programs, internships, grants and
// awards, and Rising Stars workshops, split across sub-tabs. Self-contained -- reads the bundled
// OPPORTUNITIES snapshot and merges any user-added entries from localStorage (see app-settings.ts).
//
// Undated entries are first-class here rather than filtered out: an annual program whose next
// cycle has not been announced is still the thing a member wants to know exists. They render as
// "Deadline TBA" and sort last, never as an expired or invented date.
import { html, nothing, LitElement } from "lit";
import {
  OPPORTUNITY_CATEGORIES,
  OPPORTUNITY_CATEGORY_LABELS,
  allOpportunities,
  saveCustomOpportunity,
  deleteCustomOpportunity,
  isCustomOpportunity,
  type Opportunity,
  type OpportunityCategory,
} from "../data/opportunities-data.ts";

const MS_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Filter = OpportunityCategory | "all";

// AoE (UTC-12): a wall-clock deadline maps to its UTC instant + 12h. Same convention as the
// deadlines board, so a date means the same thing on both tabs.
function aoeInstantMs(aoe: string): number {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(aoe);
  if (!m) {
    return Number.NaN;
  }
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) + 12 * 3600 * 1000;
}

function aoeDateLabel(aoe: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})/u.exec(aoe);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : "";
}

// "in 12 days" / "in 1 day" / "today". Deliberately coarser than the deadlines board's live
// countdown: this is a browsing surface, not a submission-day clock.
function relativeLabel(instant: number, now: number): string {
  const days = Math.floor((instant - now) / MS_DAY);
  if (days < 0) {
    return "closed";
  }
  if (days === 0) {
    return "today";
  }
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

function urgencyColor(instant: number, now: number): string {
  if (!Number.isFinite(instant)) {
    return "#66799a";
  }
  const days = Math.floor((instant - now) / MS_DAY);
  if (days < 0) {
    return "#66799a";
  }
  if (days <= 7) {
    return "#f2606a";
  }
  if (days <= 30) {
    return "#eab54a";
  }
  return "#34d3a6";
}

type Row = { item: Opportunity; instant: number };

// Dated entries ascending, then undated. NaN never participates in the numeric compare, so the
// ordering stays total regardless of how many entries are undated.
function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const aDated = Number.isFinite(a.instant);
    const bDated = Number.isFinite(b.instant);
    if (aDated && bDated) {
      return a.instant - b.instant;
    }
    if (aDated !== bDated) {
      return aDated ? -1 : 1;
    }
    return a.item.name.localeCompare(b.item.name);
  });
}

export function opportunityRows(filter: Filter, items?: Opportunity[]): Row[] {
  const all = items ?? allOpportunities();
  const scoped = filter === "all" ? all : all.filter((item) => item.category === filter);
  return sortRows(scoped.map((item) => ({ item, instant: aoeInstantMs(item.deadline_aoe) })));
}

export function categoryCount(category: Filter, items?: Opportunity[]): number {
  const all = items ?? allOpportunities();
  return category === "all"
    ? all.length
    : all.filter((item) => item.category === category).length;
}

const EMPTY_FORM: () => Opportunity = () => ({
  id: "",
  name: "",
  category: "rising_stars",
  org: "",
  deadline_aoe: "",
  link: "",
  eligibility: "",
  note: "",
  application_window: "",
});

// Custom element so the sub-tab selection lives with the view rather than in app state -- nothing
// outside this tab needs to know which category is showing. The filter is a plain field driven by
// an explicit requestUpdate(), not a Lit reactive property: a declared property plus a class field
// would shadow the generated accessor and silently break reactivity.
class AdminbotOpportunitiesView extends LitElement {
  private filter: Filter = "all";
  private formOpen = false;
  private form = EMPTY_FORM();
  private deadlineTba = false;
  private pendingDeleteId: string | null = null;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  private select(next: Filter): void {
    this.filter = next;
    this.requestUpdate();
  }

  private openForm(): void {
    this.form = EMPTY_FORM();
    this.deadlineTba = false;
    this.formOpen = true;
    this.requestUpdate();
  }

  private closeForm(): void {
    this.formOpen = false;
    this.requestUpdate();
  }

  private updateField<K extends keyof Opportunity>(key: K, value: Opportunity[K]): void {
    (this.form as Record<string, unknown>)[key] = value;
    this.requestUpdate();
  }

  private toggleDeadlineTba(): void {
    this.deadlineTba = !this.deadlineTba;
    if (this.deadlineTba) {
      this.form.deadline_aoe = "";
    }
    this.requestUpdate();
  }

  private submitForm(): void {
    const name = this.form.name.trim();
    if (!name) {
      return;
    }
    const opp: Opportunity = {
      ...this.form,
      id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      org: this.form.org?.trim() || undefined,
      deadline_aoe: this.form.deadline_aoe?.trim() || "",
      link: this.form.link?.trim() || undefined,
      eligibility: this.form.eligibility?.trim() || undefined,
      note: this.form.note?.trim() || undefined,
      application_window: this.form.application_window?.trim() || undefined,
    };
    saveCustomOpportunity(opp);
    this.formOpen = false;
    this.requestUpdate();
  }

  private deleteOpp(id: string): void {
    this.pendingDeleteId = id;
    this.requestUpdate();
  }

  private confirmDelete(): void {
    if (this.pendingDeleteId) {
      deleteCustomOpportunity(this.pendingDeleteId);
      this.pendingDeleteId = null;
      this.requestUpdate();
    }
  }

  private cancelDelete(): void {
    this.pendingDeleteId = null;
    this.requestUpdate();
  }

  private renderForm() {
    if (!this.formOpen) {
      return nothing;
    }
    return html`
      <div class="opp-form-backdrop" @click=${() => this.closeForm()}>
        <form
          class="opp-form"
          @click=${(e: Event) => e.stopPropagation()}
          @submit=${(e: SubmitEvent) => {
            e.preventDefault();
            this.submitForm();
          }}
        >
          <h3 class="opp-form-title">Add Opportunity</h3>

          <label class="opp-form-field">
            <span class="opp-form-label">Name *</span>
            <input
              class="opp-form-input"
              type="text"
              required
              placeholder="Research Internship"
              .value=${this.form.name}
              @input=${(e: Event) => this.updateField("name", (e.target as HTMLInputElement).value)}
            />
          </label>

          <label class="opp-form-field">
            <span class="opp-form-label">Category</span>
            <select
              class="opp-form-input"
              .value=${this.form.category}
              @change=${(e: Event) =>
                this.updateField("category", (e.target as HTMLSelectElement).value as OpportunityCategory)}
            >
              ${OPPORTUNITY_CATEGORIES.map(
                (cat) => html`<option value=${cat} ?selected=${cat === this.form.category}>
                  ${OPPORTUNITY_CATEGORY_LABELS[cat]}
                </option>`,
              )}
            </select>
          </label>

          <label class="opp-form-field">
            <span class="opp-form-label">Host / Organiser</span>
            <input
              class="opp-form-input"
              type="text"
              placeholder="e.g. MIT, Google"
              .value=${this.form.org ?? ""}
              @input=${(e: Event) => this.updateField("org", (e.target as HTMLInputElement).value)}
            />
          </label>

          <label class="opp-form-field">
            <span class="opp-form-label">Description</span>
            <textarea
              class="opp-form-input opp-form-textarea"
              rows="2"
              placeholder="Who is this for, what does it offer?"
              .value=${this.form.eligibility ?? ""}
              @input=${(e: Event) =>
                this.updateField("eligibility", (e.target as HTMLTextAreaElement).value)}
            ></textarea>
          </label>

          <label class="opp-form-field">
            <span class="opp-form-label">Application window</span>
            <input
              class="opp-form-input"
              type="text"
              placeholder="e.g. Sep 1 – Oct 15, 2026"
              .value=${this.form.application_window ?? ""}
              @input=${(e: Event) =>
                this.updateField("application_window", (e.target as HTMLInputElement).value)}
            />
          </label>

          <div class="opp-form-field">
            <span class="opp-form-label">Deadline (AoE)</span>
            <div class="opp-deadline-row">
              ${this.deadlineTba
                ? html`<span class="opp-tba-badge">TBA</span>`
                : html`
                    <input
                      class="opp-form-input opp-form-input--grow"
                      type="datetime-local"
                      .value=${this.form.deadline_aoe?.slice(0, 16) ?? ""}
                      @input=${(e: Event) => {
                        const v = (e.target as HTMLInputElement).value;
                        this.updateField("deadline_aoe", v ? `${v.replace("T", " ")}:00` : "");
                      }}
                    />
                  `}
              <button
                type="button"
                class=${`opp-tba-toggle ${this.deadlineTba ? "opp-tba-toggle--active" : ""}`}
                @click=${() => this.toggleDeadlineTba()}
                title=${this.deadlineTba ? "Set a date" : "Mark as TBA"}
              >
                TBA
              </button>
            </div>
          </div>

          <label class="opp-form-field">
            <span class="opp-form-label">Link</span>
            <input
              class="opp-form-input"
              type="url"
              placeholder="https://..."
              .value=${this.form.link ?? ""}
              @input=${(e: Event) => this.updateField("link", (e.target as HTMLInputElement).value)}
            />
          </label>

          <div class="opp-form-actions">
            <button type="button" class="opp-form-btn" @click=${() => this.closeForm()}>
              Cancel
            </button>
            <button type="submit" class="opp-form-btn opp-form-btn--primary">
              Add
            </button>
          </div>
        </form>
      </div>
    `;
  }

  private renderDeleteConfirm() {
    if (!this.pendingDeleteId) {
      return nothing;
    }
    return html`
      <div class="opp-confirm-backdrop" @click=${() => this.cancelDelete()}>
        <div class="opp-confirm" @click=${(e: Event) => e.stopPropagation()}>
          <p class="opp-confirm-text">Remove this opportunity?</p>
          <div class="opp-confirm-actions">
            <button class="opp-form-btn" @click=${() => this.cancelDelete()}>Cancel</button>
            <button class="opp-form-btn opp-form-btn--danger" @click=${() => this.confirmDelete()}>Delete</button>
          </div>
        </div>
      </div>
    `;
  }

  private renderTabs() {
    const tabs: Filter[] = ["all", ...OPPORTUNITY_CATEGORIES];
    return html`
      <div class="opp-tabs" role="tablist">
        ${tabs.map((tab) => {
          const count = categoryCount(tab);
          const label = tab === "all" ? "All" : OPPORTUNITY_CATEGORY_LABELS[tab];
          const selected = this.filter === tab;
          return html`
            <button
              class=${`opp-tab ${selected ? "is-active" : ""}`}
              role="tab"
              aria-selected=${selected ? "true" : "false"}
              @click=${() => this.select(tab)}
            >
              ${label}
              <span class="opp-tab-count">${count}</span>
            </button>
          `;
        })}
      </div>
    `;
  }

  private renderRow({ item, instant }: Row, now: number) {
    const dated = Number.isFinite(instant);
    const custom = isCustomOpportunity(item.id);
    return html`
      <div class="opp-row" style=${`--u:${urgencyColor(instant, now)}`}>
        <div class="opp-when">
          <span class="opp-date">
            ${dated ? `${aoeDateLabel(item.deadline_aoe)} AoE` : "Deadline TBA"}
          </span>
          ${dated ? html`<span class="opp-rel">${relativeLabel(instant, now)}</span>` : nothing}
          ${item.application_window
            ? html`<span class="opp-window">${item.application_window}</span>`
            : nothing}
        </div>
        <div class="opp-body">
          <div class="opp-name">
            ${item.name}
            ${item.link
              ? html`<a href=${item.link} target="_blank" rel="noopener" title="Open program page"
                  >↗</a
                >`
              : nothing}
            ${custom ? html`<span class="opp-member-tag">member-contributed</span>` : nothing}
          </div>
          ${item.org ? html`<div class="opp-org">${item.org}</div>` : nothing}
          ${item.eligibility ? html`<div class="opp-elig">${item.eligibility}</div>` : nothing}
          ${item.note ? html`<div class="opp-note">${item.note}</div>` : nothing}
        </div>
          ${custom
            ? html`<button
                class="opp-delete"
                @click=${() => this.deleteOpp(item.id)}
              >&times;</button>`
            : nothing}
      </div>
    `;
  }

  override render() {
    const now = Date.now();
    const rows = opportunityRows(this.filter);
    return html`
      <style>
        .opportunities-view {
          padding: 4px 2px 24px;
        }
        .opportunities-view .intro {
          color: var(--text-muted, #9fb0cc);
          font-size: 13.5px;
          margin: 0 0 14px;
        }
        .opp-tabs {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-bottom: 14px;
        }
        .opp-tab {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          border: 1px solid var(--border, #26324a);
          border-radius: 999px;
          background: var(--surface, #141b2b);
          color: var(--text, #d7e2f4);
          font-size: 13px;
          cursor: pointer;
        }
        .opp-tab.is-active {
          border-color: var(--accent, #4f8cff);
          color: var(--accent, #4f8cff);
        }
        .opp-tab-count {
          color: var(--text-muted, #66799a);
          font-size: 11.5px;
          font-variant-numeric: tabular-nums;
        }
        .opp-tab.is-active .opp-tab-count {
          color: inherit;
        }
        .opp-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .opp-row {
          display: grid;
          grid-template-columns: 160px 1fr auto;
          gap: 12px;
          padding: 11px 14px;
          border: 1px solid var(--border, #26324a);
          border-left: 4px solid var(--u);
          border-radius: 10px;
          background: var(--surface, #141b2b);
          align-items: start;
        }
        .opp-when {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .opp-date {
          font-variant-numeric: tabular-nums;
          font-size: 13px;
        }
        .opp-rel {
          color: var(--u);
          font-size: 11.5px;
          font-weight: 600;
        }
        .opp-window {
          color: var(--text-muted, #9fb0cc);
          font-size: 11px;
          margin-top: 2px;
        }
        .opp-name {
          font-size: 13.5px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .opp-org {
          color: var(--text-muted, #9fb0cc);
          font-size: 12px;
          margin-top: 2px;
        }
        .opp-elig {
          color: var(--text-muted, #9fb0cc);
          font-size: 12px;
          margin-top: 4px;
        }
        .opp-note {
          color: var(--text-muted, #66799a);
          font-size: 11.5px;
          margin-top: 4px;
        }
        .opp-member-tag {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--accent, #4f8cff);
          background: rgba(79, 140, 255, 0.12);
          padding: 1px 6px;
          border-radius: 4px;
          flex-shrink: 0;
        }
        .opp-delete {
          background: none;
          border: 1px solid transparent;
          border-radius: 6px;
          color: #f87171;
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
          padding: 2px 6px;
          align-self: start;
          transition: color 0.12s, border-color 0.12s, background 0.12s;
        }
        .opp-delete:hover {
          color: #fff;
          background: #ef4444;
          border-color: #ef4444;
        }
        .opp-fab {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          border: 1px solid var(--border, #26324a);
          background: var(--surface, #141b2b);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 12px 0 0 auto;
          flex-shrink: 0;
          padding: 0;
          transition: background 0.12s, border-color 0.12s;
        }
        .opp-fab svg {
          width: 20px;
          height: 20px;
          stroke: var(--text, #d7e2f4);
          stroke-width: 2;
          fill: none;
          transition: stroke 0.12s;
        }
        .opp-fab:hover {
          background: rgba(79, 140, 255, 0.12);
          border-color: var(--accent, #4f8cff);
        }
        .opp-fab:hover svg {
          stroke: var(--accent, #4f8cff);
        }
        .opp-form-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.55);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 100;
        }
        .opp-confirm-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.55);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 100;
        }
        .opp-confirm {
          background: var(--surface, #141b2b);
          border: 1px solid var(--border, #26324a);
          border-radius: 12px;
          padding: 20px 24px;
          min-width: 260px;
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4);
        }
        .opp-confirm-text {
          margin: 0 0 16px;
          font-size: 14px;
          color: var(--text, #d7e2f4);
        }
        .opp-confirm-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }
        .opp-form {
          background: var(--surface, #141b2b);
          border: 1px solid var(--border, #26324a);
          border-radius: 12px;
          padding: 24px;
          width: min(420px, 90vw);
          max-height: 85vh;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 14px;
          box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
        }
        .opp-form-title {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
          color: var(--text, #d7e2f4);
        }
        .opp-form-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .opp-form-label {
          font-size: 12px;
          font-weight: 500;
          color: var(--text-muted, #9fb0cc);
        }
        .opp-form-input {
          padding: 8px 10px;
          border: 1px solid var(--border, #26324a);
          border-radius: 6px;
          background: #1e2a3a;
          color: var(--text, #d7e2f4);
          font-size: 13px;
          font-family: inherit;
          transition: border-color 0.12s;
        }
        .opp-form-input::placeholder {
          color: #5a6d84;
        }
        .opp-form-input:focus {
          outline: none;
          border-color: var(--accent, #4f8cff);
        }
        .opp-form-input--grow {
          flex: 1;
          min-width: 0;
        }
        .opp-form-textarea {
          resize: vertical;
          min-height: 48px;
        }
        .opp-form-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 4px;
        }
        .opp-form-btn {
          padding: 7px 16px;
          border: 1px solid var(--border, #26324a);
          border-radius: 6px;
          background: #1e2a3a;
          color: var(--text, #d7e2f4);
          font-size: 13px;
          cursor: pointer;
        }
        .opp-form-btn--primary {
          background: var(--accent, #4f8cff);
          border-color: var(--accent, #4f8cff);
          color: #fff;
        }
        .opp-form-btn--primary:hover {
          opacity: 0.9;
        }
        .opp-form-btn--danger {
          background: #ef4444;
          border-color: #ef4444;
          color: #fff;
        }
        .opp-form-btn--danger:hover {
          opacity: 0.9;
        }
        .opp-deadline-row {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .opp-tba-badge {
          padding: 8px 12px;
          border: 1px solid var(--border, #26324a);
          border-radius: 6px;
          background: #1e2a3a;
          color: var(--text-muted, #9fb0cc);
          font-size: 13px;
          font-style: italic;
        }
        .opp-tba-toggle {
          padding: 7px 12px;
          border: 1px solid var(--border, #26324a);
          border-radius: 6px;
          background: #1e2a3a;
          color: var(--text-muted, #9fb0cc);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .opp-tba-toggle--active {
          border-color: var(--accent, #4f8cff);
          color: var(--accent, #4f8cff);
          background: #e8f0fe;
        }
        .opp-tba-toggle:hover {
          border-color: var(--accent, #4f8cff);
        }
        @media (max-width: 640px) {
          .opp-row {
            grid-template-columns: 1fr;
          }
        }
      </style>
      <section class="opportunities-view">
        <p class="intro">
          Programs the lab wants you to know about. Eligibility is quoted from each program so you
          can judge your own fit &mdash; nothing here is filtered by who you are.
        </p>
        ${this.renderTabs()}
        <div class="opp-list">
          ${rows.length === 0
            ? html`<p class="intro">Nothing listed here yet.</p>`
            : rows.map((row) => this.renderRow(row, now))}
        </div>
        <button class="opp-fab" type="button" title="Add opportunity" @click=${() => this.openForm()}>
          <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        ${this.renderForm()}
        ${this.renderDeleteConfirm()}
      </section>
    `;
  }
}

if (!customElements.get("adminbot-opportunities-view")) {
  customElements.define("adminbot-opportunities-view", AdminbotOpportunitiesView);
}

export function renderOpportunities() {
  return html`<adminbot-opportunities-view></adminbot-opportunities-view>`;
}
